"""FastAPI router for webhook listener registry — /webhooks/* endpoints."""

from __future__ import annotations

import uuid
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response

from .schemas import (
    WebhookListenRequest,
    WebhookListenerResponse,
    WebhookListenerSummary,
    WebhookListListResponse,
    WebhookStatusResponse,
)

router = APIRouter(tags=["webhooks"])

# ── In-memory registry ─────────────────────────────────────────

class WebhookListener:
    def __init__(self, listener_id: str, match_path: str, timeout: int, description: str):
        self.listener_id = listener_id
        self.match_path = match_path
        self.timeout = timeout
        self.description = description
        self.created_at = datetime.now(timezone.utc)
        self.expires_at = time.time() + timeout
        self.received = False
        self.payload: dict | None = None
        self.headers: dict | None = None
        self.received_at: str | None = None


active_listeners: dict[str, WebhookListener] = {}

MAX_ACTIVE_LISTENERS = 100


def _cleanup_expired():
    """Remove expired listeners."""
    now = time.time()
    expired = [lid for lid, l in active_listeners.items() if now > l.expires_at]
    for lid in expired:
        del active_listeners[lid]


# ── Endpoints ──────────────────────────────────────────────────

@router.post("/listen", response_model=WebhookListenerResponse)
def register_listener(body: WebhookListenRequest, request: Request):
    """Register a temporary webhook listener. Returns listener_id + endpoint URL."""
    _cleanup_expired()

    if len(active_listeners) >= MAX_ACTIVE_LISTENERS:
        raise HTTPException(status_code=429, detail="Too many active webhook listeners")

    listener_id = uuid.uuid4().hex[:16]
    listener = WebhookListener(
        listener_id=listener_id,
        match_path=body.match_path,
        timeout=body.timeout,
        description=body.description,
    )
    active_listeners[listener_id] = listener

    # Build the endpoint URL using the request's base URL
    base_url = str(request.base_url).rstrip("/")
    endpoint_url = f"{base_url}/webhooks/catch/{listener_id}"

    return WebhookListenerResponse(
        listener_id=listener_id,
        endpoint_url=endpoint_url,
        match_path=body.match_path,
        timeout=body.timeout,
        created_at=listener.created_at.isoformat(),
    )


@router.get("/listen", response_model=WebhookListListResponse)
def list_listeners():
    """List active webhook listeners. Returns the current (non-expired) registry
    so callers — including e2e tests and a future Ops panel — can discover
    listener_ids without having to instrument registration."""
    _cleanup_expired()
    return WebhookListListResponse(
        listeners=[
            WebhookListenerSummary(
                listener_id=l.listener_id,
                match_path=l.match_path,
                description=l.description,
                received=l.received,
                created_at=l.created_at.isoformat(),
            )
            for l in active_listeners.values()
        ]
    )


@router.post("/catch/{listener_id}")
async def catch_webhook(listener_id: str, request: Request):
    """Receive an incoming webhook for a registered listener."""
    _cleanup_expired()

    listener = active_listeners.get(listener_id)
    if not listener:
        raise HTTPException(status_code=404, detail="Listener not found or expired")

    if listener.received:
        raise HTTPException(status_code=409, detail="Webhook already received")

    # Capture the payload
    try:
        payload = await request.json()
    except Exception:
        body = await request.body()
        payload = {"raw": body.decode("utf-8", errors="replace")}

    listener.received = True
    listener.payload = payload
    listener.headers = dict(request.headers)
    listener.received_at = datetime.now(timezone.utc).isoformat()

    return {"status": "received", "listener_id": listener_id}


@router.get("/catch/{listener_id}/status", response_model=WebhookStatusResponse)
def check_listener_status(listener_id: str):
    """Poll for received webhook payload."""
    _cleanup_expired()

    listener = active_listeners.get(listener_id)
    if not listener:
        raise HTTPException(status_code=404, detail="Listener not found or expired")

    return WebhookStatusResponse(
        received=listener.received,
        payload=listener.payload,
        headers=listener.headers,
        received_at=listener.received_at,
    )


@router.delete("/listen/{listener_id}", status_code=204)
def delete_listener(listener_id: str):
    """Cleanup a cancelled listener."""
    active_listeners.pop(listener_id, None)
    return Response(status_code=204)
