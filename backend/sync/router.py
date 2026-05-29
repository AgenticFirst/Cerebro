"""Synchronous agent-file materializer.

Used by the ``rematerialize-experts`` skill so a freshly created expert is
immediately invocable inside the same Claude Code subprocess.

The canonical agent-file writer lives in TypeScript
(``src/claude-code/installer.ts``). This Python port is a narrow clone:
same agent-name algorithm (so the slug matches what the TS installer
would have written), same frontmatter shape, same target path under
``<data_dir>/.claude/agents/``. It's idempotent and safe to call
concurrently with the TS installer — they race on the same files but
produce identical output.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from database import get_db
from models import Expert, ExpertContextFile, FileItem, ParsedFile

router = APIRouter(tags=["sync"])


# Must stay in lock-step with src/claude-code/installer.ts so both renderers
# bake an identical "## Reference documents" section into the expert .md.
_MAX_CONTEXT_FILE_CHARS_PER_FILE = 40_000
_MAX_CONTEXT_FILE_TOTAL_CHARS = 120_000


# ── Agent-name algorithm (matches src/claude-code/installer.ts) ───


def _slugify(name: str) -> str:
    s = name.lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:48]


def _hash_suffix(expert_id: str) -> str:
    """Deterministic 6-char base36 hash, matching the TS hashSuffix."""
    h = 0
    for ch in expert_id:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    # Simulate TS `| 0` (signed 32-bit)
    if h & 0x80000000:
        h -= 0x100000000
    h = abs(h)
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if h == 0:
        return "000000"
    digits: list[str] = []
    while h:
        digits.append(alphabet[h % 36])
        h //= 36
    s = "".join(reversed(digits))
    return s[:6] if len(s) >= 6 else s.rjust(6, "0")


def _expert_agent_name(expert_id: str, name: str) -> str:
    base = _slugify(name) or "expert"
    return f"{base}-{_hash_suffix(expert_id)}"


# ── File rendering ───────────────────────────────────────────────


_EXPERT_TOOLS = [
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
]


def _escape_yaml(s: str) -> str:
    cleaned = re.sub(r"\r?\n", " ", s).strip()
    return '"' + cleaned.replace('"', '\\"') + '"'


def _render_agent_file(name: str, description: str, tools: list[str], body: str) -> str:
    frontmatter = (
        "---\n"
        f"name: {name}\n"
        f"description: {_escape_yaml(description)}\n"
        f"tools: {', '.join(tools)}\n"
        "---\n\n"
    )
    return frontmatter + body.rstrip() + "\n"


def _turn_protocol(memory_dir: str) -> str:
    return f"""## Turn Protocol

At the start of every conversation turn:
1. **Read your soul** — `Read` the file `SOUL.md` in your memory directory. It defines your persona, working style, and quality standards.
2. **Read your memory** — `Glob` for `*.md` in your memory directory and `Read` any files present.
3. **Do the work** — complete the user's request.
4. **Update memory** — if you learned something worth remembering, write or update a file in your memory directory.

## Memory

Your persistent memory lives at:

```
{memory_dir}
```

