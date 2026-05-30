"""HTTP surface for the Supabase sync engine.

The Electron main process drives these: it holds the (encrypted, device-local)
connection string and POSTs the decrypted URL to /connect to start syncing, and
the renderer polls /status for the sync indicator.
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel

from . import runtime
from .seed import seed_outbox

log = logging.getLogger(__name__)

router = APIRouter(prefix="/cloud-sync", tags=["cloud-sync"])


class ConnectRequest(BaseModel):
    db_url: str
    supabase_url: str | None = None
    supabase_key: str | None = None
    storage_bucket: str | None = None
    interval_s: float | None = None
    seed: bool = False  # enqueue all existing local rows for the first push


class TestRequest(BaseModel):
    db_url: str


@router.get("/status")
def get_status():
    return runtime.status()


@router.post("/test")
def test_connection(req: TestRequest):
    """Validate a Postgres connection string (SELECT 1) + ensure the mirror schema.

    Run before saving a connection so the connect modal can show a clear error
    instead of failing silently in the background worker.
    """
    from sqlalchemy import text

    from database import build_engine

    from .schema import ensure_remote_schema

    try:
        eng = build_engine(req.db_url)
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
        ensure_remote_schema(eng)
        eng.dispose()
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@router.post("/connect")
def connect(req: ConnectRequest):
    if req.seed:
        # First connect: push everything already in the local DB.
        count = seed_outbox()
        log.info("Cloud sync seed enqueued %d rows", count)
    storage = runtime.build_storage(req.supabase_url, req.supabase_key, req.storage_bucket)
    runtime.start_sync(req.db_url, storage=storage, interval_s=req.interval_s or 20.0)
    return runtime.status()


@router.post("/disconnect")
def disconnect():
    runtime.stop_sync()
    return runtime.status()


@router.post("/trigger")
def trigger():
    worker = runtime.get_worker()
    if worker is not None:
        worker.trigger()
    return runtime.status()
