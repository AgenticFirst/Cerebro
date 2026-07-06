"""Pydantic schemas for the local Gmail mail store (/gmail/*).

Secret-free: OAuth credentials never reach this layer. The Electron bridge
writes normalized messages here; the renderer and chat actions read them.
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ── Accounts ──────────────────────────────────────────────────────────────────


class GmailAccountUpsert(BaseModel):
    id: str
    email: str
    display_name: str | None = None
    status: str = "connected"


class GmailAccountUpdate(BaseModel):
    status: str | None = None
    last_error: str | None = None
    last_synced_at: datetime | None = None
    last_history_id: str | None = None
    last_full_sync_at: datetime | None = None


class GmailAccountResponse(BaseModel):
    id: str
    email: str
    display_name: str | None
    status: str
    last_error: str | None
    last_synced_at: datetime | None
    last_history_id: str | None
    last_full_sync_at: datetime | None


class GmailAccountListResponse(BaseModel):
    accounts: list[GmailAccountResponse]


# ── Messages ──────────────────────────────────────────────────────────────────


class GmailAttachment(BaseModel):
    attachmentId: str
    filename: str
    mimeType: str
    sizeBytes: int = 0


class GmailMessageUpsert(BaseModel):
    message_id: str
    thread_id: str
    from_addr: str | None = None
    to_addrs: str | None = None
    cc_addrs: str | None = None
    subject: str | None = None
    snippet: str | None = None
    body_text: str | None = None
    body_html: str | None = None
    label_ids: list[str] = Field(default_factory=list)
    internal_date: datetime | None = None
    is_outbound: bool = False
    attachments: list[GmailAttachment] = Field(default_factory=list)


class GmailSyncBatch(BaseModel):
    account_id: str
    upserts: list[GmailMessageUpsert] = Field(default_factory=list)
    # Gmail message ids deleted remotely.
    deletions: list[str] = Field(default_factory=list)
    # Label-only changes: {message_id: [label ids]} (from history labelsAdded/Removed).
    label_updates: dict[str, list[str]] = Field(default_factory=dict)


class GmailSyncResult(BaseModel):
    upserted: int
    deleted: int
    relabeled: int
    # Provider thread ids touched by this batch (bridge uses this for AI labeling).
    touched_thread_ids: list[str]


class GmailMessageResponse(BaseModel):
    id: str
    message_id: str
    thread_id: str
    from_addr: str | None
    to_addrs: str | None
    cc_addrs: str | None
    subject: str | None
    snippet: str | None
    body_text: str | None
    body_html: str | None
    label_ids: list[str]
    internal_date: datetime | None
    is_unread: bool
    is_outbound: bool
    has_attachments: bool
    attachments: list[GmailAttachment]


class GmailMessageListResponse(BaseModel):
    messages: list[GmailMessageResponse]


# ── Threads ───────────────────────────────────────────────────────────────────


class GmailThreadResponse(BaseModel):
    id: str
    thread_id: str
    subject: str | None
    snippet: str | None
    last_message_at: datetime | None
    message_count: int
    unread_count: int
    has_attachments: bool
    label_ids: list[str]
    ai_summary: str | None
    ai_label: str | None
    snoozed_until: datetime | None
    last_outbound_at: datetime | None
    awaiting_reply: bool


class GmailThreadListResponse(BaseModel):
    threads: list[GmailThreadResponse]
    total: int


class GmailThreadUpdate(BaseModel):
    ai_summary: str | None = None
    ai_summary_message_count: int | None = None
    ai_label: str | None = None
    # Empty string clears the snooze.
    snoozed_until: datetime | None = None
    clear_snooze: bool = False


# ── Search ────────────────────────────────────────────────────────────────────


class GmailSearchRequest(BaseModel):
    q: str
    limit: int = 25


class GmailSearchResponse(BaseModel):
    messages: list[GmailMessageResponse]
    # True when FTS was available; false → LIKE fallback was used.
    fts: bool
