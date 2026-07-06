"""FastAPI router for the local Gmail mail store — /gmail/*.

Secret-free mirror of the connected mailbox (windowed ~90 days). The Electron
bridge owns OAuth + provider HTTP and pushes normalized batches here; the
renderer (Email screen) and chat actions read. Everything under /gmail is
LOCAL-ONLY (never replicates to Supabase) — see cloud_sync/config.py.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_, text
from sqlalchemy.orm import Session

from database import get_db
from models import (
    GmailAccount,
    GmailMessage,
    GmailScheduledSend,
    GmailTemplate,
    GmailThread,
    _utcnow,
)

from .fts import ensure_fts, fts_query_string
from .schemas import (
    GmailAccountListResponse,
    GmailAccountResponse,
    GmailAccountUpdate,
    GmailAccountUpsert,
    GmailAttachment,
    GmailMessageListResponse,
    GmailMessageResponse,
    GmailSearchRequest,
    GmailSearchResponse,
    GmailSyncBatch,
    GmailSyncResult,
    GmailThreadListResponse,
    GmailThreadResponse,
    GmailThreadUpdate,
)

router = APIRouter(tags=["gmail"])
logger = logging.getLogger(__name__)


def _loads_list(value: str | None) -> list:
    if not value:
        return []
    try:
        out = json.loads(value)
        return out if isinstance(out, list) else []
    except (ValueError, TypeError):
        return []


def _account_response(acc: GmailAccount) -> GmailAccountResponse:
    return GmailAccountResponse(
        id=acc.id,
        email=acc.email,
        display_name=acc.display_name,
        status=acc.status,
        last_error=acc.last_error,
        last_synced_at=acc.last_synced_at,
        last_history_id=acc.last_history_id,
        last_full_sync_at=acc.last_full_sync_at,
    )


def _message_response(m: GmailMessage) -> GmailMessageResponse:
    return GmailMessageResponse(
        id=m.id,
        message_id=m.message_id,
        thread_id=m.thread_id,
        from_addr=m.from_addr,
        to_addrs=m.to_addrs,
        cc_addrs=m.cc_addrs,
        subject=m.subject,
        snippet=m.snippet,
        body_text=m.body_text,
        body_html=m.body_html,
        label_ids=_loads_list(m.label_ids_json),
        internal_date=m.internal_date,
        is_unread=m.is_unread,
        is_outbound=m.is_outbound,
        has_attachments=m.has_attachments,
        attachments=[GmailAttachment(**a) for a in _loads_list(m.attachments_json)],
    )


def _thread_response(t: GmailThread) -> GmailThreadResponse:
    return GmailThreadResponse(
        id=t.id,
        thread_id=t.thread_id,
        subject=t.subject,
        snippet=t.snippet,
        last_message_at=t.last_message_at,
        message_count=t.message_count,
        unread_count=t.unread_count,
        has_attachments=t.has_attachments,
        label_ids=_loads_list(t.label_ids_json),
        ai_summary=t.ai_summary,
        ai_label=t.ai_label,
        snoozed_until=t.snoozed_until,
        last_outbound_at=t.last_outbound_at,
        awaiting_reply=t.awaiting_reply,
    )


# ── Accounts ──────────────────────────────────────────────────────────────────


@router.get("/accounts", response_model=GmailAccountListResponse)
def list_accounts(db: Session = Depends(get_db)) -> GmailAccountListResponse:
    rows = db.query(GmailAccount).order_by(GmailAccount.created_at).all()
    return GmailAccountListResponse(accounts=[_account_response(r) for r in rows])


@router.put("/accounts", response_model=GmailAccountResponse)
def upsert_account(body: GmailAccountUpsert, db: Session = Depends(get_db)) -> GmailAccountResponse:
    """Create-or-update by id — the bridge owns account ids."""
    acc = db.get(GmailAccount, body.id)
    if acc is None:
        acc = GmailAccount(id=body.id)
        db.add(acc)
    acc.email = body.email
    acc.display_name = body.display_name
    acc.status = body.status
    db.commit()
    db.refresh(acc)
    return _account_response(acc)


@router.patch("/accounts/{account_id}", response_model=GmailAccountResponse)
def update_account(
    account_id: str, body: GmailAccountUpdate, db: Session = Depends(get_db)
) -> GmailAccountResponse:
    acc = db.get(GmailAccount, account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")
    if body.status is not None:
        acc.status = body.status
    if body.last_error is not None:
        acc.last_error = body.last_error or None
    if body.last_synced_at is not None:
        acc.last_synced_at = body.last_synced_at
    if body.last_history_id is not None:
        acc.last_history_id = body.last_history_id or None
    if body.last_full_sync_at is not None:
        acc.last_full_sync_at = body.last_full_sync_at
    acc.updated_at = _utcnow()
    db.commit()
    db.refresh(acc)
    return _account_response(acc)


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(account_id: str, db: Session = Depends(get_db)) -> Response:
    acc = db.get(GmailAccount, account_id)
    if acc:
        # Messages/threads cascade via FK; delete explicitly for SQLite safety.
        db.query(GmailMessage).filter(GmailMessage.account_id == account_id).delete()
        db.query(GmailThread).filter(GmailThread.account_id == account_id).delete()
        db.delete(acc)
        db.commit()
    return Response(status_code=204)


# ── Sync batches ──────────────────────────────────────────────────────────────


def _recompute_thread(db: Session, account_id: str, thread_id: str) -> None:
    """Refresh the per-thread rollup from its messages (or drop it if empty)."""
    msgs = (
        db.query(GmailMessage)
        .filter(GmailMessage.account_id == account_id, GmailMessage.thread_id == thread_id)
        .order_by(GmailMessage.internal_date)
        .all()
    )
    thread = (
        db.query(GmailThread)
        .filter(GmailThread.account_id == account_id, GmailThread.thread_id == thread_id)
        .first()
    )
    if not msgs:
        if thread:
            db.delete(thread)
        return
    if thread is None:
        thread = GmailThread(account_id=account_id, thread_id=thread_id)
        db.add(thread)

    last = msgs[-1]
    labels: set[str] = set()
    for m in msgs:
        labels.update(_loads_list(m.label_ids_json))
    thread.subject = next((m.subject for m in msgs if m.subject), None)
    thread.snippet = last.snippet
    thread.last_message_at = last.internal_date
    thread.message_count = len(msgs)
    thread.unread_count = sum(1 for m in msgs if m.is_unread)
    thread.has_attachments = any(m.has_attachments for m in msgs)
    thread.label_ids_json = json.dumps(sorted(labels))
    thread.last_outbound_at = next(
        (m.internal_date for m in reversed(msgs) if m.is_outbound), None
    )
    # Awaiting reply = the conversation currently ends with us talking.
    thread.awaiting_reply = last.is_outbound
    if thread.ai_summary_message_count and thread.ai_summary_message_count != len(msgs):
        # Thread grew — cached summary is stale; the bridge recomputes lazily.
        thread.ai_summary = None
        thread.ai_summary_message_count = 0
    thread.updated_at = _utcnow()


@router.post("/sync", response_model=GmailSyncResult)
def apply_sync_batch(body: GmailSyncBatch, db: Session = Depends(get_db)) -> GmailSyncResult:
    acc = db.get(GmailAccount, body.account_id)
    if not acc:
        raise HTTPException(status_code=404, detail="Account not found")

    touched_threads: set[str] = set()
    upserted = 0
    for up in body.upserts:
        row = (
            db.query(GmailMessage)
            .filter(
                GmailMessage.account_id == body.account_id,
                GmailMessage.message_id == up.message_id,
            )
            .first()
        )
        if row is None:
            row = GmailMessage(account_id=body.account_id, message_id=up.message_id)
            db.add(row)
        row.thread_id = up.thread_id
        row.from_addr = up.from_addr
        row.to_addrs = up.to_addrs
        row.cc_addrs = up.cc_addrs
        row.subject = up.subject
        row.snippet = up.snippet
        row.body_text = up.body_text
        row.body_html = up.body_html
        row.label_ids_json = json.dumps(up.label_ids)
        row.internal_date = up.internal_date
        row.is_unread = "UNREAD" in up.label_ids
        row.is_outbound = up.is_outbound or "SENT" in up.label_ids
        row.has_attachments = bool(up.attachments)
        row.attachments_json = json.dumps([a.model_dump() for a in up.attachments])
        row.updated_at = _utcnow()
        touched_threads.add(up.thread_id)
        upserted += 1

    relabeled = 0
    for message_id, label_ids in body.label_updates.items():
        row = (
            db.query(GmailMessage)
            .filter(
                GmailMessage.account_id == body.account_id,
                GmailMessage.message_id == message_id,
            )
            .first()
        )
        if row is None:
            continue
        row.label_ids_json = json.dumps(label_ids)
        row.is_unread = "UNREAD" in label_ids
        row.updated_at = _utcnow()
        touched_threads.add(row.thread_id)
        relabeled += 1

    deleted = 0
    if body.deletions:
        rows = (
            db.query(GmailMessage)
            .filter(
                GmailMessage.account_id == body.account_id,
                GmailMessage.message_id.in_(body.deletions),
            )
            .all()
        )
        for row in rows:
            touched_threads.add(row.thread_id)
            db.delete(row)
            deleted += 1

    db.flush()
    for tid in touched_threads:
        _recompute_thread(db, body.account_id, tid)
    db.commit()
    return GmailSyncResult(
        upserted=upserted,
        deleted=deleted,
        relabeled=relabeled,
        touched_thread_ids=sorted(touched_threads),
    )


@router.get("/known-ids")
def known_message_ids(
    account_id: str = Query(...), db: Session = Depends(get_db)
) -> dict[str, list[str]]:
    """Gmail message ids already in the local store — lets the bridge skip
    re-fetching bodies during a windowed re-sync."""
    rows = (
        db.query(GmailMessage.message_id)
        .filter(GmailMessage.account_id == account_id)
        .all()
    )
    return {"message_ids": [r[0] for r in rows]}


# ── Threads (Email screen) ────────────────────────────────────────────────────


@router.get("/threads", response_model=GmailThreadListResponse)
def list_threads(
    db: Session = Depends(get_db),
    account_id: str | None = Query(None),
    tab: str | None = Query(
        None,
        description=(
            "inbox | important | awaiting_reply | team | marketing | notifications"
            " | snoozed | sent | all"
        ),
    ),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
) -> GmailThreadListResponse:
    q = db.query(GmailThread)
    if account_id:
        q = q.filter(GmailThread.account_id == account_id)

    now = _utcnow()
    not_snoozed = or_(GmailThread.snoozed_until.is_(None), GmailThread.snoozed_until <= now)
    if tab in (None, "inbox"):
        q = q.filter(GmailThread.label_ids_json.like('%"INBOX"%'), not_snoozed)
    elif tab == "snoozed":
        q = q.filter(GmailThread.snoozed_until.isnot(None), GmailThread.snoozed_until > now)
    elif tab == "awaiting_reply":
        q = q.filter(GmailThread.awaiting_reply.is_(True), not_snoozed)
    elif tab == "sent":
        q = q.filter(GmailThread.last_outbound_at.isnot(None))
    elif tab in ("important", "team", "marketing", "notifications"):
        q = q.filter(GmailThread.ai_label == tab, not_snoozed)
    # tab == "all": no filter

    total = q.count()
    rows = q.order_by(GmailThread.last_message_at.desc()).offset(offset).limit(limit).all()
    return GmailThreadListResponse(threads=[_thread_response(r) for r in rows], total=total)


@router.get("/threads/{thread_id}/messages", response_model=GmailMessageListResponse)
def thread_messages(
    thread_id: str,
    db: Session = Depends(get_db),
    account_id: str | None = Query(None),
) -> GmailMessageListResponse:
    q = db.query(GmailMessage).filter(GmailMessage.thread_id == thread_id)
    if account_id:
        q = q.filter(GmailMessage.account_id == account_id)
    rows = q.order_by(GmailMessage.internal_date).all()
    return GmailMessageListResponse(messages=[_message_response(r) for r in rows])


@router.patch("/threads/{row_id}", response_model=GmailThreadResponse)
def update_thread(
    row_id: str, body: GmailThreadUpdate, db: Session = Depends(get_db)
) -> GmailThreadResponse:
    t = db.get(GmailThread, row_id)
    if not t:
        raise HTTPException(status_code=404, detail="Thread not found")
    if body.ai_summary is not None:
        t.ai_summary = body.ai_summary
    if body.ai_summary_message_count is not None:
        t.ai_summary_message_count = body.ai_summary_message_count
    if body.ai_label is not None:
        t.ai_label = body.ai_label or None
    if body.clear_snooze:
        t.snoozed_until = None
    elif body.snoozed_until is not None:
        t.snoozed_until = body.snoozed_until
    t.updated_at = _utcnow()
    db.commit()
    db.refresh(t)
    return _thread_response(t)


# ── AI enrichment (labels + summaries, written by the Electron bridge) ───────


@router.get("/threads/unlabeled", response_model=None)
def unlabeled_threads(
    account_id: str = Query(...),
    limit: int = Query(25, le=50),
    db: Session = Depends(get_db),
) -> dict:
    """Inbox threads with no AI label yet — the bridge batch-classifies these.

    Includes the latest message's sender so the classifier sees who is writing.
    """
    rows = (
        db.query(GmailThread)
        .filter(
            GmailThread.account_id == account_id,
            GmailThread.ai_label.is_(None),
            GmailThread.label_ids_json.like('%"INBOX"%'),
        )
        .order_by(GmailThread.last_message_at.desc())
        .limit(limit)
        .all()
    )
    # Latest sender per thread in one query (ascending scan; last write wins).
    thread_ids = [t.thread_id for t in rows]
    latest_from: dict[str, str] = {}
    if thread_ids:
        msgs = (
            db.query(GmailMessage.thread_id, GmailMessage.from_addr)
            .filter(
                GmailMessage.account_id == account_id,
                GmailMessage.thread_id.in_(thread_ids),
            )
            .order_by(GmailMessage.internal_date)
            .all()
        )
        for thread_id, from_addr in msgs:
            latest_from[thread_id] = from_addr or ""
    return {
        "threads": [
            {
                "thread_id": t.thread_id,
                "from": latest_from.get(t.thread_id, ""),
                "subject": t.subject or "",
                "snippet": t.snippet or "",
            }
            for t in rows
        ]
    }


@router.post("/threads/ai-labels", response_model=None)
def apply_ai_labels(body: dict, db: Session = Depends(get_db)) -> dict:
    """Bulk-apply classifier output: {account_id, labels: {thread_id: label}}."""
    account_id = body.get("account_id")
    labels = body.get("labels") or {}
    if not account_id or not isinstance(labels, dict):
        raise HTTPException(status_code=422, detail="account_id and labels required")
    rows = (
        db.query(GmailThread)
        .filter(
            GmailThread.account_id == account_id,
            GmailThread.thread_id.in_(list(labels.keys())),
        )
        .all()
    )
    applied = 0
    for t in rows:
        label = labels.get(t.thread_id)
        if not isinstance(label, str):
            continue
        t.ai_label = label
        t.updated_at = _utcnow()
        applied += 1
    db.commit()
    return {"applied": applied}


@router.post("/threads/ai-summary", response_model=None)
def store_ai_summary(body: dict, db: Session = Depends(get_db)) -> dict:
    """Persist a lazily-computed thread summary: {account_id, thread_id, summary, message_count}."""
    account_id = body.get("account_id")
    thread_id = body.get("thread_id")
    t = (
        db.query(GmailThread)
        .filter(GmailThread.account_id == account_id, GmailThread.thread_id == thread_id)
        .first()
    )
    if t is None:
        raise HTTPException(status_code=404, detail="Thread not found")
    t.ai_summary = str(body.get("summary") or "") or None
    t.ai_summary_message_count = int(body.get("message_count") or 0)
    t.updated_at = _utcnow()
    db.commit()
    return {"ok": True}


@router.get("/messages/recent-sent", response_model=GmailMessageListResponse)
def recent_sent(
    account_id: str = Query(...),
    to: str | None = Query(None, description="filter: recipient address substring"),
    limit: int = Query(8, le=25),
    db: Session = Depends(get_db),
) -> GmailMessageListResponse:
    """The user's recent outbound messages — voice samples for AI drafting."""
    q = db.query(GmailMessage).filter(
        GmailMessage.account_id == account_id, GmailMessage.is_outbound.is_(True)
    )
    if to:
        q = q.filter(GmailMessage.to_addrs.ilike(f"%{to}%"))
    rows = q.order_by(GmailMessage.internal_date.desc()).limit(limit).all()
    return GmailMessageListResponse(messages=[_message_response(r) for r in rows])


