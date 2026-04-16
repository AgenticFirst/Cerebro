"""FastAPI router for sandbox configuration.

Stores state as flat ``sandbox:*`` rows in the ``settings`` table. The effective
config is assembled on each read; the main process watches ``PATCH`` responses
and regenerates the Seatbelt profile before the next ``claude`` subprocess
spawn.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from database import get_db
import models
from models import Setting

from .schemas import (
    LinkedProject,
    LinkedProjectCreate,
    LinkedProjectPatch,
    SandboxConfig,
    SandboxConfigPatch,
)
from .validation import HOME_FORBIDDEN_SUBPATHS, cerebro_data_dir, validate_link_path

router = APIRouter(tags=["sandbox"])

# Settings-table keys. Keep ≤ 100 chars to match the column width.
KEY_ENABLED = "sandbox:enabled"
KEY_WORKSPACE = "sandbox:workspace_path"
KEY_LINKS = "sandbox:linked_projects"
KEY_BANNER = "sandbox:banner_dismissed"


# ── Helpers ───────────────────────────────────────────────────────


def _get_str(db, key: str, default: str) -> str:
    row = db.get(Setting, key)
    return row.value if row else default


def _set_str(db, key: str, value: str) -> None:
    row = db.get(Setting, key)
    if row:
        row.value = value
        row.updated_at = models._utcnow()
    else:
        db.add(Setting(key=key, value=value))


def _get_bool(db, key: str, default: bool) -> bool:
    row = db.get(Setting, key)
    if not row:
        return default
    return row.value == "true"


def _set_bool(db, key: str, value: bool) -> None:
    _set_str(db, key, "true" if value else "false")


def _get_links(db) -> list[LinkedProject]:
    row = db.get(Setting, KEY_LINKS)
    if not row:
        return []
    try:
        raw = json.loads(row.value)
    except json.JSONDecodeError:
        return []
    items: list[LinkedProject] = []
    for entry in raw:
        try:
            items.append(LinkedProject(**entry))
        except Exception:
            continue
    return items


def _set_links(db, links: list[LinkedProject]) -> None:
    payload = json.dumps([link.model_dump() for link in links])
    _set_str(db, KEY_LINKS, payload)


def _default_workspace(request: Request) -> str:
    data_dir = cerebro_data_dir(request)
    if not data_dir:
        return os.path.expanduser("~/cerebro-sandbox")
    return os.path.join(data_dir, "sandbox", "workspace")


def _is_fresh_install(db) -> bool:
    """Used to decide the default sandbox:enabled value the first time a user
    hits the config endpoint. A conversation row implies prior use."""
    from models import Conversation

    return db.query(Conversation).first() is None


def _build_config(request: Request, db) -> SandboxConfig:
    enabled_row = db.get(Setting, KEY_ENABLED)
    if enabled_row is None:
        enabled = _is_fresh_install(db)
    else:
        enabled = enabled_row.value == "true"

    workspace = _get_str(db, KEY_WORKSPACE, _default_workspace(request))
    links = _get_links(db)
    banner_dismissed = _get_bool(db, KEY_BANNER, False)

    return SandboxConfig(
        enabled=enabled,
        workspace_path=workspace,
        linked_projects=links,
        banner_dismissed=banner_dismissed,
        platform_supported=sys.platform == "darwin",
        forbidden_home_subpaths=list(HOME_FORBIDDEN_SUBPATHS),
    )


# ── Endpoints ─────────────────────────────────────────────────────


@router.get("/config", response_model=SandboxConfig)
def get_config(request: Request, db=Depends(get_db)):
    return _build_config(request, db)


@router.patch("/config", response_model=SandboxConfig)
def patch_config(
    request: Request,
    body: SandboxConfigPatch,
    db=Depends(get_db),
):
    if body.enabled is not None:
        _set_bool(db, KEY_ENABLED, body.enabled)

    if body.workspace_path is not None:
        # Workspace is always under the Cerebro data dir. Refuse any attempt to
        # move it outside — if the user wants a different layout they can link
        # a project instead.
        data_dir = cerebro_data_dir(request)
        candidate = os.path.realpath(os.path.expanduser(body.workspace_path))
        if data_dir:
            data_canonical = os.path.realpath(data_dir)
            if not (candidate == data_canonical or candidate.startswith(data_canonical + os.sep)):
                raise HTTPException(
                    status_code=400,
                    detail="Workspace path must live inside Cerebro's data directory",
                )
        _set_str(db, KEY_WORKSPACE, candidate)

    if body.banner_dismissed is not None:
        _set_bool(db, KEY_BANNER, body.banner_dismissed)

    db.commit()
    return _build_config(request, db)


@router.post("/links", response_model=SandboxConfig, status_code=201)
def add_link(
    request: Request,
    body: LinkedProjectCreate,
    db=Depends(get_db),
):
    data_dir = cerebro_data_dir(request)
    result = validate_link_path(body.path, data_dir)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.reason or "Invalid path")

    links = _get_links(db)
    # Reject duplicates (same canonical path)
    if any(os.path.realpath(link.path) == result.canonical for link in links):
        raise HTTPException(status_code=409, detail="Project already linked")

    label = body.label or os.path.basename(result.canonical) or result.canonical
    new_link = LinkedProject(
        id=uuid.uuid4().hex[:12],
        path=result.canonical,
        mode=body.mode,
        label=label,
        added_at=datetime.now(timezone.utc).isoformat(),
    )
    links.append(new_link)
    _set_links(db, links)
    db.commit()
    return _build_config(request, db)


@router.patch("/links/{link_id}", response_model=SandboxConfig)
def patch_link(
    link_id: str,
    request: Request,
    body: LinkedProjectPatch,
    db=Depends(get_db),
):
    links = _get_links(db)
    found = False
    for link in links:
        if link.id == link_id:
            link.mode = body.mode
            found = True
            break
    if not found:
        raise HTTPException(status_code=404, detail="Link not found")
    _set_links(db, links)
    db.commit()
    return _build_config(request, db)


@router.delete("/links/{link_id}", response_model=SandboxConfig)
def delete_link(
    link_id: str,
    request: Request,
    db=Depends(get_db),
):
    links = _get_links(db)
    new_links = [link for link in links if link.id != link_id]
    if len(new_links) == len(links):
        raise HTTPException(status_code=404, detail="Link not found")
    _set_links(db, new_links)
    db.commit()
    return _build_config(request, db)
