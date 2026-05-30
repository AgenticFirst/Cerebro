"""Pydantic request/response schemas for Knowledge Base pages — /knowledge/*."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class KnowledgePageCreate(BaseModel):
    id: str | None = None
    parent_id: str | None = None
    title: str = "Untitled"
    icon: str | None = None
    content_json: str | None = None
    content_markdown: str | None = None
    # Optional explicit placement; defaults to end of its sibling list.
    sort_order: float | None = None


class KnowledgePageUpdate(BaseModel):
    parent_id: str | None = None
    title: str | None = None
    icon: str | None = None
    cover_url: str | None = None
    content_json: str | None = None
    content_markdown: str | None = None
    sort_order: float | None = None
    is_archived: bool | None = None


class KnowledgePageReorderItem(BaseModel):
    id: str
    parent_id: str | None = None
    sort_order: float


class KnowledgePageReorder(BaseModel):
    items: list[KnowledgePageReorderItem]


class KnowledgePageResponse(BaseModel):
    """Full page incl. content. Returned by GET /pages/{id} and mutations."""

    id: str
    parent_id: str | None
    title: str
    icon: str | None
    cover_url: str | None
    content_json: str | None
    content_markdown: str | None
    sort_order: float
    is_archived: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class KnowledgePageTreeNode(BaseModel):
    """Lightweight node for the sidebar tree — no content body."""

    id: str
    parent_id: str | None
    title: str
    icon: str | None
    sort_order: float
    has_children: bool
    children: list["KnowledgePageTreeNode"] = []

    model_config = {"from_attributes": True}


class KnowledgePageTreeResponse(BaseModel):
    pages: list[KnowledgePageTreeNode]


class KnowledgePageListItem(BaseModel):
    """Flat list item used for the trash view (no content body)."""

    id: str
    parent_id: str | None
    title: str
    icon: str | None
    updated_at: datetime

    model_config = {"from_attributes": True}


class KnowledgePageListResponse(BaseModel):
    pages: list[KnowledgePageListItem]


class KnowledgePageSearchHit(BaseModel):
    """One search result: page metadata + a snippet of the match. The snippet
    wraps matched spans in the sentinel chars \\x01 (start) / \\x02 (end) so the
    UI can bold them without parsing HTML."""

    id: str
    parent_id: str | None
    title: str
    icon: str | None
    snippet: str
    updated_at: datetime


class KnowledgePageSearchResponse(BaseModel):
    results: list[KnowledgePageSearchHit]


# ── Ask AI: threads + messages ────────────────────────────────────


class KnowledgeAiThreadCreate(BaseModel):
    page_id: str
    title: str = "New chat"


class KnowledgeAiThreadUpdate(BaseModel):
    title: str | None = None


class KnowledgeAiThreadResponse(BaseModel):
    id: str
    page_id: str
    title: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class KnowledgeAiThreadListResponse(BaseModel):
    threads: list[KnowledgeAiThreadResponse]


class KnowledgeAiMessageCreate(BaseModel):
    role: str  # 'user' | 'assistant'
    content: str


class KnowledgeAiMessageResponse(BaseModel):
    id: str
    thread_id: str
    role: str
    content: str
    created_at: datetime

    model_config = {"from_attributes": True}


class KnowledgeAiMessageListResponse(BaseModel):
    messages: list[KnowledgeAiMessageResponse]
