"""Fetch and parse skills from URLs, npx commands, GitHub shorthands, and raw text."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import httpx

# ── URL Resolution ──────────────────────────────────────────────


def _resolve_github_shorthand(repo: str, skill_name: str | None, ref: str = "main") -> list[str]:
    """owner/repo -> list of raw.githubusercontent.com URLs to try."""
    base = f"https://raw.githubusercontent.com/{repo}/{ref}"
    if skill_name:
        return [
            f"{base}/skills/{skill_name}/SKILL.md",
            f"{base}/{skill_name}/SKILL.md",
            f"{base}/skills/{skill_name}.md",
        ]
    return [f"{base}/SKILL.md"]


def resolve_input(raw: str) -> list[str]:
    """Parse user input and return candidate URLs to try, in priority order.

    Returns empty list if the input is raw markdown (not a URL/command).
    """
    text = raw.strip()

    # ── npx skills add <source> [--skill <name>] ───────────────
    npx = re.match(
        r"npx\s+skills?\s+add\s+(\S+)(?:\s+--skill\s+(\S+))?", text, re.IGNORECASE
    )
    if npx:
        source, skill_name = npx.group(1), npx.group(2)
        # Source may be owner/repo, full URL, etc. — recurse with just that part.
        urls = resolve_input(source)
        if skill_name and urls:
            # Refine: filter/augment with skill-specific paths
            gh = re.match(r"https://raw\.githubusercontent\.com/([^/]+/[^/]+)/([^/]+)", urls[0])
            if gh:
                return _resolve_github_shorthand(gh.group(1), skill_name, gh.group(2))
        if skill_name and not urls:
            # source is a shorthand like owner/repo
            gh_short = re.match(r"^([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)", source)
            if gh_short:
                return _resolve_github_shorthand(gh_short.group(1), skill_name)
        return urls

    # ── GitHub blob URL → raw ──────────────────────────────────
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/blob/([^/]+)/(.*)", text)
    if m:
        return [f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}"]

    # ── GitHub tree URL (branch + optional path) ───────────────
    m = re.match(r"https://github\.com/([^/]+/[^/]+)/tree/([^/]+)(?:/(.*?))?/?$", text)
    if m:
        repo, ref, path = m.group(1), m.group(2), m.group(3) or ""
        base = f"https://raw.githubusercontent.com/{repo}/{ref}"
        if path:
            return [f"{base}/{path}/SKILL.md", f"{base}/{path}"]
        return [f"{base}/SKILL.md"]

    # ── GitHub repo root ───────────────────────────────────────
    m = re.match(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$", text)
    if m:
        return _resolve_github_shorthand(m.group(1), None)

    # ── skills.sh URL ──────────────────────────────────────────
    m = re.match(r"https?://skills\.sh/(?:skills?/)?([^/]+/[^/]+?)(?:/([^/?#]+))?/?$", text)
    if m:
        repo, skill = m.group(1), m.group(2)
        if skill:
            return [
                f"https://raw.githubusercontent.com/{repo}/main/skills/{skill}/SKILL.md",
                f"https://raw.githubusercontent.com/{repo}/main/{skill}/SKILL.md",
            ]
        return _resolve_github_shorthand(repo, None)

    # ── raw.githubusercontent.com or any other direct URL ──────
    if re.match(r"https?://", text, re.IGNORECASE):
        return [text]

    # ── GitHub shorthand: owner/repo[@skill] ───────────────────
    m = re.match(r"^([a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+)(?:@(\S+))?$", text)
    if m:
        return _resolve_github_shorthand(m.group(1), m.group(2))

    # Not a URL — caller should treat as raw text
    return []


# ── Frontmatter Parsing ────────────────────────────────────────


@dataclass
class ParsedSkill:
    name: str = ""
    description: str = ""
    instructions: str = ""
    category: str = "general"
    icon: str | None = None
    author: str | None = None
    version: str | None = None
    allowed_tools: list[str] = field(default_factory=list)


def _parse_yaml_value(value: str) -> str:
    """Strip surrounding quotes from a YAML scalar."""
    v = value.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        return v[1:-1]
    return v


def parse_skill_markdown(content: str) -> ParsedSkill:
    """Parse a SKILL.md file (frontmatter + body) into structured fields."""
    result = ParsedSkill()

    # Match frontmatter
    fm_match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$", content)
    if fm_match:
        frontmatter_text = fm_match.group(1)
        result.instructions = fm_match.group(2).strip()

        # Simple YAML parsing (no nested objects except metadata)
        current_key = ""
        metadata: dict[str, str] = {}
        in_metadata = False

        for line in frontmatter_text.split("\n"):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue

            # Top-level key: value
            top_match = re.match(r"^([a-zA-Z_-]+)\s*:\s*(.*)", line)
            if top_match and not line.startswith((" ", "\t")):
                current_key = top_match.group(1).strip()
                value = top_match.group(2).strip()

                if current_key == "name" and value:
                    result.name = _parse_yaml_value(value)
                elif current_key == "description" and value:
                    result.description = _parse_yaml_value(value)
                elif current_key == "allowed-tools" and value:
                    result.allowed_tools = value.split()

                in_metadata = current_key == "metadata" and not value
                continue

            # Indented key under metadata
            if in_metadata:
                meta_match = re.match(r"^\s+([a-zA-Z_-]+)\s*:\s*(.*)", line)
                if meta_match:
                    mk, mv = meta_match.group(1).strip(), meta_match.group(2).strip()
                    metadata[mk] = _parse_yaml_value(mv)

        result.author = metadata.get("author")
        result.version = metadata.get("version")
    else:
        # No frontmatter — entire content is instructions
        result.instructions = content.strip()
        # Try to extract name from first heading
        heading = re.match(r"^#\s+(.+)", content.strip())
        if heading:
            result.name = heading.group(1).strip()

    return result


# ── Fetch ──────────────────────────────────────────────────────


async def fetch_and_parse(raw_input: str) -> ParsedSkill | None:
    """Resolve input, fetch the skill content, and parse it.

    Returns None if the input is raw text (not a URL/command) — the caller
    should handle that case directly.
    """
    urls = resolve_input(raw_input)
    if not urls:
        return None  # Raw text — caller handles

    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        for url in urls:
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    content = resp.text
                    # Skip if it looks like HTML (not raw markdown)
                    if content.strip().startswith("<!") or "<html" in content[:500].lower():
                        continue
                    parsed = parse_skill_markdown(content)
                    parsed.name = parsed.name or _name_from_url(url)
                    return parsed
            except httpx.HTTPError:
                continue

    return None


def _name_from_url(url: str) -> str:
    """Derive a fallback name from a URL path."""
    # .../skills/find-skills/SKILL.md → find-skills
    m = re.search(r"/skills?/([^/]+?)(?:/SKILL\.md)?$", url, re.IGNORECASE)
    if m:
        return m.group(1).replace("-", " ").title()
    # .../something.md → something
    m = re.search(r"/([^/]+?)\.md$", url, re.IGNORECASE)
    if m:
        return m.group(1).replace("-", " ").title()
    return ""