# ── Follow-up detection (outreach) ────────────────────────────────────────────


@router.get("/threads/awaiting-reply", response_model=GmailThreadListResponse)
def awaiting_reply(
    db: Session = Depends(get_db),
    account_id: str | None = Query(None),
    older_than_days: int = Query(3, ge=0),
) -> GmailThreadListResponse:
    """Outbound threads with no reply for N+ days — follow-up candidates."""
    cutoff = _utcnow() - timedelta(days=older_than_days)
    q = db.query(GmailThread).filter(
        GmailThread.awaiting_reply.is_(True),
        GmailThread.last_outbound_at.isnot(None),
        GmailThread.last_outbound_at <= cutoff,
    )
    if account_id:
        q = q.filter(GmailThread.account_id == account_id)
    rows = q.order_by(GmailThread.last_outbound_at).all()
    return GmailThreadListResponse(threads=[_thread_response(r) for r in rows], total=len(rows))


# ── Templates (outreach) ──────────────────────────────────────────────────────

_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)(?:\s*\|[^}]*)?\s*\}\}")


def _template_variables(body_template: str, subject_template: str | None) -> str:
    """JSON list of the {{tokens}} referenced by a template pair."""
    return json.dumps(
        sorted(set(_VAR_RE.findall(body_template)) | set(_VAR_RE.findall(subject_template or "")))
    )


