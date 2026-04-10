"""Pydantic request/response schemas for the memory system."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


# ── Legacy Context Files (read-only, used only by the one-shot migration) ──

class ContextFileResponse(BaseModel):
    key: str
    content: str
    updated_at: datetime


class LegacyMemoryItem(BaseModel):
    scope: str
    scope_id: str | None
    content: str
    created_at: datetime
