import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from models import Bucket, FileItem

from .schemas import (
    BucketCreate,
    BucketRead,
    BucketUpdate,
    FileItemCopyRequest,
    FileItemCreate,
    FileItemRead,
    FileItemUpdate,
)

router = APIRouter()

VALID_SOURCES = {"upload", "chat-save", "workspace-save", "manual"}
VALID_STORAGE_KINDS = {"managed", "workspace"}
VALID_ORDERS = {"created", "updated", "name", "opened"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _bucket_to_read(bucket: Bucket, file_count: int = 0) -> BucketRead:
    return BucketRead(
        id=bucket.id,
        name=bucket.name,
        color=bucket.color,
        icon=bucket.icon,
        is_default=bucket.is_default,
        is_pinned=bucket.is_pinned,
        sort_order=bucket.sort_order,
        file_count=file_count,
        created_at=bucket.created_at,
        updated_at=bucket.updated_at,
    )


# ── Buckets ──


@router.get("/buckets", response_model=list[BucketRead])
def list_buckets(db: Session = Depends(get_db)):
    buckets = (
        db.query(Bucket)
        .order_by(
            Bucket.is_default.desc(),
            Bucket.is_pinned.desc(),
            Bucket.sort_order,
            Bucket.created_at,
        )
        .all()
    )
    counts = dict(
        db.query(FileItem.bucket_id, func.count(FileItem.id))
        .filter(FileItem.deleted_at.is_(None))
        .group_by(FileItem.bucket_id)
        .all()
    )
    return [_bucket_to_read(b, counts.get(b.id, 0)) for b in buckets]


@router.post("/buckets", response_model=BucketRead, status_code=201)
def create_bucket(body: BucketCreate, db: Session = Depends(get_db)):
    bucket = Bucket(
        name=body.name.strip() or "Untitled",
        color=body.color,
        icon=body.icon,
        is_pinned=body.is_pinned,
    )
    db.add(bucket)
    db.commit()
    db.refresh(bucket)
    return _bucket_to_read(bucket, 0)


@router.patch("/buckets/{bucket_id}", response_model=BucketRead)
def update_bucket(bucket_id: str, body: BucketUpdate, db: Session = Depends(get_db)):
    bucket = db.get(Bucket, bucket_id)
    if not bucket:
        raise HTTPException(404, "Bucket not found")
    updates = body.model_dump(exclude_unset=True)
    if "name" in updates:
        cleaned = (updates["name"] or "").strip()
        if not cleaned:
            raise HTTPException(400, "Bucket name cannot be empty")
        updates["name"] = cleaned
    for key, val in updates.items():
        setattr(bucket, key, val)
    db.commit()
    db.refresh(bucket)
    file_count = (
        db.query(func.count(FileItem.id))
        .filter(FileItem.bucket_id == bucket.id, FileItem.deleted_at.is_(None))
        .scalar()
    ) or 0
    return _bucket_to_read(bucket, file_count)


class BucketFileContent(BaseModel):
    id: str
    name: str
    ext: str
    mime: str | None
    size_bytes: int
    abs_path: str


@router.get("/buckets/{bucket_id}/contents", response_model=list[BucketFileContent])
def list_bucket_contents(
    bucket_id: str,
    request: Request,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    """Return absolute paths for non-deleted files in a bucket.

    Used by the ``search_documents`` routine action so Claude Code can read
    the files directly via its ``Read`` tool. Workspace files keep their
    absolute ``storage_path``; managed files are resolved against the
    ``--files-dir`` root that was passed at startup.
    """
    bucket = db.get(Bucket, bucket_id)
    if not bucket:
        raise HTTPException(404, "Bucket not found")

    files_root = getattr(request.app.state, "files_dir", None)
    items = (
        db.query(FileItem)
        .filter(
            FileItem.bucket_id == bucket_id,
            FileItem.deleted_at.is_(None),
        )
        .order_by(FileItem.created_at.desc())
        .limit(limit)
        .all()
    )

    out: list[BucketFileContent] = []
    for it in items:
        if it.storage_kind == "managed":
            if not files_root:
                # Misconfigured backend — skip rather than leak a broken path.
                continue
            abs_path = os.path.abspath(os.path.join(files_root, it.storage_path))
            # Refuse anything that escapes the files root.
            if not (
                abs_path == files_root
                or abs_path.startswith(files_root + os.sep)
            ):
                continue
        else:
            # Workspace files are stored with an absolute path already.
            abs_path = it.storage_path
        out.append(
            BucketFileContent(
                id=it.id,
                name=it.name,
                ext=it.ext or "",
                mime=it.mime,
                size_bytes=it.size_bytes,
                abs_path=abs_path,
            )
        )
    return out


@router.delete("/buckets/{bucket_id}", status_code=204)
def delete_bucket(
    bucket_id: str,
    reassign_to: str | None = Query(None),
    db: Session = Depends(get_db),
):
    bucket = db.get(Bucket, bucket_id)
    if not bucket:
        raise HTTPException(404, "Bucket not found")
    if bucket.is_default:
        raise HTTPException(400, "Cannot delete the Default bucket")
    if reassign_to:
        target = db.get(Bucket, reassign_to)
        if not target:
            raise HTTPException(400, f"Reassign target {reassign_to} not found")
        db.query(FileItem).filter(FileItem.bucket_id == bucket_id).update(
            {FileItem.bucket_id: reassign_to}
        )
    # else: ON DELETE SET NULL drops items to "unfiled"
    db.delete(bucket)
    db.commit()
    return Response(status_code=204)


# ── File items ──


@router.get("/items", response_model=list[FileItemRead])
def list_items(
    bucket_id: str | None = Query(None),
    unfiled: bool = Query(False),
    source: str | None = Query(None),
    q: str | None = Query(None),
    starred: bool | None = Query(None),
    include_deleted: bool = Query(False),
    only_deleted: bool = Query(False),
    storage_kind: str | None = Query(None),
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    order: str = Query("created"),
    db: Session = Depends(get_db),
):
    if order not in VALID_ORDERS:
        raise HTTPException(400, f"Invalid order: {order}")

    query = db.query(FileItem)

    if only_deleted:
        query = query.filter(FileItem.deleted_at.is_not(None))
    elif not include_deleted:
        query = query.filter(FileItem.deleted_at.is_(None))

    if unfiled:
        query = query.filter(FileItem.bucket_id.is_(None))
    elif bucket_id is not None:
        query = query.filter(FileItem.bucket_id == bucket_id)
    if source is not None:
        query = query.filter(FileItem.source == source)
    if starred is not None:
        query = query.filter(FileItem.starred.is_(starred))
    if storage_kind is not None:
        query = query.filter(FileItem.storage_kind == storage_kind)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(FileItem.name.ilike(like))

    if order == "name":
        query = query.order_by(FileItem.name.asc())
    elif order == "updated":
        query = query.order_by(FileItem.updated_at.desc())
    elif order == "opened":
        query = query.order_by(FileItem.last_opened_at.desc().nullslast())
    else:  # created
        query = query.order_by(FileItem.created_at.desc())

    items = query.offset(offset).limit(limit).all()
    return [FileItemRead.model_validate(i) for i in items]


@router.get("/items/recent", response_model=list[FileItemRead])
def recent_items(
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    # "Recent" = recently opened OR recently created, whichever is newer.
    items = (
        db.query(FileItem)
        .filter(FileItem.deleted_at.is_(None))
        .order_by(
            func.coalesce(FileItem.last_opened_at, FileItem.created_at).desc()
        )
        .limit(limit)
        .all()
    )
    return [FileItemRead.model_validate(i) for i in items]


@router.post("/items", response_model=FileItemRead, status_code=201)
def create_item(body: FileItemCreate, db: Session = Depends(get_db)):
    if body.source not in VALID_SOURCES:
        raise HTTPException(400, f"Invalid source: {body.source}")
    if body.storage_kind not in VALID_STORAGE_KINDS:
        raise HTTPException(400, f"Invalid storage_kind: {body.storage_kind}")
    if body.bucket_id:
        if not db.get(Bucket, body.bucket_id):
            raise HTTPException(400, f"Bucket {body.bucket_id} not found")
    item = FileItem(
        bucket_id=body.bucket_id,
        name=body.name,
        ext=(body.ext or "").lower().lstrip("."),
        mime=body.mime,
        size_bytes=body.size_bytes,
        sha256=body.sha256,
        storage_kind=body.storage_kind,
        storage_path=body.storage_path,
        source=body.source,
        source_conversation_id=body.source_conversation_id,
        source_message_id=body.source_message_id,
        source_task_id=body.source_task_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return FileItemRead.model_validate(item)


@router.get("/items/{item_id}", response_model=FileItemRead)
def get_item(item_id: str, db: Session = Depends(get_db)):
    item = db.get(FileItem, item_id)
    if not item:
        raise HTTPException(404, "File not found")
    return FileItemRead.model_validate(item)


@router.patch("/items/{item_id}", response_model=FileItemRead)
def update_item(item_id: str, body: FileItemUpdate, db: Session = Depends(get_db)):
    item = db.get(FileItem, item_id)
    if not item:
        raise HTTPException(404, "File not found")
    updates = body.model_dump(exclude_unset=True)

    if "bucket_id" in updates and updates["bucket_id"]:
        if not db.get(Bucket, updates["bucket_id"]):
            raise HTTPException(400, f"Bucket {updates['bucket_id']} not found")

    if "name" in updates:
        cleaned = (updates["name"] or "").strip()
        if not cleaned:
            raise HTTPException(400, "File name cannot be empty")
        updates["name"] = cleaned

    if updates.pop("restore", False):
        item.deleted_at = None

    for key, val in updates.items():
        setattr(item, key, val)

    db.commit()
    db.refresh(item)
    return FileItemRead.model_validate(item)


@router.post("/items/{item_id}/copy", response_model=FileItemRead, status_code=201)
def copy_item(item_id: str, body: FileItemCopyRequest, db: Session = Depends(get_db)):
    """Register a metadata copy. Caller has already duplicated bytes via IPC."""
    src = db.get(FileItem, item_id)
    if not src:
        raise HTTPException(404, "Source file not found")
    if body.bucket_id:
        if not db.get(Bucket, body.bucket_id):
            raise HTTPException(400, f"Bucket {body.bucket_id} not found")
    copy = FileItem(
        bucket_id=body.bucket_id,
        name=src.name,
        ext=src.ext,
        mime=src.mime,
        size_bytes=src.size_bytes,
        sha256=src.sha256,
        storage_kind="managed",
        storage_path=body.new_storage_path,
        source=src.source,
        source_conversation_id=src.source_conversation_id,
        source_message_id=src.source_message_id,
        source_task_id=src.source_task_id,
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    return FileItemRead.model_validate(copy)


@router.delete("/items/{item_id}", status_code=204)
def delete_item(
    item_id: str,
    hard: bool = Query(False),
    db: Session = Depends(get_db),
):
    item = db.get(FileItem, item_id)
    if not item:
        raise HTTPException(404, "File not found")
    if hard:
        # Caller is responsible for unlinking bytes via FILES_DELETE_MANAGED IPC
        # if storage_kind == 'managed'.
        db.delete(item)
    else:
        item.deleted_at = _utcnow()
    db.commit()
    return Response(status_code=204)


@router.post("/items/{item_id}/touch", response_model=FileItemRead)
def touch_item(item_id: str, db: Session = Depends(get_db)):
    item = db.get(FileItem, item_id)
    if not item:
        raise HTTPException(404, "File not found")
    item.last_opened_at = _utcnow()
    db.commit()
    db.refresh(item)
    return FileItemRead.model_validate(item)


@router.post("/trash/empty", response_model=list[str])
def empty_trash(db: Session = Depends(get_db)):
    """Hard-delete all soft-deleted rows. Returns the storage paths of managed
    files so the caller (Electron main) can unlink their bytes."""
    paths = [
        row[0]
        for row in db.query(FileItem.storage_path)
        .filter(FileItem.deleted_at.is_not(None), FileItem.storage_kind == "managed")
        .all()
    ]
    db.query(FileItem).filter(FileItem.deleted_at.is_not(None)).delete(
        synchronize_session=False
    )
    db.commit()
    return paths


@router.get("/managed-paths", response_model=list[str])
def list_managed_paths(db: Session = Depends(get_db)):
    """Used by the orphan sweep at boot — every managed file's relative path."""
    rows = (
        db.query(FileItem.storage_path)
        .filter(FileItem.storage_kind == "managed")
        .all()
    )
    return [r[0] for r in rows]
