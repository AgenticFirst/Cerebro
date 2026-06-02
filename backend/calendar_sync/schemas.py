"""Pydantic request/response models for the /calendar normalized store.

The store is provider-agnostic and secret-free: the Electron main process owns
OAuth + tokens and writes normalized rows here; the renderer reads them for the
unified calendar view. Times cross the wire as UTC ISO datetimes plus the
original IANA zone.
"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


# ── Accounts ──────────────────────────────────────────────────────────────────


class CalendarAccountCreate(BaseModel):
    id: str | None = None  # caller may supply (main owns the id for token-key linkage)
    provider: str  # 'google' | 'outlook'
    email: str
    display_name: str | None = None
    primary_calendar_id: str | None = None
    calendars: list[dict] | None = None  # [{id,name,color,selected}]


class CalendarAccountUpdate(BaseModel):
    display_name: str | None = None
    primary_calendar_id: str | None = None
    calendars: list[dict] | None = None
    status: str | None = None  # connected|token_expired|error|disconnected
    last_error: str | None = None
    last_synced_at: datetime | None = None


class CalendarAccountResponse(BaseModel):
    id: str
    provider: str
    email: str
    display_name: str | None = None
    primary_calendar_id: str | None = None
    calendars: list[dict] | None = Field(None, validation_alias="calendars_parsed")
    status: str
    last_error: str | None = None
    last_synced_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class CalendarAccountListResponse(BaseModel):
    accounts: list[CalendarAccountResponse]


# ── Events ────────────────────────────────────────────────────────────────────


class CalendarEventBase(BaseModel):
    calendar_id: str
    provider_event_id: str | None = None
    etag: str | None = None
    ical_uid: str | None = None
    title: str | None = None
    description: str | None = None
    location: str | None = None
    start_utc: datetime | None = None
    end_utc: datetime | None = None
    start_tz: str | None = None
    end_tz: str | None = None
    all_day: bool = False
    recurrence: list[str] | None = None  # RRULE[]
    recurring_master_id: str | None = None
    attendees: list[dict] | None = None  # [{email,name,response}]
    organizer_email: str | None = None
    rsvp_status: str | None = None
    visibility: str = "default"
    transparency: str = "opaque"
    status: str = "confirmed"
    conference_url: str | None = None
    color: str | None = None
    provider_updated_at: datetime | None = None


class CalendarEventCreate(CalendarEventBase):
    """A Cerebro-origin local event. calendar_id defaults to the local calendar."""

    id: str | None = None
    # Local events don't require a calendar id (router defaults to 'local').
    calendar_id: str | None = None


class CalendarEventUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    location: str | None = None
    start_utc: datetime | None = None
    end_utc: datetime | None = None
    start_tz: str | None = None
    end_tz: str | None = None
    all_day: bool | None = None
    attendees: list[dict] | None = None
    rsvp_status: str | None = None
    visibility: str | None = None
    transparency: str | None = None
    status: str | None = None
    conference_url: str | None = None
    color: str | None = None


class CalendarEventResponse(CalendarEventBase):
    id: str
    account_id: str
    origin: str
    sync_status: str
    conflict: dict | None = Field(None, validation_alias="conflict_parsed")
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class CalendarEventListResponse(BaseModel):
    events: list[CalendarEventResponse]


class CalendarEventUpsert(CalendarEventBase):
    """One event from a provider pull, keyed by (account, calendar, provider id)."""

    pass


class CalendarEventUpsertBatch(BaseModel):
    """Result of a provider pull tick for one account, applied atomically."""

    account_id: str
    upserts: list[CalendarEventUpsert] = []
    # provider_event_ids to soft-delete (cancelled remotely)
    deletions: list[str] = []


# ── Sync state (local-only cursors) ───────────────────────────────────────────


class CalendarSyncStateUpsert(BaseModel):
    account_id: str
    calendar_id: str
    sync_cursor: str | None = None
    full_sync_window_start: datetime | None = None


class CalendarSyncStateResponse(BaseModel):
    account_id: str
    calendar_id: str
    sync_cursor: str | None = None
    cursor_updated_at: datetime | None = None
    full_sync_window_start: datetime | None = None

    model_config = {"from_attributes": True}


class CalendarSyncStateListResponse(BaseModel):
    states: list[CalendarSyncStateResponse]
