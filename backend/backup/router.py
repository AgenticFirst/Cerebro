"""HTTP surface for the backup/restore feature.

Endpoints:

* ``POST /backup/export`` — write a `.cerebro-backup` zip to a path chosen by
  the user via the Electron save dialog. The renderer hands us the absolute
  destination path; we use the SQLite online-backup API + a streaming zip
  walk so the export is safe with the live DB connection open.
* ``POST /backup/inspect`` — read the manifest from a zip without unpacking
  it. Returns stats + a compatibility flag the renderer uses to enable or
  disable the "Restore and restart" button.
* ``POST /backup/apply`` — snapshot current state into `.backup-rollback/`,
  extract the zip to `.backup-staging/`, and drop a pending marker. The
  Electron main process performs the actual file swaps on next boot, when
  no DB connection is yet open.
* ``POST /backup/undo`` — schedule an undo by restaging the named rollback.
* ``POST /backup/cancel-pending`` — discard a pending restore (used if the
  user changes their mind before the relaunch fires).
* ``GET /backup/last`` / ``POST /backup/last`` — read / update the
  "last backup at" record stored as a single row in the ``settings`` table
  so the section can render a "Last backup: 2h ago" line.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from database import get_db
from models import Setting, _utcnow

from .archive import estimate_backup_size, export_backup, revert_partial_export
from .restore import (
    apply_backup,
    cancel_pending,
    inspect_backup,
    list_rollbacks,
    stage_undo,
)

router = APIRouter(tags=["backup"])

LAST_BACKUP_KEY = "backup:last"


def _user_data_dir(request: Request) -> Path:
    """Derive userData from the live db_path. Electron always puts the DB
    at the root of userData, so this is the cheapest reliable source."""
    db_path = getattr(request.app.state, "db_path", None)
    if not db_path:
        raise HTTPException(status_code=500, detail="Backend missing db_path")
    return Path(db_path).parent


def _db_path(request: Request) -> Path:
    db_path = getattr(request.app.state, "db_path", None)
    if not db_path:
        raise HTTPException(status_code=500, detail="Backend missing db_path")
    return Path(db_path)


# ── Schemas ────────────────────────────────────────────────────────


class ExportRequest(BaseModel):
    dest_path: str
    include_models: bool = False
    app_version: str = ""


class ExportStatsResponse(BaseModel):
    conversations: int
    messages: int
    tasks: int
    experts: int
    routines: int
    files_bytes: int
    file_count: int


class ExportResponse(BaseModel):
    ok: bool
    path: str
    size_bytes: int
    stats: ExportStatsResponse


class InspectRequest(BaseModel):
    path: str
    app_version: str = ""


class InspectResponse(BaseModel):
    ok: bool
    compatible: bool
    manifest: dict[str, Any] = {}
    warnings: list[str] = []
    error: str | None = None


class ApplyRequest(BaseModel):
    path: str


class ApplyResponse(BaseModel):
    ok: bool
    rollback_id: str
    staging_dir: str
    error: str | None = None


class UndoRequest(BaseModel):
    rollback_id: str


class EstimateRequest(BaseModel):
    include_models: bool = False


class EstimateResponse(BaseModel):
    bytes: int


class LastBackupResponse(BaseModel):
    last_backup_at: str | None
    last_backup_path: str | None
    last_backup_size_bytes: int | None


# ── Endpoints ──────────────────────────────────────────────────────


@router.post("/export", response_model=ExportResponse)
def post_export(body: ExportRequest, request: Request, db=Depends(get_db)):
    dest_path = Path(os.path.expanduser(body.dest_path)).resolve()
    if dest_path.is_dir():
        raise HTTPException(status_code=400, detail="Destination must be a file path, not a directory")

    user_data_dir = _user_data_dir(request)
    db_path = _db_path(request)
    try:
        result = export_backup(
            user_data_dir=user_data_dir,
            db_path=db_path,
            dest_path=dest_path,
            app_version=body.app_version or "unknown",
            include_models=body.include_models,
        )
    except Exception as exc:
        revert_partial_export(dest_path)
        raise HTTPException(status_code=500, detail=f"Backup failed: {exc}") from exc

    # Record "last backup" in settings for the UI.
    now = _utcnow()
    payload = (
        f"{now.isoformat()}|{result.path}|{result.size_bytes}"
    )
    existing = db.get(Setting, LAST_BACKUP_KEY)
    if existing:
        existing.value = payload
        existing.updated_at = now
    else:
        db.add(Setting(key=LAST_BACKUP_KEY, value=payload))
    db.commit()

    return ExportResponse(
        ok=True,
        path=result.path,
        size_bytes=result.size_bytes,
        stats=ExportStatsResponse(
            conversations=result.stats.conversations,
            messages=result.stats.messages,
            tasks=result.stats.tasks,
            experts=result.stats.experts,
            routines=result.stats.routines,
            files_bytes=result.stats.files_bytes,
            file_count=result.stats.file_count,
        ),
    )


@router.post("/inspect", response_model=InspectResponse)
def post_inspect(body: InspectRequest):
    zip_path = Path(os.path.expanduser(body.path)).resolve()
    result = inspect_backup(zip_path, current_version=body.app_version or "")
    return InspectResponse(
        ok=result.ok,
        compatible=result.compatible,
        manifest=result.manifest,
        warnings=result.warnings,
        error=result.error,
    )


@router.post("/apply", response_model=ApplyResponse)
def post_apply(body: ApplyRequest, request: Request):
    zip_path = Path(os.path.expanduser(body.path)).resolve()
    user_data_dir = _user_data_dir(request)
    db_path = _db_path(request)
    result = apply_backup(zip_path, user_data_dir, db_path)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "Apply failed")
    return ApplyResponse(
        ok=True,
        rollback_id=result.rollback_id,
        staging_dir=result.staging_dir,
    )


@router.post("/undo", response_model=ApplyResponse)
def post_undo(body: UndoRequest, request: Request):
    user_data_dir = _user_data_dir(request)
    result = stage_undo(user_data_dir, body.rollback_id)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "Undo failed")
    return ApplyResponse(
        ok=True,
        rollback_id=result.rollback_id,
        staging_dir=result.staging_dir,
    )


@router.post("/cancel-pending")
def post_cancel_pending(request: Request):
    user_data_dir = _user_data_dir(request)
    cancelled = cancel_pending(user_data_dir)
    return {"ok": True, "cancelled": cancelled}


@router.post("/estimate", response_model=EstimateResponse)
def post_estimate(body: EstimateRequest, request: Request):
    user_data_dir = _user_data_dir(request)
    db_path = _db_path(request)
    total = estimate_backup_size(user_data_dir, db_path, include_models=body.include_models)
    return EstimateResponse(bytes=total)


@router.get("/last", response_model=LastBackupResponse)
def get_last(db=Depends(get_db)):
    setting = db.get(Setting, LAST_BACKUP_KEY)
    if not setting or "|" not in (setting.value or ""):
        return LastBackupResponse(
            last_backup_at=None, last_backup_path=None, last_backup_size_bytes=None
        )
    parts = setting.value.split("|", 2)
    at = parts[0] if parts else None
    path_ = parts[1] if len(parts) > 1 else None
    size = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None
    return LastBackupResponse(
        last_backup_at=at, last_backup_path=path_, last_backup_size_bytes=size
    )


@router.get("/rollbacks")
def get_rollbacks(request: Request):
    user_data_dir = _user_data_dir(request)
    return {"rollbacks": list_rollbacks(user_data_dir)}