def _template_response(t: GmailTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "subject_template": t.subject_template,
        "body_template": t.body_template,
        "variables": _loads_list(t.variables_json),
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


@router.get("/templates", response_model=None)
def list_templates(db: Session = Depends(get_db)) -> dict:
    rows = db.query(GmailTemplate).order_by(GmailTemplate.name).all()
    return {"templates": [_template_response(t) for t in rows]}


@router.post("/templates", response_model=None, status_code=201)
def create_template(body: dict, db: Session = Depends(get_db)) -> dict:
    name = str(body.get("name") or "").strip()
    body_template = str(body.get("body_template") or "")
    if not name or not body_template:
        raise HTTPException(status_code=422, detail="name and body_template required")
    subject_template = str(body.get("subject_template") or "") or None
    t = GmailTemplate(
        name=name,
        subject_template=subject_template,
        body_template=body_template,
        variables_json=_template_variables(body_template, subject_template),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _template_response(t)


@router.patch("/templates/{template_id}", response_model=None)
def update_template(template_id: str, body: dict, db: Session = Depends(get_db)) -> dict:
    t = db.get(GmailTemplate, template_id)
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    if "name" in body:
        t.name = str(body["name"]).strip() or t.name
    if "subject_template" in body:
        t.subject_template = str(body["subject_template"] or "") or None
    if "body_template" in body:
        t.body_template = str(body["body_template"] or "") or t.body_template
    t.variables_json = _template_variables(t.body_template, t.subject_template)
    t.updated_at = _utcnow()
    db.commit()
    db.refresh(t)
    return _template_response(t)


@router.delete("/templates/{template_id}", status_code=204)
def delete_template(template_id: str, db: Session = Depends(get_db)) -> Response:
    t = db.get(GmailTemplate, template_id)
    if t:
        db.delete(t)
        db.commit()
    return Response(status_code=204)


@router.get("/templates/{template_id}", response_model=None)
def get_template(template_id: str, db: Session = Depends(get_db)) -> dict:
    t = db.get(GmailTemplate, template_id)
    if not t:
        raise HTTPException(status_code=404, detail="Template not found")
    return _template_response(t)


# ── Scheduled sends (send-later) ──────────────────────────────────────────────


def _scheduled_response(s: GmailScheduledSend) -> dict:
    return {
        "id": s.id,
        "account_id": s.account_id,
        "to_addrs": s.to_addrs,
        "cc_addrs": s.cc_addrs,
        "bcc_addrs": s.bcc_addrs,
        "subject": s.subject,
        "body_text": s.body_text,
        "reply_to_thread_id": s.reply_to_thread_id,
        "send_at": s.send_at.isoformat() if s.send_at else None,
        "status": s.status,
        "error": s.error,
    }


@router.post("/scheduled-sends", response_model=None, status_code=201)
def create_scheduled_send(body: dict, db: Session = Depends(get_db)) -> dict:
    from datetime import datetime as _dt

    try:
        send_at = _dt.fromisoformat(str(body.get("send_at")).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="send_at must be ISO 8601") from exc
    account_id = str(body.get("account_id") or "")
    to_addrs = str(body.get("to_addrs") or "").strip()
    body_text = str(body.get("body_text") or "")
    if not account_id or not to_addrs or not body_text:
        raise HTTPException(status_code=422, detail="account_id, to_addrs, body_text required")
    s = GmailScheduledSend(
        account_id=account_id,
        to_addrs=to_addrs,
        cc_addrs=str(body.get("cc_addrs") or "") or None,
        bcc_addrs=str(body.get("bcc_addrs") or "") or None,
        subject=str(body.get("subject") or "") or None,
        body_text=body_text,
        reply_to_thread_id=str(body.get("reply_to_thread_id") or "") or None,
        send_at=send_at.replace(tzinfo=None) if send_at.tzinfo else send_at,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return _scheduled_response(s)


@router.get("/scheduled-sends", response_model=None)
def list_scheduled_sends(
    db: Session = Depends(get_db),
    status: str | None = Query(None),
    due: bool = Query(False, description="only rows whose send_at has passed"),
) -> dict:
    q = db.query(GmailScheduledSend)
    if status:
        q = q.filter(GmailScheduledSend.status == status)
    if due:
        q = q.filter(
            GmailScheduledSend.status == "pending", GmailScheduledSend.send_at <= _utcnow()
        )
    rows = q.order_by(GmailScheduledSend.send_at).all()
    return {"scheduled": [_scheduled_response(s) for s in rows]}


@router.patch("/scheduled-sends/{send_id}", response_model=None)
def update_scheduled_send(send_id: str, body: dict, db: Session = Depends(get_db)) -> dict:
    s = db.get(GmailScheduledSend, send_id)
    if not s:
        raise HTTPException(status_code=404, detail="Scheduled send not found")
    if "status" in body:
        s.status = str(body["status"])
    if "error" in body:
        s.error = str(body["error"] or "") or None
    if "sent_message_id" in body:
        s.sent_message_id = str(body["sent_message_id"] or "") or None
        s.sent_at = _utcnow()
    s.updated_at = _utcnow()
    db.commit()
    db.refresh(s)
    return _scheduled_response(s)


# ── Search ────────────────────────────────────────────────────────────────────


@router.post("/search", response_model=GmailSearchResponse)
def search_messages(body: GmailSearchRequest, db: Session = Depends(get_db)) -> GmailSearchResponse:
    q = body.q.strip()
    if not q:
        return GmailSearchResponse(messages=[], fts=False)
    limit = max(1, min(body.limit, 100))

    fts_ok = ensure_fts(db.get_bind())
    if fts_ok:
        match = fts_query_string(q)
        if match:
            try:
                rows = (
                    db.query(GmailMessage)
                    .from_statement(
                        text(
                            "SELECT gm.* FROM gmail_messages gm "
                            "JOIN gmail_messages_fts f ON f.rowid = gm.rowid "
                            "WHERE gmail_messages_fts MATCH :match "
                            "ORDER BY gm.internal_date DESC LIMIT :limit"
                        ).bindparams(match=match, limit=limit)
                    )
                    .all()
                )
                return GmailSearchResponse(
                    messages=[_message_response(r) for r in rows], fts=True
                )
            except Exception as exc:  # noqa: BLE001 — corrupt index etc.; fall back
                logger.warning("Gmail FTS query failed, using LIKE: %s", exc)

    like = f"%{q}%"
    rows = (
        db.query(GmailMessage)
        .filter(
            or_(
                GmailMessage.subject.ilike(like),
                GmailMessage.from_addr.ilike(like),
                GmailMessage.to_addrs.ilike(like),
                GmailMessage.snippet.ilike(like),
                GmailMessage.body_text.ilike(like),
            )
        )
        .order_by(GmailMessage.internal_date.desc())
        .limit(limit)
        .all()
    )
    return GmailSearchResponse(messages=[_message_response(r) for r in rows], fts=False)
