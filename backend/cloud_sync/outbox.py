"""Capture local row changes into the sync outbox.

A single SQLAlchemy ``before_flush`` listener on the Session class records every
insert/update/delete on a synced table as a ``SyncOutbox`` row in the *same*
transaction, so the change and its outbox entry commit atomically. Capture is
gated by ``set_sync_enabled`` — when no Supabase project is connected it is a
no-op, so single-device installs never accumulate outbox rows.
"""

import json
import logging
from datetime import datetime

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from models import SyncOutbox

from .config import PK_COLUMN, SYNCED_TABLE_SET, is_local_only_setting

log = logging.getLogger(__name__)

_enabled = False


def set_sync_enabled(value: bool) -> None:
    """Turn outbox capture on (Supabase connected) or off (local-only)."""
    global _enabled
    _enabled = bool(value)


def is_sync_enabled() -> bool:
    return _enabled


def _eval_default(d):
    """Evaluate a SQLAlchemy column default/onupdate to its Python value."""
    if d is None:
        return None
    if getattr(d, "is_scalar", False):
        return d.arg
    if getattr(d, "is_callable", False):
        fn = d.arg
        try:
            return fn(None)  # context-style callables
        except TypeError:
            return fn()  # zero-arg callables (_utcnow, _uuid_hex)
    return None


def _materialize(obj, op: str) -> None:
    """Apply Python-side defaults eagerly so the captured row matches the DB row.

    ``before_flush`` runs before column defaults/onupdate values are generated,
    so a freshly added row's ``id``/``created_at``/scalar defaults are still
    None. We fill them here (and refresh ``onupdate`` columns on update); because
    the attributes are now set explicitly, the subsequent INSERT/UPDATE uses the
    very same values — keeping the outbox payload and the persisted row identical.
    """
    mapper = inspect(obj).mapper
    for col in mapper.columns:
        if op == "insert" and getattr(obj, col.key) is None and col.default is not None:
            setattr(obj, col.key, _eval_default(col.default))
        elif op == "update" and col.onupdate is not None:
            setattr(obj, col.key, _eval_default(col.onupdate))


def _serialize(obj) -> dict:
    """Row → JSON-able dict keyed by column name (datetimes as ISO strings)."""
    mapper = inspect(obj).mapper
    out: dict = {}
    for col in mapper.columns:
        val = getattr(obj, col.key)
        if isinstance(val, datetime):
            val = val.isoformat()
        out[col.name] = val
    return out


def _record(session: Session, obj, op: str) -> None:
    table = getattr(obj, "__tablename__", None)
    if table not in SYNCED_TABLE_SET:
        return
    if op != "delete":
        _materialize(obj, op)
    pk_val = getattr(obj, PK_COLUMN[table])
    if table == "settings" and is_local_only_setting(str(pk_val)):
        return
    payload = None if op == "delete" else json.dumps(_serialize(obj), default=str)
    session.add(
        SyncOutbox(table_name=table, row_pk=str(pk_val), op=op, payload_json=payload)
    )


@event.listens_for(Session, "before_flush")
def _capture(session: Session, flush_context, instances) -> None:
    if not _enabled:
        return
    # Changes the sync worker applies from the remote must not be re-captured,
    # or they would echo straight back to Supabase in an endless loop.
    if session.info.get("cloud_sync_apply"):
        return
    # Snapshot first: _record() adds SyncOutbox rows to the session, which would
    # otherwise mutate session.new mid-iteration.
    pending: list[tuple[object, str]] = []
    for obj in list(session.new):
        pending.append((obj, "insert"))
    for obj in list(session.dirty):
        if session.is_modified(obj, include_collections=False):
            pending.append((obj, "update"))
    for obj in list(session.deleted):
        pending.append((obj, "delete"))

    for obj, op in pending:
        try:
            _record(session, obj, op)
        except Exception:  # noqa: BLE001 — capture must never break a real write
            log.exception("sync outbox capture failed for %r", obj)
