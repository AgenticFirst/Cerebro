"""Regression tests for the cloud sync push worker.

cloud_sync/worker.py used to do `from database import SessionLocal` at module
import time. Because the worker module is imported (via main.py) *before*
init_db() rebinds database.SessionLocal, the worker's copy stayed None forever
and SyncWorker._push() raised AssertionError on its first tick — the push half
of sync never ran. These tests pin the worker to the live session factory.
"""

import database
import cloud_sync.worker as worker_mod
from cloud_sync.worker import SyncWorker
from models import SyncOutbox

# An unreachable remote — we never actually connect; we only drive the local
# session-factory plumbing that runs before any remote interaction.
DEAD_REMOTE = "postgresql+psycopg://x@127.0.0.1:1/db"


def test_worker_uses_live_session_factory(client):
    """The worker must read the session factory that init_db() installed, not a
    stale None captured at import time."""
    # `client` fixture has already called init_db(), so the live factory exists.
    assert database.SessionLocal is not None

    s = database.SessionLocal()
    s.add(SyncOutbox(table_name="experts", row_pk="z", op="insert", payload_json="{}"))
    s.commit()
    s.close()

    worker = SyncWorker(DEAD_REMOTE)
    # Stale import-time copy returned 0 here (it saw SessionLocal is None).
    assert worker._pending_count() == 1


def test_push_drains_outbox_without_assertion(client):
    """_push() must reach the live session and the pending rows — not blow up on
    `assert SessionLocal is not None` before any remote call."""
    s = database.SessionLocal()
    s.add(SyncOutbox(table_name="experts", row_pk="a", op="insert", payload_json="{}"))
    s.commit()
    s.close()

    worker = SyncWorker(DEAD_REMOTE)
    # A live remote engine isn't available in the test; substitute a stub whose
    # .begin() records that we got past the session/outbox query. Before the fix
    # _push() raised AssertionError *before* ever touching remote_engine.
    reached_remote = {"yes": False}

    class _StubConn:
        def __enter__(self):
            reached_remote["yes"] = True
            raise RuntimeError("stop here — we only assert we got past the session")

        def __exit__(self, *a):
            return False

    class _StubEngine:
        def begin(self):
            return _StubConn()

    worker.remote_engine = _StubEngine()
    try:
        worker._push()
    except AssertionError:
        raise AssertionError("_push() raised AssertionError: SessionLocal was stale None")
    except RuntimeError:
        pass  # expected — we deliberately stopped inside the remote block

    assert reached_remote["yes"], "_push() never reached the remote block"
