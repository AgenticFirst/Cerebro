"""FastAPI router for legacy memory — read-only.

Only kept so the one-shot migration can copy legacy memory data into the new
per-agent memory directories. Two legacy sources are exposed:

1. ``memory:context:*`` rows in the ``settings`` table (user-authored context).
2. Rows in the ``memory_items`` table (auto-extracted facts from the old
   extraction pipeline). The SQLAlchemy model for ``memory_items`` has been
   removed from the codebase, so this endpoint uses raw SQL against the
   legacy table if it still exists.

New writes should go through the ``agent_memory`` router.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from database import get_db
from models import Setting

from .schemas import ContextFileResponse, LegacyMemoryItem

router = APIRouter(tags=["memory"])

CONTEXT_PREFIX = "memory:context:"


@router.get("/context-files", response_model=list[ContextFileResponse])
def list_context_files(db=Depends(get_db)):
    settings = (
        db.query(Setting)
        .filter(Setting.key.startswith(CONTEXT_PREFIX))
        .order_by(Setting.key)
        .all()
    )
    return [
        ContextFileResponse(
            key=s.key[len(CONTEXT_PREFIX):],
            content=s.value,
            updated_at=s.updated_at,
        )
        for s in settings
    ]


@router.get("/context-files/{key:path}", response_model=ContextFileResponse)
def get_context_file(key: str, db=Depends(get_db)):
    full_key = CONTEXT_PREFIX + key
    setting = db.get(Setting, full_key)
    if not setting:
        raise HTTPException(status_code=404, detail="Context file not found")
    return ContextFileResponse(
        key=key,
        content=setting.value,
        updated_at=setting.updated_at,
    )


@router.get("/legacy-items", response_model=list[LegacyMemoryItem])
def list_legacy_items(db=Depends(get_db)):
    """Return all rows from the legacy ``memory_items`` table.

    The table may not exist on fresh installs — return an empty list in
    that case.
    """
    try:
        rows = db.execute(
            text(
                "SELECT scope, scope_id, content, created_at "
                "FROM memory_items "
                "ORDER BY created_at ASC"
            )
        ).fetchall()
    except OperationalError:
        # Table may not exist on fresh installs
        return []

    items: list[LegacyMemoryItem] = []
    for row in rows:
        scope, scope_id, content, created_at = row
        if not content or not content.strip():
            continue
        # SQLite returns created_at as an ISO string or a datetime depending on
        # the driver settings; normalize to datetime.
        if isinstance(created_at, str):
            try:
                parsed = datetime.fromisoformat(created_at)
            except ValueError:
                parsed = datetime.now(timezone.utc)
        else:
            parsed = created_at or datetime.now(timezone.utc)
        items.append(
            LegacyMemoryItem(
                scope=scope,
                scope_id=scope_id,
                content=content,
                created_at=parsed,
            )
        )
    return items
