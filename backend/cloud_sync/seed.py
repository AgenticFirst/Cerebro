"""First-connect seeding: enqueue every existing local row for the initial push.

When a user connects an empty Supabase project, the outbox is empty (capture was
off), so nothing would sync. seed_outbox() walks the synced tables and writes one
``insert`` outbox row per existing record; the normal worker push then drains
them to Supabase. Idempotent-ish: safe to re-run (it appends; the push upserts).
"""

import json
import logging

import database
from models import SyncOutbox

from .config import PK_COLUMN, SYNCED_TABLES, is_local_only_setting
from .outbox import _serialize
from .worker import MODEL_BY_TABLE

log = logging.getLogger(__name__)


def _session_local():
    """Resolve the live ``SessionLocal`` from the database module.

    This module is imported (and its globals bound) *before*
    ``database.init_db()`` runs, when ``database.SessionLocal`` is still
    ``None``. Reading it through the module at call time — rather than via a
    ``from database import SessionLocal`` that captures the stale ``None`` —
    guarantees we get the real sessionmaker once init has happened. Without
    this, ``seed_outbox`` saw ``None`` and returned 0, seeding nothing on a
    first connect. See issue #14.
    """
    return database.SessionLocal


def seed_outbox() -> int:
    SessionLocal = _session_local()
    if SessionLocal is None:
        return 0
    s = SessionLocal()
    s.info["cloud_sync_apply"] = True  # adding outbox rows must not re-capture
    count = 0
    try:
        for table in SYNCED_TABLES:
            model = MODEL_BY_TABLE[table]
            pk = PK_COLUMN[table]
            for obj in s.query(model).yield_per(500):
                pk_val = getattr(obj, pk)
                if table == "settings" and is_local_only_setting(str(pk_val)):
                    continue
                s.add(
                    SyncOutbox(
                        table_name=table,
                        row_pk=str(pk_val),
                        op="insert",
                        payload_json=json.dumps(_serialize(obj), default=str),
                    )
                )
                count += 1
            s.commit()
        return count
    finally:
        s.close()