At the start of every turn, read any markdown files in that directory. When you learn something worth remembering, append a new `.md` file or update an existing one. Keep files small and topical. Never store secrets.
"""


def _render_expert_context_section(
    request: Request, db: Session, expert_id: str
) -> str:
    """Python mirror of renderExpertContextSection in installer.ts.

    Loads ExpertContextFile rows for ``expert_id`` in display order, reads
    each parsed-text sidecar (or falls back to a path hint when the parse
    isn't ready), and emits the same "## Reference documents" block the TS
    installer writes — so an expert's .md is identical whether it was last
    baked by the TS installer at boot or by this endpoint after an
    attach-expert-context call.
    """
    rows = (
        db.query(ExpertContextFile)
        .filter(ExpertContextFile.expert_id == expert_id)
        .order_by(ExpertContextFile.sort_order, ExpertContextFile.created_at)
        .all()
    )
    if not rows:
        return ""

    parsed_dir = getattr(request.app.state, "parsed_files_dir", None)
    blocks: list[str] = []
    total_chars = 0
    for row in rows:
        fi = db.get(FileItem, row.file_item_id)
        if fi is None or fi.deleted_at is not None:
            continue

        body = ""
        if fi.sha256 and parsed_dir:
            parsed = (
                db.query(ParsedFile)
                .filter(ParsedFile.sha256 == fi.sha256)
                .order_by(ParsedFile.created_at.desc())
                .first()
            )
            if parsed is not None:
                abs_path = os.path.join(parsed_dir, parsed.parsed_path)
                if os.path.exists(abs_path):
                    try:
                        with open(abs_path, encoding="utf-8") as fh:
                            body = fh.read()
                    except OSError:
                        body = ""

        if not body:
            # Image / text-passthrough / parse-not-ready: surface the file
            # path so the expert can Read it on its own. Matches the TS
            # fallback verbatim.
            body = (
                f"(File preserved at `{fi.storage_path}`. Use the Read tool only "
                "for text/image formats — never on binary office docs.)"
            )
        else:
            if len(body) > _MAX_CONTEXT_FILE_CHARS_PER_FILE:
                original_len = len(body)
                body = (
                    body[:_MAX_CONTEXT_FILE_CHARS_PER_FILE]
                    + f"\n\n[truncated — original was {original_len} chars; "
                    "raise expert.token_budget or split the file]"
                )
            if total_chars + len(body) > _MAX_CONTEXT_FILE_TOTAL_CHARS:
                blocks.append(
                    "\n\n[remaining reference files omitted — aggregate context cap of "
                    f"{_MAX_CONTEXT_FILE_TOTAL_CHARS} chars reached]"
                )
                break
            total_chars += len(body)

        kind_label = (
            " (TEMPLATE — always follow this format)" if row.kind == "template" else ""
        )
        blocks.append(f"### {fi.name}{kind_label}\n\n{body.strip()}")

    if not blocks:
        return ""

    return (
        "\n## Reference documents\n\n"
        "These files were attached by the user as permanent reference for every turn. "
        "Use them as authoritative context. When a file is marked TEMPLATE, your output "
        "MUST follow its structure (headings, sections, formatting) exactly.\n\n"
        + "\n\n".join(blocks)
        + "\n"
    )


def _build_expert_body(
    expert: Expert,
    memory_dir: str,
    request: Request,
    db: Session,
) -> str:
    domain_line = f" Domain: {expert.domain}." if expert.domain else ""
    body = (
        f"You are **{expert.name}**, a Cerebro specialist expert.{domain_line}\n\n"
        f"{_turn_protocol(memory_dir)}\n"
    )
    if expert.system_prompt:
        body += f"\n## Role\n\n{expert.system_prompt.strip()}\n"
    body += _render_expert_context_section(request, db, expert.id)
    return body


# ── Index file ───────────────────────────────────────────────────


def _read_index(index_path: str) -> dict:
    try:
        with open(index_path, encoding="utf-8") as fh:
            data = json.load(fh)
            if isinstance(data, dict) and isinstance(data.get("experts"), dict):
                return data
    except Exception:
        pass
    return {"experts": {}}


def _write_index(index_path: str, index: dict) -> None:
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    with open(index_path, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2)


# ── Endpoint ─────────────────────────────────────────────────────


@router.post("/agent-files")
def sync_agent_files(request: Request, db=Depends(get_db)):
    """Re-materialize agent files for all currently enabled experts.

    Idempotent. Writes ``<data_dir>/.claude/agents/<slug>.md`` for each
    enabled expert and updates the sidecar index. Does NOT clean up
    orphans — that's the TS installer's job on the next full sync.
    """
    db_path = getattr(request.app.state, "db_path", None)
    if not db_path:
        raise HTTPException(status_code=500, detail="db_path not configured")
    data_dir = os.path.dirname(db_path)

    claude_dir = os.path.join(data_dir, ".claude")
    agents_dir = os.path.join(claude_dir, "agents")
    memory_root = os.path.join(data_dir, "agent-memory")
    index_path = os.path.join(agents_dir, ".cerebro-index.json")

    os.makedirs(agents_dir, exist_ok=True)
    os.makedirs(memory_root, exist_ok=True)

    experts = db.query(Expert).filter(Expert.is_enabled == True).all()  # noqa: E712

    index = _read_index(index_path)
    written: list[str] = []

    for expert in experts:
        agent_name = _expert_agent_name(expert.id, expert.name)
        memory_dir = os.path.join(memory_root, agent_name)
        os.makedirs(memory_dir, exist_ok=True)

        body = _build_expert_body(expert, memory_dir, request, db)
        rendered = _render_agent_file(
            name=agent_name,
            description=expert.description or expert.name,
            tools=_EXPERT_TOOLS,
            body=body,
        )

        file_path = os.path.join(agents_dir, f"{agent_name}.md")
        with open(file_path, "w", encoding="utf-8") as fh:
            fh.write(rendered)

        index["experts"][expert.id] = agent_name
        written.append(agent_name)

    _write_index(index_path, index)

    return {"written": written, "count": len(written)}
