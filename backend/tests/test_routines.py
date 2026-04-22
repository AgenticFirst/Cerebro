"""Tests for routine CRUD endpoints."""

import json
import uuid


def _hex_id() -> str:
    return uuid.uuid4().hex


# ── Basic CRUD ───────────────────────────────────────────────────


def test_list_routines_empty(client):
    r = client.get("/routines")
    assert r.status_code == 200
    body = r.json()
    assert body["routines"] == []
    assert body["total"] == 0


def test_create_routine_minimal(client):
    r = client.post("/routines", json={
        "name": "Morning Prep",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Morning Prep"
    assert body["description"] == ""
    assert body["trigger_type"] == "manual"
    assert body["is_enabled"] is True
    assert body["source"] == "user"
    assert body["run_count"] == 0
    assert body["plain_english_steps"] is None
    assert body["dag_json"] is None
    assert body["cron_expression"] is None
    assert body["default_runner_id"] is None
    assert body["approval_gates"] is None
    assert body["required_connections"] is None
    assert body["last_run_at"] is None
    assert body["last_run_status"] is None
    assert "id" in body
    assert "created_at" in body
    assert "updated_at" in body


def test_get_routine(client):
    r = client.post("/routines", json={"name": "Daily Review"})
    routine_id = r.json()["id"]

    r = client.get(f"/routines/{routine_id}")
    assert r.status_code == 200
    assert r.json()["name"] == "Daily Review"
    assert r.json()["id"] == routine_id


def test_delete_routine(client):
    r = client.post("/routines", json={"name": "Temp Routine"})
    routine_id = r.json()["id"]

    r = client.delete(f"/routines/{routine_id}")
    assert r.status_code == 204

    r = client.get(f"/routines/{routine_id}")
    assert r.status_code == 404


def test_list_routines_returns_created(client):
    client.post("/routines", json={"name": "Alpha"})
    client.post("/routines", json={"name": "Beta"})

    r = client.get("/routines")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert len(body["routines"]) == 2


# ── Full Fields ──────────────────────────────────────────────────


def test_create_routine_with_all_fields(client):
    # Create an expert first to use as default runner
    expert_resp = client.post("/experts", json={
        "name": "Morning Bot",
        "description": "Handles morning routine",
    })
    expert_id = expert_resp.json()["id"]

    dag = {"steps": [{"id": "s1", "name": "Fetch cal", "actionType": "model_call"}]}

    r = client.post("/routines", json={
        "name": "Morning Routine",
        "description": "Prepares my day every weekday morning",
        "plain_english_steps": ["Pull calendar events", "Check todo backlog", "Draft plan"],
        "dag_json": json.dumps(dag),
        "trigger_type": "cron",
        "cron_expression": "0 9 * * 1-5",
        "default_runner_id": expert_id,
        "approval_gates": ["send_email", "update_calendar"],
        "required_connections": ["google_calendar", "gmail"],
        "source": "chat",
        "source_conversation_id": None,
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Morning Routine"
    assert body["description"] == "Prepares my day every weekday morning"
    assert body["plain_english_steps"] == ["Pull calendar events", "Check todo backlog", "Draft plan"]
    assert json.loads(body["dag_json"]) == dag
    assert body["trigger_type"] == "cron"
    assert body["cron_expression"] == "0 9 * * 1-5"
    assert body["default_runner_id"] == expert_id
    assert body["approval_gates"] == ["send_email", "update_calendar"]
    assert body["required_connections"] == ["google_calendar", "gmail"]
    assert body["source"] == "chat"
    assert body["is_enabled"] is True
    assert body["run_count"] == 0


def test_json_fields_round_trip(client):
    """Verify JSON list fields survive serialization and deserialization."""
    steps = ["Step one", "Step two", "Step three"]
    gates = ["approval_step"]
    connections = ["notion", "slack"]

    r = client.post("/routines", json={
        "name": "JSON Test",
        "plain_english_steps": steps,
        "approval_gates": gates,
        "required_connections": connections,
    })
    assert r.status_code == 201
    routine_id = r.json()["id"]

    # Verify via GET
    r = client.get(f"/routines/{routine_id}")
    body = r.json()
    assert body["plain_english_steps"] == steps
    assert body["approval_gates"] == gates
    assert body["required_connections"] == connections


# ── Partial Update ───────────────────────────────────────────────


def test_patch_updates_only_sent_fields(client):
    r = client.post("/routines", json={
        "name": "Original",
        "description": "Original description",
        "trigger_type": "manual",
    })
    routine_id = r.json()["id"]

    r = client.patch(f"/routines/{routine_id}", json={"name": "Updated Name"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Updated Name"
    assert body["description"] == "Original description"
    assert body["trigger_type"] == "manual"


def test_patch_toggle_enabled(client):
    r = client.post("/routines", json={"name": "Toggleable"})
    routine_id = r.json()["id"]
    assert r.json()["is_enabled"] is True

    r = client.patch(f"/routines/{routine_id}", json={"is_enabled": False})
    assert r.status_code == 200
    assert r.json()["is_enabled"] is False

    # Toggle back
    r = client.patch(f"/routines/{routine_id}", json={"is_enabled": True})
    assert r.json()["is_enabled"] is True


def test_patch_update_trigger(client):
    r = client.post("/routines", json={"name": "Schedule Me"})
    routine_id = r.json()["id"]
    assert r.json()["trigger_type"] == "manual"

    r = client.patch(f"/routines/{routine_id}", json={
        "trigger_type": "cron",
        "cron_expression": "30 8 * * *",
    })
    assert r.status_code == 200
    assert r.json()["trigger_type"] == "cron"
    assert r.json()["cron_expression"] == "30 8 * * *"


def test_patch_update_steps(client):
    r = client.post("/routines", json={
        "name": "Evolving",
        "plain_english_steps": ["Step A"],
    })
    routine_id = r.json()["id"]

    r = client.patch(f"/routines/{routine_id}", json={
        "plain_english_steps": ["Step A", "Step B", "Step C"],
    })
    assert r.status_code == 200
    assert r.json()["plain_english_steps"] == ["Step A", "Step B", "Step C"]


def test_patch_update_dag_json(client):
    r = client.post("/routines", json={"name": "DAG Update"})
    routine_id = r.json()["id"]
    assert r.json()["dag_json"] is None

    dag = {"steps": [{"id": "s1", "name": "Test", "actionType": "transformer"}]}
    r = client.patch(f"/routines/{routine_id}", json={
        "dag_json": json.dumps(dag),
    })
    assert r.status_code == 200
    assert json.loads(r.json()["dag_json"]) == dag


# ── Run Endpoint ─────────────────────────────────────────────────


def test_run_increments_count(client):
    r = client.post("/routines", json={"name": "Runnable"})
    routine_id = r.json()["id"]
    assert r.json()["run_count"] == 0
    assert r.json()["last_run_at"] is None

    r = client.post(f"/routines/{routine_id}/run")
    assert r.status_code == 200
    body = r.json()
    assert body["run_count"] == 1
    assert body["last_run_at"] is not None

    # Second run
    r = client.post(f"/routines/{routine_id}/run")
    assert r.json()["run_count"] == 2


def test_run_disabled_routine_returns_400(client):
    r = client.post("/routines", json={"name": "Disabled"})
    routine_id = r.json()["id"]

    client.patch(f"/routines/{routine_id}", json={"is_enabled": False})

    r = client.post(f"/routines/{routine_id}/run")
    assert r.status_code == 400
    assert "disabled" in r.json()["detail"].lower()


def test_run_nonexistent_routine_returns_404(client):
    r = client.post(f"/routines/{_hex_id()}/run")
    assert r.status_code == 404


# ── Filters ──────────────────────────────────────────────────────


def test_filter_by_trigger_type(client):
    client.post("/routines", json={"name": "Manual", "trigger_type": "manual"})
    client.post("/routines", json={"name": "Cron", "trigger_type": "cron", "cron_expression": "0 9 * * *"})
    client.post("/routines", json={"name": "Webhook", "trigger_type": "webhook"})

    r = client.get("/routines", params={"trigger_type": "cron"})
    body = r.json()
    assert body["total"] == 1
    assert body["routines"][0]["name"] == "Cron"


def test_create_routine_with_telegram_message_trigger(client):
    """trigger_type='telegram_message' is accepted, persisted, and round-trips
    via GET so the bridge's poll for matching routines can find it."""
    dag = {
        "trigger": {
            "triggerType": "trigger_telegram_message",
            "config": {"chat_id": "*", "filter_type": "keyword", "filter_value": "standup"},
        },
        "steps": [],
    }
    r = client.post("/routines", json={
        "name": "Telegram standup",
        "trigger_type": "telegram_message",
        "dag_json": json.dumps(dag),
    })
    assert r.status_code in (200, 201), r.text
    routine_id = r.json()["id"]

    r = client.get(f"/routines/{routine_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["trigger_type"] == "telegram_message"
    assert json.loads(body["dag_json"])["trigger"]["triggerType"] == "trigger_telegram_message"

    r = client.get("/routines", params={"trigger_type": "telegram_message"})
    assert r.status_code == 200
    found = r.json()
    assert found["total"] == 1
    assert found["routines"][0]["id"] == routine_id


def test_filter_by_is_enabled(client):
    client.post("/routines", json={"name": "Enabled"})
    r = client.post("/routines", json={"name": "Disabled"})
    client.patch(f"/routines/{r.json()['id']}", json={"is_enabled": False})

    r = client.get("/routines", params={"is_enabled": True})
    body = r.json()
    assert body["total"] == 1
    assert body["routines"][0]["name"] == "Enabled"

    r = client.get("/routines", params={"is_enabled": False})
    body = r.json()
    assert body["total"] == 1
    assert body["routines"][0]["name"] == "Disabled"


def test_filter_by_source(client):
    client.post("/routines", json={"name": "User Made", "source": "user"})
    client.post("/routines", json={"name": "Chat Made", "source": "chat"})

    r = client.get("/routines", params={"source": "chat"})
    body = r.json()
    assert body["total"] == 1
    assert body["routines"][0]["name"] == "Chat Made"


def test_filter_by_search(client):
    client.post("/routines", json={"name": "Morning Prep", "description": "Prepares my day"})
    client.post("/routines", json={"name": "Weekly Review", "description": "Reviews the week"})

    # Search by name
    r = client.get("/routines", params={"search": "morning"})
    body = r.json()
    assert body["total"] == 1
    assert body["routines"][0]["name"] == "Morning Prep"

    # Search in description
    r = client.get("/routines", params={"search": "reviews"})
    body = r.json()
    assert body["total"] == 1
    assert body["routines"][0]["name"] == "Weekly Review"


# ── Pagination ───────────────────────────────────────────────────


def test_pagination(client):
    for i in range(5):
        client.post("/routines", json={"name": f"Routine {i}"})

    r = client.get("/routines", params={"limit": 2, "offset": 0})
    body = r.json()
    assert body["total"] == 5
    assert len(body["routines"]) == 2

    r = client.get("/routines", params={"limit": 2, "offset": 2})
    body = r.json()
    assert body["total"] == 5
    assert len(body["routines"]) == 2

    r = client.get("/routines", params={"limit": 2, "offset": 4})
    body = r.json()
    assert body["total"] == 5
    assert len(body["routines"]) == 1


# ── Ordering ─────────────────────────────────────────────────────


def test_list_ordered_by_updated_at_desc(client):
    """Most recently updated routines appear first."""
    r1 = client.post("/routines", json={"name": "First"})
    r2 = client.post("/routines", json={"name": "Second"})
    r3 = client.post("/routines", json={"name": "Third"})

    # Update the first one so it becomes most recent
    client.patch(f"/routines/{r1.json()['id']}", json={"description": "Updated"})

    r = client.get("/routines")
    names = [rt["name"] for rt in r.json()["routines"]]
    assert names[0] == "First"  # most recently updated


# ── Not Found ────────────────────────────────────────────────────


def test_get_nonexistent_returns_404(client):
    r = client.get(f"/routines/{_hex_id()}")
    assert r.status_code == 404


def test_patch_nonexistent_returns_404(client):
    r = client.patch(f"/routines/{_hex_id()}", json={"name": "Ghost"})
    assert r.status_code == 404


def test_delete_nonexistent_returns_404(client):
    r = client.delete(f"/routines/{_hex_id()}")
    assert r.status_code == 404


# ── Edge Cases ───────────────────────────────────────────────────


def test_create_routine_with_empty_lists(client):
    """Empty JSON lists should serialize and deserialize correctly."""
    r = client.post("/routines", json={
        "name": "Empty Lists",
        "plain_english_steps": [],
        "approval_gates": [],
        "required_connections": [],
    })
    assert r.status_code == 201
    body = r.json()
    assert body["plain_english_steps"] == []
    assert body["approval_gates"] == []
    assert body["required_connections"] == []


def test_default_runner_fk_set_null_on_expert_delete(client):
    """Deleting the default runner expert should set the FK to null."""
    expert_resp = client.post("/experts", json={
        "name": "Runner",
        "description": "Default runner",
    })
    expert_id = expert_resp.json()["id"]

    r = client.post("/routines", json={
        "name": "With Runner",
        "default_runner_id": expert_id,
    })
    routine_id = r.json()["id"]
    assert r.json()["default_runner_id"] == expert_id

    # Delete the expert
    client.delete(f"/experts/{expert_id}")

    # Routine should still exist with runner set to null
    r = client.get(f"/routines/{routine_id}")
    assert r.status_code == 200
    assert r.json()["default_runner_id"] is None


def test_multiple_runs_accumulate_count(client):
    """Multiple /run calls should each increment run_count."""
    r = client.post("/routines", json={"name": "Counter"})
    routine_id = r.json()["id"]

    for expected_count in range(1, 6):
        r = client.post(f"/routines/{routine_id}/run")
        assert r.json()["run_count"] == expected_count


def test_run_preserves_last_run_at(client):
    """Each /run call should update last_run_at to a new timestamp."""
    r = client.post("/routines", json={"name": "Timestamped"})
    routine_id = r.json()["id"]

    r = client.post(f"/routines/{routine_id}/run")
    first_run_at = r.json()["last_run_at"]
    assert first_run_at is not None

    r = client.post(f"/routines/{routine_id}/run")
    second_run_at = r.json()["last_run_at"]
    assert second_run_at is not None
    assert second_run_at >= first_run_at
