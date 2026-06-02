"""FastAPI router for the normalized calendar store — /calendar/*.

This is a secret-free CRUD + window-query store. The Electron main process owns
OAuth and tokens; it writes normalized rows here (upserts from provider pulls,
Cerebro-origin events awaiting push) and the renderer reads them for the unified
view. No provider HTTP and no credentials live in this layer.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from database import get_db
from models import CalendarAccount, CalendarEvent, CalendarSyncState, _utcnow

from .schemas import (
    CalendarAccountCreate,
    CalendarAccountListResponse,
    CalendarAccountResponse,
    CalendarAccountUpdate,
    CalendarEventCreate,
    CalendarEventListResponse,
    CalendarEventResponse,
    CalendarEventUpdate,
    CalendarEventUpsertBatch,
    CalendarSyncStateListResponse,
    CalendarSyncStateResponse,
    CalendarSyncStateUpsert,
)

router = APIRouter(tags=["calendar"])
logger = logging.getLogger(__name__)

# The built-in on-device calendar. Always available, no OAuth required. Events on
# it are stored locally (and replicate to Supabase) but never pushed to a provider.
LOCAL_ACCOUNT_ID = "local"
LOCAL_CALENDAR_ID = "local"


def _uuid_hex() -> str:
    return uuid.uuid4().hex


def _ensure_local_account(db: Session) -> CalendarAccount:
    """Get-or-create the singleton local calendar account."""
    acc = db.get(CalendarAccount, LOCAL_ACCOUNT_ID)
    if acc is None:
        acc = CalendarAccount(
            id=LOCAL_ACCOUNT_ID,
            provider="local",
            email="Local calendar",
            display_name="Local",
            primary_calendar_id=LOCAL_CALENDAR_ID,
            calendars_json=json.dumps(
                [{"id": LOCAL_CALENDAR_ID, "name": "Local", "color": "#06B6D4", "selected": True}]
            ),
            status="connected",
        )
        db.add(acc)
        db.flush()
    return acc


def _loads(value: str | None):
    if not value:
        return None
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return None


def _account_to_response(acc: CalendarAccount) -> CalendarAccountResponse:
    return CalendarAccountResponse(
        id=acc.id,
        provider=acc.provider,
        email=acc.email,
        display_name=acc.display_name,
        primary_calendar_id=acc.primary_calendar_id,
        calendars=_loads(acc.calendars_json),
        status=acc.status,
        last_error=acc.last_error,
        last_synced_at=acc.last_synced_at,
        created_at=acc.created_at,
        updated_at=acc.updated_at,
    )


def _event_to_response(ev: CalendarEvent) -> CalendarEventResponse:
    return CalendarEventResponse(
        id=ev.id,
        account_id=ev.account_id,
        calendar_id=ev.calendar_id,
        provider_event_id=ev.provider_event_id,
        etag=ev.etag,
        ical_uid=ev.ical_uid,
        title=ev.title,
        description=ev.description,
        location=ev.location,
        start_utc=ev.start_utc,
        end_utc=ev.end_utc,
        start_tz=ev.start_tz,
        end_tz=ev.end_tz,
        all_day=ev.all_day,
        recurrence=_loads(ev.recurrence_json),
        recurring_master_id=ev.recurring_master_id,
        attendees=_loads(ev.attendees_json),
        organizer_email=ev.organizer_email,
        rsvp_status=ev.rsvp_status,
        visibility=ev.visibility,
        transparency=ev.transparency,
        status=ev.status,
        conference_url=ev.conference_url,
        color=ev.color,
        provider_updated_at=ev.provider_updated_at,
        origin=ev.origin,
        sync_status=ev.sync_status,
        conflict=_loads(ev.conflict_json),
        created_at=ev.created_at,
        updated_at=ev.updated_at,
    )


# ── Accounts ──────────────────────────────────────────────────────────────────


@router.get("/accounts", response_model=CalendarAccountListResponse)
def list_accounts(db: Session = Depends(get_db)) -> CalendarAccountListResponse:
    rows = (
        db.query(CalendarAccount)
        .filter(CalendarAccount.status != "disconnected")
        .order_by(CalendarAccount.created_at)
        .all()
    )
    return CalendarAccountListResponse(accounts=[_account_to_response(r) for r in rows])


@router.post("/accounts", response_model=CalendarAccountResponse, status_code=201)
def create_account(body: CalendarAccountCreate, db: Session = Depends(get_db)) -> CalendarAccountResponse:
    acc = CalendarAccount(
        id=body.id or _uuid_hex(),
        provider=body.provider,
        email=body.email,
        display_name=body.display_name,
        primary_calendar_id=body.primary_calendar_id,
        calendars_json=json.dumps(body.calendars) if body.calendars is not None else None,
        status="connected",
    )
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return _account_to_response(acc)


@router.patch("/accounts/{account_id}", response_model=CalendarAccountResponse)
def update_account(
    account_id: str, body: CalendarAccountUpdate, db: Session = Depends(get_db)
) -> CalendarAccountResponse:
    acc = db.get(CalendarAccount, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")
    if body.display_name is not None:
        acc.display_name = body.display_name
    if body.primary_calendar_id is not None:
        acc.primary_calendar_id = body.primary_calendar_id
    if body.calendars is not None:
        acc.calendars_json = json.dumps(body.calendars)
    if body.status is not None:
        acc.status = body.status
    if body.last_error is not None:
        acc.last_error = body.last_error or None
    if body.last_synced_at is not None:
        acc.last_synced_at = body.last_synced_at
    acc.updated_at = _utcnow()
    db.commit()
    db.refresh(acc)
    return _account_to_response(acc)


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(account_id: str, db: Session = Depends(get_db)) -> Response:
    acc = db.get(CalendarAccount, account_id)
    if acc:
        # Hard-delete the account and its events (CASCADE) + sync state. Tokens
        # are cleared separately by the Electron bridge (calendar_* settings).
        db.delete(acc)
        db.query(CalendarSyncState).filter(CalendarSyncState.account_id == account_id).delete()
        db.commit()
    return Response(status_code=204)


# ── Events ────────────────────────────────────────────────────────────────────


@router.get("/events", response_model=CalendarEventListResponse)
def list_events(
    db: Session = Depends(get_db),
    start: datetime | None = Query(None, description="window start (UTC); inclusive"),
    end: datetime | None = Query(None, description="window end (UTC); exclusive"),
    account_id: str | None = Query(None),
    include_cancelled: bool = Query(False),
) -> CalendarEventListResponse:
    q = db.query(CalendarEvent)
    if account_id:
        q = q.filter(CalendarEvent.account_id == account_id)
    if not include_cancelled:
        q = q.filter(CalendarEvent.status != "cancelled")
    if start is not None and end is not None:
        # Overlap test: event starts before window end AND ends after window start.
        # Recurring masters (no concrete start in-window) are always returned so
        # the client can expand them for the visible range.
        q = q.filter(
            or_(
                CalendarEvent.recurrence_json.isnot(None),
                and_(CalendarEvent.start_utc < end, CalendarEvent.end_utc > start),
            )
        )
    rows = q.order_by(CalendarEvent.start_utc).all()
    return CalendarEventListResponse(events=[_event_to_response(r) for r in rows])


@router.get("/events/pending", response_model=CalendarEventListResponse)
def list_pending_events(
    db: Session = Depends(get_db), account_id: str | None = Query(None)
) -> CalendarEventListResponse:
    """Cerebro-origin mutations awaiting push to the provider (sync engine)."""
    q = db.query(CalendarEvent).filter(
        CalendarEvent.sync_status.in_(["pending_push", "pending_delete"])
    )
    if account_id:
        q = q.filter(CalendarEvent.account_id == account_id)
    rows = q.order_by(CalendarEvent.updated_at).all()
    return CalendarEventListResponse(events=[_event_to_response(r) for r in rows])


# Declared after /events/pending so the static route isn't shadowed by {event_id}.
@router.get("/events/{event_id}", response_model=CalendarEventResponse)
def get_event(event_id: str, db: Session = Depends(get_db)) -> CalendarEventResponse:
    ev = db.get(CalendarEvent, event_id)
    if not ev:
        raise HTTPException(status_code=404, detail="Event not found")
    return _event_to_response(ev)


@router.post("/events", response_model=CalendarEventResponse, status_code=201)
def create_event(body: CalendarEventCreate, db: Session = Depends(get_db)) -> CalendarEventResponse:
    """Create a local (on-device) event.

    Provider-calendar events are created at the provider by the Electron bridge
    and pulled in via /events/sync, so this endpoint only handles the local
    calendar: sync_status='local' means "never push to an external provider".
    """
    acc = _ensure_local_account(db)
    ev = CalendarEvent(
        id=body.id or _uuid_hex(),
        account_id=acc.id,
        calendar_id=body.calendar_id or LOCAL_CALENDAR_ID,
        provider_event_id=None,
        ical_uid=body.ical_uid,
        title=body.title,
        description=body.description,
        location=body.location,
        start_utc=body.start_utc,
        end_utc=body.end_utc,
        start_tz=body.start_tz,
        end_tz=body.end_tz,
        all_day=body.all_day,
        recurrence_json=json.dumps(body.recurrence) if body.recurrence else None,
        attendees_json=json.dumps(body.attendees) if body.attendees else None,
        organizer_email=body.organizer_email,
        rsvp_status=body.rsvp_status,
        visibility=body.visibility,
        transparency=body.transparency,
        status=body.status,
        conference_url=body.conference_url,
        color=body.color,
        origin="cerebro",
        sync_status="local",
    )
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return _event_to_response(ev)


@router.patch("/events/{event_id}", response_model=CalendarEventResponse)
def update_event(
    event_id: str, body: CalendarEventUpdate, db: Session = Depends(get_db)
) -> CalendarEventResponse:
    ev = db.get(CalendarEvent, event_id)
    if not ev:
        raise HTTPException(status_code=404, detail="Event not found")
    for field in (
        "title",
        "description",
        "location",
        "start_utc",
        "end_utc",
        "start_tz",
        "end_tz",
        "all_day",
        "rsvp_status",
        "visibility",
        "transparency",
        "status",
        "conference_url",
        "color",
    ):
        val = getattr(body, field)
        if val is not None:
            setattr(ev, field, val)
    if body.attendees is not None:
        ev.attendees_json = json.dumps(body.attendees)
    # A provider-event edit must be re-pushed; a local ('local') event stays
    # local, and a pending delete stays pending delete.
    if ev.sync_status not in ("pending_delete", "local"):
        ev.sync_status = "pending_push"
    ev.updated_at = _utcnow()
    db.commit()
    db.refresh(ev)
    return _event_to_response(ev)


@router.delete("/events/{event_id}", response_model=CalendarEventResponse)
def delete_event(event_id: str, db: Session = Depends(get_db)) -> CalendarEventResponse:
    """Mark an event for deletion; the sync engine removes it at the provider."""
    ev = db.get(CalendarEvent, event_id)
    if not ev:
        raise HTTPException(status_code=404, detail="Event not found")
    if ev.provider_event_id is None and ev.origin == "cerebro":
        # Never pushed — safe to drop outright.
        db.delete(ev)
        db.commit()
        ev.sync_status = "pending_delete"  # for the response only
        return _event_to_response(ev)
    ev.sync_status = "pending_delete"
    ev.updated_at = _utcnow()
    db.commit()
    db.refresh(ev)
    return _event_to_response(ev)


@router.post("/events/sync", response_model=CalendarEventListResponse)
def apply_sync_batch(
    body: CalendarEventUpsertBatch, db: Session = Depends(get_db)
) -> CalendarEventListResponse:
    """Apply one provider-pull tick: upsert events + soft-delete tombstones.

    Conflict policy is last-write-wins by provider_updated_at vs local updated_at.
    When a remote change lands on a row with a pending local push, the losing side
    is recorded in conflict_json so the UI can surface it.
    """
    account_id = body.account_id
    touched: list[CalendarEvent] = []

    for up in body.upserts:
        existing = (
            db.query(CalendarEvent)
            .filter(
                CalendarEvent.account_id == account_id,
                CalendarEvent.calendar_id == up.calendar_id,
                CalendarEvent.provider_event_id == up.provider_event_id,
            )
            .first()
        )
        if existing is None:
            ev = CalendarEvent(
                id=_uuid_hex(),
                account_id=account_id,
                calendar_id=up.calendar_id,
                provider_event_id=up.provider_event_id,
                origin="provider",
                sync_status="synced",
            )
            db.add(ev)
        else:
            ev = existing
            # Conflict: local push pending and remote also changed.
            if ev.sync_status == "pending_push":
                local_mtime = ev.updated_at
                remote_mtime = up.provider_updated_at
                if remote_mtime and local_mtime and remote_mtime <= local_mtime:
                    # Local wins — keep pending push, stash remote as the loser.
                    ev.conflict_json = json.dumps(
                        {"side": "remote", "etag": up.etag, "at": _iso(remote_mtime)}
                    )
                    touched.append(ev)
                    continue
                # Remote wins — record local as the loser, then overwrite below.
                ev.conflict_json = json.dumps(
                    {"side": "local", "at": _iso(local_mtime)}
                )

        _apply_upsert_fields(ev, up)
        # Remote state is now authoritative for this row (conflict_json, if set,
        # stays as an informational marker for the UI).
        ev.sync_status = "synced"
        ev.updated_at = _utcnow()
        touched.append(ev)

    if body.deletions:
        rows = (
            db.query(CalendarEvent)
            .filter(
                CalendarEvent.account_id == account_id,
                CalendarEvent.provider_event_id.in_(body.deletions),
            )
            .all()
        )
        for ev in rows:
            ev.status = "cancelled"
            ev.sync_status = "synced"
            ev.updated_at = _utcnow()
            touched.append(ev)

    db.commit()
    for ev in touched:
        db.refresh(ev)
    return CalendarEventListResponse(events=[_event_to_response(r) for r in touched])


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _apply_upsert_fields(ev: CalendarEvent, up) -> None:
    ev.etag = up.etag
    ev.ical_uid = up.ical_uid
    ev.title = up.title
    ev.description = up.description
    ev.location = up.location
    ev.start_utc = up.start_utc
    ev.end_utc = up.end_utc
    ev.start_tz = up.start_tz
    ev.end_tz = up.end_tz
    ev.all_day = up.all_day
    ev.recurrence_json = json.dumps(up.recurrence) if up.recurrence else None
    ev.recurring_master_id = up.recurring_master_id
    ev.attendees_json = json.dumps(up.attendees) if up.attendees else None
    ev.organizer_email = up.organizer_email
    ev.rsvp_status = up.rsvp_status
    ev.visibility = up.visibility
    ev.transparency = up.transparency
    ev.status = up.status
    ev.conference_url = up.conference_url
    ev.color = up.color
    ev.provider_updated_at = up.provider_updated_at


@router.post("/events/{event_id}/pushed", response_model=CalendarEventResponse)
def mark_event_pushed(
    event_id: str,
    provider_event_id: str = Query(...),
    etag: str | None = Query(None),
    db: Session = Depends(get_db),
) -> CalendarEventResponse:
    """Flip a pending_push event to synced once the provider create/update lands."""
    ev = db.get(CalendarEvent, event_id)
    if not ev:
        raise HTTPException(status_code=404, detail="Event not found")
    ev.provider_event_id = provider_event_id
    ev.etag = etag
    ev.sync_status = "synced"
    ev.updated_at = _utcnow()
    db.commit()
    db.refresh(ev)
    return _event_to_response(ev)


# ── Sync state (local-only cursors) ───────────────────────────────────────────


@router.get("/sync-state", response_model=CalendarSyncStateListResponse)
def list_sync_state(
    db: Session = Depends(get_db), account_id: str | None = Query(None)
) -> CalendarSyncStateListResponse:
    q = db.query(CalendarSyncState)
    if account_id:
        q = q.filter(CalendarSyncState.account_id == account_id)
    rows = q.all()
    return CalendarSyncStateListResponse(
        states=[CalendarSyncStateResponse.model_validate(r) for r in rows]
    )


@router.put("/sync-state", response_model=CalendarSyncStateResponse)
def upsert_sync_state(
    body: CalendarSyncStateUpsert, db: Session = Depends(get_db)
) -> CalendarSyncStateResponse:
    row = (
        db.query(CalendarSyncState)
        .filter(
            CalendarSyncState.account_id == body.account_id,
            CalendarSyncState.calendar_id == body.calendar_id,
        )
        .first()
    )
    if row is None:
        row = CalendarSyncState(
            id=_uuid_hex(),
            account_id=body.account_id,
            calendar_id=body.calendar_id,
        )
        db.add(row)
    row.sync_cursor = body.sync_cursor
    row.cursor_updated_at = _utcnow()
    if body.full_sync_window_start is not None:
        row.full_sync_window_start = body.full_sync_window_start
    db.commit()
    db.refresh(row)
    return CalendarSyncStateResponse.model_validate(row)
