"""CRUD for /experts/{expert_id}/context-files.

Attach an existing FileItem as an expert reference document. The actual
parsed-text injection into the expert's `<slug>.md` system prompt happens
in the Electron-side installer; this router just persists the
expert ↔ file relationship and surfaces it for the UI.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from database import get_db
from models import Expert, ExpertContextFile, FileItem, ParsedFile

from .schemas import (
    VALID_KINDS,
    ContextFileAttach,
    ContextFilePatch,
    ContextFileRead,
)

router = APIRouter(tags=["expert-context"])


def _to_read(
    row: ExpertContextFile,
    file_item: FileItem,
    parsed_text_path: str | None = None,
) -> ContextFileRead:
    return ContextFileRead(
        id=row.id,
        expert_id=row.expert_id,
        file_item_id=row.file_item_id,
        kind=row.kind,
        sort_order=row.sort_order,
        char_count=row.char_count,
        truncated=row.truncated,
        created_at=row.created_at,
        file_name=file_item.name,
        file_ext=file_item.ext,
        file_mime=file_item.mime,
        file_size_bytes=file_item.size_bytes,
        file_storage_path=file_item.storage_path,
        parsed_text_path=parsed_text_path,
    )


def _resolve_parsed_path(
    request: Request, db: Session, file_item: FileItem
) -> str | None:
    """Look up the absolute parsed-text sidecar for this file, if any."""
    if not file_item.sha256:
        return None
    parsed = (
        db.query(ParsedFile)
        .filter(ParsedFile.sha256 == file_item.sha256)
        .order_by(ParsedFile.created_at.desc())
        .first()
    )
    if parsed is None:
        return None
    parsed_dir = getattr(request.app.state, "parsed_files_dir", None)
    if not parsed_dir:
        return None
    abs_path = os.path.join(parsed_dir, parsed.parsed_path)
    return abs_path if os.path.exists(abs_path) else None


def _refresh_char_count(
    request: Request, db: Session, file_item: FileItem
) -> tuple[int, bool]:
    """Look up the parsed-text sidecar (if any) and return its char count."""
    if not file_item.sha256:
        return 0, False
    parsed = (
        db.query(ParsedFile)
        .filter(ParsedFile.sha256 == file_item.sha256)
        .order_by(ParsedFile.created_at.desc())
        .first()
    )
    if parsed is None:
        return 0, False
    parsed_dir = getattr(request.app.state, "parsed_files_dir", None)
    if not parsed_dir:
        return parsed.char_count, parsed.warning == "truncated"
    abs_path = os.path.join(parsed_dir, parsed.parsed_path)
    if not os.path.exists(abs_path):
        return 0, False
    return parsed.char_count, parsed.warning == "truncated"


@router.get("/{expert_id}/context-files", response_model=list[ContextFileRead])
def list_context_files(
    expert_id: str, request: Request, db: Session = Depends(get_db)
):
    if not db.get(Expert, expert_id):
        raise HTTPException(404, "Expert not found")
    rows = (
        db.query(ExpertContextFile)
        .filter(ExpertContextFile.expert_id == expert_id)
        .order_by(ExpertContextFile.sort_order, ExpertContextFile.created_at)
        .all()
    )
    out: list[ContextFileRead] = []
    for row in rows:
        fi = db.get(FileItem, row.file_item_id)
        if fi is None or fi.deleted_at is not None:
            continue
        out.append(_to_read(row, fi, _resolve_parsed_path(request, db, fi)))
    return out


@router.post(
    "/{expert_id}/context-files",
    response_model=ContextFileRead,
    status_code=201,
)
def attach_context_file(
    expert_id: str,
    body: ContextFileAttach,
    request: Request,
    db: Session = Depends(get_db),
):
    if not db.get(Expert, expert_id):
        raise HTTPException(404, "Expert not found")
    if body.kind not in VALID_KINDS:
        raise HTTPException(400, f"Invalid kind: {body.kind}")
    fi = db.get(FileItem, body.file_item_id)
    if fi is None or fi.deleted_at is not None:
        raise HTTPException(404, f"FileItem {body.file_item_id} not found")

    # Default sort_order = (max + 1) so new files land at the bottom.
    sort_order = body.sort_order
    if sort_order is None:
        existing_max = (
            db.query(ExpertContextFile.sort_order)
            .filter(ExpertContextFile.expert_id == expert_id)
            .order_by(ExpertContextFile.sort_order.desc())
            .first()
        )
        sort_order = (existing_max[0] + 1.0) if existing_max else 0.0

    char_count, truncated = _refresh_char_count(request, db, fi)

    row = ExpertContextFile(
        expert_id=expert_id,
        file_item_id=body.file_item_id,
        kind=body.kind,
        sort_order=sort_order,
        char_count=char_count,
        truncated=truncated,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_read(row, fi, _resolve_parsed_path(request, db, fi))


@router.patch(
    "/{expert_id}/context-files/{ctx_id}", response_model=ContextFileRead
)
def update_context_file(
    expert_id: str,
    ctx_id: str,
    body: ContextFilePatch,
    request: Request,
    db: Session = Depends(get_db),
):
    row = db.get(ExpertContextFile, ctx_id)
    if row is None or row.expert_id != expert_id:
        raise HTTPException(404, "Context file not found")
    if body.kind is not None:
        if body.kind not in VALID_KINDS:
            raise HTTPException(400, f"Invalid kind: {body.kind}")
        row.kind = body.kind
    if body.sort_order is not None:
        row.sort_order = body.sort_order
    db.commit()
    db.refresh(row)
    fi = db.get(FileItem, row.file_item_id)
    if fi is None:
        raise HTTPException(404, "Backing FileItem disappeared")
    return _to_read(row, fi, _resolve_parsed_path(request, db, fi))


@router.delete(
    "/{expert_id}/context-files/{ctx_id}", status_code=204
)
def detach_context_file(
    expert_id: str,
    ctx_id: str,
    db: Session = Depends(get_db),
):
    row = db.get(ExpertContextFile, ctx_id)
    if row is None or row.expert_id != expert_id:
        raise HTTPException(404, "Context file not found")
    db.delete(row)
    db.commit()
    return Response(status_code=204)
