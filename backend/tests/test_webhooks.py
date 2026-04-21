"""Tests for the webhook listener router — /webhooks/*.

Covers the lifecycle a routine's `wait_for_webhook` step depends on:
register → poll → receive → cleanup, plus the failure modes the frontend
action relies on (404 for expired/unknown listeners, 409 on double-post,
429 when listeners cap is hit).
"""

from __future__ import annotations

import time

import pytest


def _register(client, **overrides):
    body = {
        "match_path": "",
        "timeout": 3600,
        "description": "",
        **overrides,
    }
    r = client.post("/webhooks/listen", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── Register + Status ───────────────────────────────────────────


def test_register_returns_listener_id_and_endpoint(client):
    data = _register(client, description="test-1")
    assert data["listener_id"]
    assert len(data["listener_id"]) == 16  # matches uuid4().hex[:16]
    assert data["endpoint_url"].endswith(f"/webhooks/catch/{data['listener_id']}")
    assert data["created_at"]  # ISO timestamp


def test_status_before_payload_returns_unreceived(client):
    lid = _register(client)["listener_id"]
    r = client.get(f"/webhooks/catch/{lid}/status")
    assert r.status_code == 200
    body = r.json()
    assert body["received"] is False
    assert body["payload"] is None
    assert body["headers"] is None
    assert body["received_at"] is None


def test_status_unknown_listener_returns_404(client):
    r = client.get("/webhooks/catch/doesnotexist1234/status")
    assert r.status_code == 404


# ── Payload capture ─────────────────────────────────────────────


def test_post_payload_captured_and_surfaced_in_status(client):
    lid = _register(client)["listener_id"]

    # Post a JSON body to the catch endpoint
    r = client.post(
        f"/webhooks/catch/{lid}",
        json={"event": "order.created", "amount": 42},
    )
    assert r.status_code == 200
    assert r.json() == {"status": "received", "listener_id": lid}

    # Polling now reveals the payload
    r = client.get(f"/webhooks/catch/{lid}/status")
    body = r.json()
    assert body["received"] is True
    assert body["payload"] == {"event": "order.created", "amount": 42}
    assert isinstance(body["headers"], dict)
    assert body["received_at"] is not None


def test_non_json_body_captured_as_raw(client):
    lid = _register(client)["listener_id"]

    r = client.post(
        f"/webhooks/catch/{lid}",
        content=b"just a plain text body",
        headers={"Content-Type": "text/plain"},
    )
    assert r.status_code == 200

    r = client.get(f"/webhooks/catch/{lid}/status")
    body = r.json()
    assert body["received"] is True
    assert body["payload"] == {"raw": "just a plain text body"}


def test_double_post_returns_409(client):
    lid = _register(client)["listener_id"]

    r1 = client.post(f"/webhooks/catch/{lid}", json={"first": True})
    assert r1.status_code == 200

    r2 = client.post(f"/webhooks/catch/{lid}", json={"second": True})
    assert r2.status_code == 409
    assert "already received" in r2.json()["detail"].lower()

    # The *first* payload is the one that was retained
    r = client.get(f"/webhooks/catch/{lid}/status")
    assert r.json()["payload"] == {"first": True}


def test_post_to_unknown_listener_returns_404(client):
    r = client.post("/webhooks/catch/doesnotexist1234", json={"x": 1})
    assert r.status_code == 404


# ── Cleanup / Delete ────────────────────────────────────────────


def test_delete_removes_listener(client):
    lid = _register(client)["listener_id"]

    r = client.delete(f"/webhooks/listen/{lid}")
    assert r.status_code == 204

    # Status poll now 404s — confirms cleanup
    r = client.get(f"/webhooks/catch/{lid}/status")
    assert r.status_code == 404


def test_delete_unknown_listener_is_idempotent(client):
    # Action layer fires-and-forgets DELETE; it must not 500 on unknown IDs.
    r = client.delete("/webhooks/listen/unknownxyz123456")
    assert r.status_code == 204


# ── Capacity ────────────────────────────────────────────────────


def test_max_listeners_cap(client):
    from webhooks.router import MAX_ACTIVE_LISTENERS, active_listeners

    active_listeners.clear()  # ensure clean slate for this test

    try:
        # Fill up to the cap
        for _ in range(MAX_ACTIVE_LISTENERS):
            r = client.post("/webhooks/listen", json={})
            assert r.status_code == 200

        # One more should be rejected
        r = client.post("/webhooks/listen", json={})
        assert r.status_code == 429
        assert "too many" in r.json()["detail"].lower()
    finally:
        active_listeners.clear()


# ── Expiry ──────────────────────────────────────────────────────


def test_expired_listener_is_swept_on_next_access(client):
    from webhooks.router import active_listeners

    active_listeners.clear()

    # Register with a tiny timeout, then force its expires_at into the past.
    lid = _register(client, timeout=1)["listener_id"]
    active_listeners[lid].expires_at = time.time() - 1

    # Next access triggers _cleanup_expired → listener is gone
    r = client.get(f"/webhooks/catch/{lid}/status")
    assert r.status_code == 404
    assert lid not in active_listeners


# ── Match path ──────────────────────────────────────────────────


def test_match_path_is_echoed_in_register_response(client):
    data = _register(client, match_path="/stripe")
    assert data["match_path"] == "/stripe"


# ── List endpoint ───────────────────────────────────────────────


def test_list_listeners_returns_current_registry(client):
    # Observability endpoint: surfaces the in-memory listener set so tests
    # and a future Ops panel can see what's live without poking internals.
    from webhooks.router import active_listeners

    active_listeners.clear()

    a = _register(client, match_path="/a", description="first")["listener_id"]
    b = _register(client, match_path="/b", description="second")["listener_id"]

    r = client.get("/webhooks/listen")
    assert r.status_code == 200
    body = r.json()

    # Shape: {"listeners": [{listener_id, match_path, description, received, created_at}, ...]}
    listeners = body["listeners"]
    assert isinstance(listeners, list)
    ids = {l["listener_id"] for l in listeners}
    assert a in ids
    assert b in ids

    # Each entry carries the fields the UI / e2e tests rely on.
    by_id = {l["listener_id"]: l for l in listeners}
    assert by_id[a]["match_path"] == "/a"
    assert by_id[a]["description"] == "first"
    assert by_id[a]["received"] is False
    assert by_id[a]["created_at"]


def test_list_listeners_excludes_expired(client):
    # _cleanup_expired runs on every access; the list must not surface
    # listeners past their TTL even if we never hit them directly.
    from webhooks.router import active_listeners

    active_listeners.clear()

    lid = _register(client, timeout=1)["listener_id"]
    active_listeners[lid].expires_at = time.time() - 1

    r = client.get("/webhooks/listen")
    assert r.status_code == 200
    ids = {l["listener_id"] for l in r.json()["listeners"]}
    assert lid not in ids
