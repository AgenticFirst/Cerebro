"""First-connect seeding: enqueue every existing local row for the initial push.

When a user connects an empty Supabase project, the outbox is empty (capture was
off), so nothing would sync. seed_outbox() walks the synced tables and writes one
``insert`` outbox row per existing record; the normal worker push then drains
them to Supabase. Idempotent-ish: safe to re-run (it appends; the push upserts).
"""

import json
import logging

from database import SessionLocal
from models import SyncOutbox

from .config import PK_COLUMN, SYNCED_TABLES, is_local_only_setting
from .outbox import _serialize
from .worker import MODEL_BY_TABLE

log = logging.getLogger(__name__)


def seed_outbox() -> int:
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
