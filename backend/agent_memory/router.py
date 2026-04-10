"""FastAPI router for per-agent memory directories.

Each Claude Code subagent owns a directory under
``<userData>/agent-memory/<name>/`` containing markdown files. This router
exposes a small file-browser API so the Settings > Memory UI can list,
read, write, and delete those files.

All paths are validated to stay inside the agent-memory root — no escape
sequences (``..``), no absolute paths.
"""

from __future__ import annotations

import stat as stat_module
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

router = APIRouter(tags=["agent-memory"])


# ── Schemas ──────────────────────────────────────────────────────


class AgentMemoryDir(BaseModel):
    slug: str
    file_count: int
    last_modified: datetime | None


class AgentMemoryDirsResponse(BaseModel):
    directories: list[AgentMemoryDir]


class AgentMemoryFile(BaseModel):
    path: str
    size: int
    last_modified: datetime


class AgentMemoryFilesResponse(BaseModel):
    files: list[AgentMemoryFile]


class AgentMemoryFileContent(BaseModel):
    path: str
    content: str
    last_modified: datetime


class AgentMemoryFileWrite(BaseModel):
    content: str


# ── Helpers ──────────────────────────────────────────────────────


def _root(request: Request) -> Path:
    root = getattr(request.app.state, "agent_memory_dir", None)
    if not root:
        raise HTTPException(status_code=500, detail="agent_memory_dir not configured")
    return Path(root)


def _safe_join(base: Path, *parts: str) -> Path:
    """Join path parts onto ``base``, refusing anything that escapes ``base``."""
    candidate = base.joinpath(*parts).resolve()
    base_resolved = base.resolve()
    try:
        candidate.relative_to(base_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid path")
    return candidate


def _slug_dir(root: Path, slug: str) -> Path:
    if not slug or "/" in slug or "\\" in slug or slug.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid slug")
    return _safe_join(root, slug)


def _mtime(p: Path) -> datetime:
    return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)


# ── Endpoints ────────────────────────────────────────────────────


@router.get("", response_model=AgentMemoryDirsResponse)
def list_directories(request: Request):
    root = _root(request)
    dirs: list[AgentMemoryDir] = []
    for child in sorted(root.iterdir()) if root.exists() else []:
        if not child.is_dir() or child.name.startswith("."):
            continue
        file_count = 0
        last_mod: datetime | None = None
        for f in child.rglob("*.md"):
            st = f.stat()
            if not stat_module.S_ISREG(st.st_mode):
                continue
            file_count += 1
            mt = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
            if last_mod is None or mt > last_mod:
                last_mod = mt
        dirs.append(
            AgentMemoryDir(
                slug=child.name,
                file_count=file_count,
                last_modified=last_mod,
            )
        )
    return AgentMemoryDirsResponse(directories=dirs)


@router.get("/{slug}/files", response_model=AgentMemoryFilesResponse)
def list_files(slug: str, request: Request):
    root = _root(request)
    dir_path = _slug_dir(root, slug)
    if not dir_path.exists():
        return AgentMemoryFilesResponse(files=[])
    files: list[AgentMemoryFile] = []
    for f in sorted(dir_path.rglob("*.md")):
        if not f.is_file():
            continue
        rel = f.relative_to(dir_path).as_posix()
        files.append(
            AgentMemoryFile(
                path=rel,
                size=f.stat().st_size,
                last_modified=_mtime(f),
            )
        )
    return AgentMemoryFilesResponse(files=files)


@router.get("/{slug}/files/{file_path:path}", response_model=AgentMemoryFileContent)
def read_file(slug: str, file_path: str, request: Request):
    root = _root(request)
    dir_path = _slug_dir(root, slug)
    target = _safe_join(dir_path, file_path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return AgentMemoryFileContent(
        path=file_path,
        content=target.read_text(encoding="utf-8"),
        last_modified=_mtime(target),
    )


@router.put("/{slug}/files/{file_path:path}", response_model=AgentMemoryFileContent)
def write_file(slug: str, file_path: str, body: AgentMemoryFileWrite, request: Request):
    root = _root(request)
    dir_path = _slug_dir(root, slug)
    target = _safe_join(dir_path, file_path)
    if not target.name.endswith(".md"):
        raise HTTPException(status_code=400, detail="Only .md files are allowed")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return AgentMemoryFileContent(
        path=file_path,
        content=body.content,
        last_modified=_mtime(target),
    )


@router.delete("/{slug}/files/{file_path:path}", status_code=204)
def delete_file(slug: str, file_path: str, request: Request):
    root = _root(request)
    dir_path = _slug_dir(root, slug)
    target = _safe_join(dir_path, file_path)
    if target.exists() and target.is_file():
        target.unlink()
    return Response(status_code=204)
