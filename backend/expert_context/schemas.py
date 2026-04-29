from datetime import datetime

from pydantic import BaseModel, Field


VALID_KINDS = {"reference", "template"}


class ContextFileAttach(BaseModel):
    file_item_id: str
    kind: str = Field("reference", max_length=20)
    sort_order: float | None = None


class ContextFilePatch(BaseModel):
    kind: str | None = Field(None, max_length=20)
    sort_order: float | None = None


class ContextFileRead(BaseModel):
    id: str
    expert_id: str
    file_item_id: str
    kind: str
    sort_order: float
    char_count: int
    truncated: bool
    created_at: datetime
    # Resolved/joined fields the UI needs to render the chip without a follow-up call.
    file_name: str
    file_ext: str
    file_mime: str | None
    file_size_bytes: int
    # Absolute path to the original bytes (for download/preview).
    file_storage_path: str
    # Absolute path to the parsed-text sidecar, if extracted. The installer
    # reads this on disk to inject the markdown into the expert's system
    # prompt. Null for image/text passthroughs (no extraction needed).
    parsed_text_path: str | None

    class Config:
        from_attributes = True
