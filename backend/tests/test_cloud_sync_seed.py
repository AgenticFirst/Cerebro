"""Regression tests for first-connect seeding (``seed_outbox``).

First-connect seeding enqueues one outbox row per existing local record so the
initial push has something to drain. ``seed_outbox`` runs during the
``/cloud-sync/connect`` handler — *after* ``database.init_db()`` has bound the
real ``SessionLocal``. But the seed module is imported (and its globals bound)
*before* init, when ``database.SessionLocal`` is still ``None``. A
``from database import SessionLocal`` therefore captures that stale ``None`` and
``seed_outbox`` returns 0, silently seeding nothing. It must resolve
``SessionLocal`` at call time instead. See issue #14 (same family as #13/#16).
"""

import database
import cloud_sync.seed as seed_mod
from cloud_sync.seed import seed_outbox
from models import Setting, SyncOutbox


def test_seed_resolves_live_session_local(client):
    """Seeding must use database's live SessionLocal, not a stale import.

    ``client`` has already run ``init_db``, so ``database.SessionLocal`` is a
    real sessionmaker. Resolving through the database module guarantees we never
    read the ``None`` captured at import time.
    """
    assert database.SessionLocal is not None
    assert seed_mod._session_local() is database.SessionLocal


def test_seed_outbox_enqueues_existing_rows_with_stale_module_binding(client):
    """seed_outbox must enqueue existing rows even when the module-level
    ``SessionLocal`` was bound to ``None`` at import (the production case).

    Before the fix ``seed_outbox`` read its own module global, saw ``None``, and
    returned 0 — so a first connect with real local data seeded nothing.
    """
    # Seed a real local row that should be enqueued for the first push.
    s = database.SessionLocal()
    s.add(Setting(key="profile_name", value="Carlos"))
    s.commit()
    s.close()

    # Simulate the production import order: the seed module captured
    # ``SessionLocal`` as ``None`` before ``init_db`` ran. If a stale binding
    # like this still exists, reading it would yield 0.
    if hasattr(seed_mod, "SessionLocal"):
        seed_mod.SessionLocal = None

    count = seed_outbox()

    assert count >= 1, "seed_outbox must enqueue existing local rows"

    s = database.SessionLocal()
    try:
        outbox_rows = s.query(SyncOutbox).filter_by(table_name="settings").all()
        assert any(r.row_pk == "profile_name" for r in outbox_rows)
    finally:
        s.close()
