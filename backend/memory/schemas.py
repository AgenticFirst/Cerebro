"""Pydantic request/response schemas for the memory system."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


# ── Context Files (Tier 1) ───────────────────────────────────────

class ContextFileResponse(BaseModel):
    key: str
    content: str
    updated_at: datetime


class ContextFileUpdate(BaseModel):
    content: str


# ── Learned Facts (Tier 2) ───────────────────────────────────────

class MemoryItemResponse(BaseModel):
    id: str
    scope: str
    scope_id: str | None
    content: str
    source_conversation_id: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class MemoryItemsListResponse(BaseModel):
    items: list[MemoryItemResponse]
    total: int


# ── Knowledge Entries (Tier 3) ───────────────────────────────────

class KnowledgeEntryResponse(BaseModel):
    id: str
    scope: str
    scope_id: str | None
    entry_type: str
    occurred_at: datetime
    summary: str
    content: str  # JSON string
    source: str
    source_conversation_id: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class KnowledgeEntryCreate(BaseModel):
    scope: str = "personal"
    scope_id: str | None = None
    entry_type: str
    occurred_at: datetime
    summary: str
    content: str  # JSON string
    source: str = "manual"
    source_conversation_id: str | None = None


class KnowledgeEntriesListResponse(BaseModel):
    entries: list[KnowledgeEntryResponse]
    total: int


# ── System Prompt Assembly ───────────────────────────────────────

class MemoryContextRequest(BaseModel):
    messages: list[dict] | None = None
    scope: str = "personal"
    scope_id: str | None = None


class MemoryContextResponse(BaseModel):
    system_prompt: str
    context_files_used: list[str]
    recall_item_count: int
    knowledge_entry_count: int


# ── Extraction ───────────────────────────────────────────────────

class ExtractionRequest(BaseModel):
    conversation_id: str | None = None
    messages: list[dict]
    scope: str = "personal"
    scope_id: str | None = None
