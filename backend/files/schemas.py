from datetime import datetime

from pydantic import BaseModel, Field


# ── Bucket schemas ──

class BucketCreate(BaseModel):
    name: str = Field(..., max_length=255)
    color: str | None = Field(None, max_length=16)
    icon: str | None = Field(None, max_length=32)
    is_pinned: bool = False


class BucketUpdate(BaseModel):
    name: str | None = Field(None, max_length=255)
    color: str | None = Field(None, max_length=16)
    icon: str | None = Field(None, max_length=32)
    is_pinned: bool | None = None
    sort_order: float | None = None


class BucketRead(BaseModel):
    id: str
    name: str
    color: str | None
    icon: str | None
    is_default: bool
    is_pinned: bool
    sort_order: float
    file_count: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# ── FileItem schemas ──

class FileItemCreate(BaseModel):
    bucket_id: str | None = None
    name: str = Field(..., max_length=512)
    ext: str = Field("", max_length=32)
    mime: str | None = Field(None, max_length=128)
    size_bytes: int = 0
    sha256: str | None = Field(None, max_length=64)
    storage_kind: str = Field("managed", max_length=16)
    storage_path: str = Field(..., max_length=1024)
    source: str = Field("manual", max_length=32)
    source_conversation_id: str | None = None
    source_message_id: str | None = None
    source_task_id: str | None = None


class FileItemUpdate(BaseModel):
    name: str | None = Field(None, max_length=512)
    bucket_id: str | None = None
    starred: bool | None = None
    restore: bool | None = None  # if True, clears deleted_at


class FileItemRead(BaseModel):
    id: str
    bucket_id: str | None
    name: str
    ext: str
    mime: str | None
    size_bytes: int
    sha256: str | None
    storage_kind: str
    storage_path: str
    source: str
    source_conversation_id: str | None
    source_message_id: str | None
    source_task_id: str | None
    starred: bool
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    last_opened_at: datetime | None

    class Config:
        from_attributes = True


class FileItemCopyRequest(BaseModel):
    bucket_id: str | None = None  # destination bucket; null = unfiled
    new_storage_path: str  # caller copied bytes via IPC; this is the dest rel path
