"""Calendar store + sync-config invariants.

Covers the normalized CRUD/window-query path the Electron bridge writes to, plus
the two non-negotiable replication rules from the integration design:
  - calendar_events / calendar_accounts replicate to Supabase
  - calendar_ token settings + calendar_sync_state stay device-local
"""

from cloud_sync.config import (
    SYNCED_TABLES,
    LOCAL_ONLY_TABLES,
    is_local_only_setting,
)


def test_sync_classification():
    # Events + account metadata replicate.
    assert "calendar_events" in SYNCED_TABLES
    assert "calendar_accounts" in SYNCED_TABLES
    # Per-device cursors never leave the device.
    assert "calendar_sync_state" in LOCAL_ONLY_TABLES
    # OAuth client secrets + tokens never leave the device.
    assert is_local_only_setting("calendar_abc_access_token")
    assert is_local_only_setting("calendar_abc_refresh_token")
    assert is_local_only_setting("calendar_abc_client_secret")
    assert is_local_only_setting("calendar_accounts_index")
    # A normal synced setting is not flagged local-only.
    assert not is_local_only_setting("selected_model")


def _make_account(client, provider="google", email="a@b.com"):
    r = client.post(
        "/calendar/accounts",
        json={
            "provider": provider,
            "email": email,
            "calendars": [{"id": "primary", "name": "Primary", "color": "#06B6D4", "selected": True}],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_account_crud(client):
    acc = _make_account(client)
    assert acc["provider"] == "google"
    assert acc["calendars"][0]["id"] == "primary"

    listed = client.get("/calendar/accounts").json()["accounts"]
    assert len(listed) == 1

    patched = client.patch(f"/calendar/accounts/{acc['id']}", json={"status": "token_expired", "last_error": "boom"})
    assert patched.status_code == 200
    assert patched.json()["status"] == "token_expired"

    assert client.delete(f"/calendar/accounts/{acc['id']}").status_code == 204
    assert client.get("/calendar/accounts").json()["accounts"] == []


def test_event_sync_upsert_window_and_tombstone(client):
    acc = _make_account(client)
    aid = acc["id"]

    # Provider pull: upsert one event.
    batch = {
        "account_id": aid,
        "upserts": [
            {
                "calendar_id": "primary",
                "provider_event_id": "evt1",
                "title": "Standup",
                "start_utc": "2026-06-03T09:00:00+00:00",
                "end_utc": "2026-06-03T09:30:00+00:00",
                "start_tz": "America/New_York",
            }
        ],
        "deletions": [],
    }
    assert client.post("/calendar/events/sync", json=batch).status_code == 200

    # Window query returns it.
    win = client.get(
        "/calendar/events",
        params={"start": "2026-06-03T00:00:00+00:00", "end": "2026-06-04T00:00:00+00:00"},
    ).json()["events"]
    assert len(win) == 1
    assert win[0]["title"] == "Standup"

    # Idempotent re-upsert (same provider id) does not duplicate.
    client.post("/calendar/events/sync", json=batch)
    win2 = client.get(
        "/calendar/events",
        params={"start": "2026-06-03T00:00:00+00:00", "end": "2026-06-04T00:00:00+00:00"},
    ).json()["events"]
    assert len(win2) == 1

    # Tombstone (remote cancel) drops it from the default (confirmed-only) window.
    client.post("/calendar/events/sync", json={"account_id": aid, "upserts": [], "deletions": ["evt1"]})
    win3 = client.get(
        "/calendar/events",
        params={"start": "2026-06-03T00:00:00+00:00", "end": "2026-06-04T00:00:00+00:00"},
    ).json()["events"]
    assert win3 == []


def test_local_event_is_on_device_and_never_pushed(client):
    """The built-in local calendar works without any connected provider."""
    created = client.post(
        "/calendar/events",
        json={"title": "Dentist", "start_utc": "2026-06-03T14:00:00+00:00", "end_utc": "2026-06-03T15:00:00+00:00"},
    ).json()
    assert created["sync_status"] == "local"
    assert created["origin"] == "cerebro"
    assert created["provider_event_id"] is None
    eid = created["id"]

    # A local account was auto-created (provider 'local').
    accounts = client.get("/calendar/accounts").json()["accounts"]
    assert any(a["provider"] == "local" for a in accounts)

    # Local events are never queued for a provider push.
    pending = client.get("/calendar/events/pending").json()["events"]
    assert all(e["id"] != eid for e in pending)

    # Editing keeps it local (not flipped to pending_push).
    patched = client.patch(f"/calendar/events/{eid}", json={"title": "Dentist (rescheduled)"}).json()
    assert patched["sync_status"] == "local"
    assert patched["title"] == "Dentist (rescheduled)"

    # Deleting a never-pushed local event removes it outright.
    client.delete(f"/calendar/events/{eid}")
    win = client.get(
        "/calendar/events",
        params={"start": "2026-06-01T00:00:00+00:00", "end": "2026-06-30T00:00:00+00:00", "include_cancelled": "true"},
    ).json()["events"]
    assert all(e["id"] != eid for e in win)


def test_sync_state_upsert(client):
    acc = _make_account(client)
    r = client.put(
        "/calendar/sync-state",
        json={"account_id": acc["id"], "calendar_id": "primary", "sync_cursor": "tok123"},
    )
    assert r.status_code == 200
    assert r.json()["sync_cursor"] == "tok123"
    states = client.get("/calendar/sync-state", params={"account_id": acc["id"]}).json()["states"]
    assert states[0]["sync_cursor"] == "tok123"
