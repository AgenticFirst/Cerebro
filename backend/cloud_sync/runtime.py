"""Process-wide handle to the running SyncWorker.

Because the local SQLite stays the app's working store, connecting Supabase does
not re-point any engine — it just starts this background worker. So sync can be
turned on/off at runtime (no backend restart) via start_sync / stop_sync.
"""

import logging

from .storage import SupabaseStorage
from .worker import SyncWorker

log = logging.getLogger(__name__)

_worker: SyncWorker | None = None
_files_dir: str | None = None

DISABLED_STATUS = {"status": "disabled", "last_synced_at": None, "last_error": None, "pending": 0}


def configure(files_dir: str | None) -> None:
    """Set process-wide paths the worker needs (called once at startup)."""
    global _files_dir
    _files_dir = files_dir


def build_storage(project_url: str | None, key: str | None, bucket: str | None):
    if project_url and key and bucket:
        return SupabaseStorage(project_url, key, bucket)
    return None


def start_sync(
    remote_url: str,
    storage=None,
    interval_s: float = 20.0,
) -> None:
    """(Re)start the sync worker pointed at the given Supabase Postgres URL."""
    global _worker
    if _worker is not None:
        _worker.stop()
        _worker = None
    if not remote_url:
        return
    _worker = SyncWorker(
        remote_url, storage=storage, files_dir=_files_dir, interval_s=interval_s
    )
    _worker.start()


def stop_sync() -> None:
    global _worker
    if _worker is not None:
        _worker.stop()
        _worker = None


def get_worker() -> SyncWorker | None:
    return _worker


def status() -> dict:
    if _worker is None:
        return dict(DISABLED_STATUS)
    return _worker.snapshot()
