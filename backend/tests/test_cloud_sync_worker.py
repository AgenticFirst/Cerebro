"""Regression tests for the cloud sync worker's session handling.

The worker runs in a daemon thread that is constructed and ticked *after*
``database.init_db()`` has bound the real ``SessionLocal``. The worker must
therefore resolve ``SessionLocal`` at call time, not capture the (still-None)
value that exists at import. See issue #13.
"""

import pytest

import database
import cloud_sync.worker as worker_mod
from cloud_sync.worker import SyncWorker
from models import SyncOutbox

# A URL that points nowhere — the pull path under test never opens a remote
# connection before it first touches the *local* session, so an unreachable
# host is fine for exercising _get_cursor().
DEAD_REMOTE_URL = "postgresql+psycopg://x@127.0.0.1:1/db"


def test_worker_resolves_live_session_local(client):
    """The worker must use database's live SessionLocal, not a stale import.

    ``client`` has already run ``init_db``, so ``database.SessionLocal`` is a
    real sessionmaker. If the worker captured the module-level value at import
    time it would still be ``None`` here.
    """
    assert database.SessionLocal is not None
    assert worker_mod._session_local() is database.SessionLocal


def test_worker_pull_can_acquire_session(client):
    """_get_cursor() must open a local session without raising TypeError.

    Before the fix this raised ``TypeError: 'NoneType' object is not callable``
    because ``SessionLocal()`` was called on the stale ``None`` captured at
    import. On a fresh DB there is no cursor row yet, so it returns ``None``.
    """
    worker = SyncWorker(DEAD_REMOTE_URL)
    assert worker._get_cursor() is None


def test_pending_count_reflects_outbox(client):
    """snapshot()/_pending_count() must count real pending outbox rows.

    Regression for issue #16: ``_pending_count`` previously read a stale
    module-level ``SessionLocal`` and returned 0 unconditionally, so the UI
    showed pending=0 even with unsynced rows sitting in the outbox.
    """
    s = database.SessionLocal()
    s.add(SyncOutbox(table_name="experts", row_pk="z", op="insert", payload_json="{}"))
    s.commit()
    s.close()

    worker = SyncWorker(DEAD_REMOTE_URL)
    assert worker._pending_count() == 1


def test_push_surfaces_descriptive_error_when_session_uninitialized(client, monkeypatch):
    """A failed push must report *why* it failed, not an empty message.

    Regression for issue #16: ``_push`` guarded its session with a bare
    ``assert SessionLocal is not None``. When the session was unavailable that
    raised ``AssertionError('')`` — an empty-message error that the run loop
    stored verbatim as ``last_error``, leaving the UI showing 'offline' with no
    reason. The worker must instead raise an error whose message is non-empty.
    """
    monkeypatch.setattr(database, "SessionLocal", None)
    worker = SyncWorker(DEAD_REMOTE_URL)

    with pytest.raises(Exception) as excinfo:
        worker._push()

    assert str(excinfo.value).strip(), "push failure must carry a descriptive message"
