"""End-to-end lifecycle tests for routines.

Covers the full CRUD + run lifecycle that individual unit tests don't exercise
as a connected flow: create → update → run → verify state → delete → verify 404.
"""

import json
import uuid


def _hex_id() -> str:
    return uuid.uuid4().hex


# ── Full CRUD + Run lifecycle ────────────────────────────────────


def test_full_routine_lifecycle(client):
    """Create → update with dag_json → run → verify run_count/last_run_at → delete → 404."""
    # 1. Create
    r = client.post("/routines", json={"name": "Lifecycle Test"})
    assert r.status_code == 201
    routine_id = r.json()["id"]
    assert r.json()["run_count"] == 0
    assert r.json()["dag_json"] is None

    # 2. Update with dag_json and steps
    dag = {
        "steps": [
            {"id": "s1", "name": "Fetch", "actionType": "model_call", "params": {"prompt": "Fetch data"}},
            {"id": "s2", "name": "Transform", "actionType": "transformer", "params": {"operation": "format"}},
        ]
    }
    r = client.patch(f"/routines/{routine_id}", json={
        "dag_json": json.dumps(dag),
        "plain_english_steps": ["Fetch data", "Transform data"],
        "description": "Full lifecycle test routine",
    })
    assert r.status_code == 200
    assert json.loads(r.json()["dag_json"]) == dag
    assert r.json()["plain_english_steps"] == ["Fetch data", "Transform data"]

    # 3. Run
    r = client.post(f"/routines/{routine_id}/run")
    assert r.status_code == 200
    assert r.json()["run_count"] == 1
    first_run_at = r.json()["last_run_at"]
    assert first_run_at is not None

    # 4. Run again — verify count accumulates
    r = client.post(f"/routines/{routine_id}/run")
    assert r.json()["run_count"] == 2
    assert r.json()["last_run_at"] >= first_run_at

    # 5. Verify via GET
    r = client.get(f"/routines/{routine_id}")
    assert r.status_code == 200
    assert r.json()["run_count"] == 2
    assert r.json()["description"] == "Full lifecycle test routine"

    # 6. Delete
    r = client.delete(f"/routines/{routine_id}")
    assert r.status_code == 204

    # 7. Verify gone
    r = client.get(f"/routines/{routine_id}")
    assert r.status_code == 404


# ── Cron lifecycle ──────────────────────────────────────────────


def test_cron_routine_lifecycle(client):
    """Create cron → verify → update cron → verify → disable → run blocked."""
    # 1. Create as cron
    r = client.post("/routines", json={
        "name": "Cron Lifecycle",
        "trigger_type": "cron",
        "cron_expression": "0 9 * * 1-5",
    })
    assert r.status_code == 201
    routine_id = r.json()["id"]
    assert r.json()["trigger_type"] == "cron"
    assert r.json()["cron_expression"] == "0 9 * * 1-5"
    assert r.json()["is_enabled"] is True

    # 2. Update cron expression
    r = client.patch(f"/routines/{routine_id}", json={
        "cron_expression": "30 14 * * *",
    })
    assert r.status_code == 200
    assert r.json()["cron_expression"] == "30 14 * * *"

    # 3. Change trigger type back to manual
    r = client.patch(f"/routines/{routine_id}", json={
        "trigger_type": "manual",
    })
    assert r.status_code == 200
    assert r.json()["trigger_type"] == "manual"
    # cron_expression preserved even when trigger changes
    assert r.json()["cron_expression"] == "30 14 * * *"

    # 4. Disable
    r = client.patch(f"/routines/{routine_id}", json={"is_enabled": False})
    assert r.json()["is_enabled"] is False

    # 5. Run should fail — routine is disabled
    r = client.post(f"/routines/{routine_id}/run")
    assert r.status_code == 400


# ── Concurrent routines ────────────────────────────────────────


def test_multiple_routines_independent(client):
    """Multiple routines don't interfere with each other."""
    r1 = client.post("/routines", json={"name": "Routine A"})
    r2 = client.post("/routines", json={"name": "Routine B"})
    id_a = r1.json()["id"]
    id_b = r2.json()["id"]

    # Run A twice
    client.post(f"/routines/{id_a}/run")
    client.post(f"/routines/{id_a}/run")

    # Run B once
    client.post(f"/routines/{id_b}/run")

    # Verify counts are independent
    assert client.get(f"/routines/{id_a}").json()["run_count"] == 2
    assert client.get(f"/routines/{id_b}").json()["run_count"] == 1

    # Delete A doesn't affect B
    client.delete(f"/routines/{id_a}")
    assert client.get(f"/routines/{id_a}").status_code == 404
    assert client.get(f"/routines/{id_b}").status_code == 200


# ── Update preserves unmentioned fields ─────────────────────────


def test_partial_update_preserves_all_fields(client):
    """PATCH with one field should not reset other fields."""
    dag = {"steps": [{"id": "s1", "name": "Go", "actionType": "model_call"}]}
    r = client.post("/routines", json={
        "name": "Preserve Test",
        "description": "Original desc",
        "plain_english_steps": ["Step one", "Step two"],
        "dag_json": json.dumps(dag),
        "trigger_type": "cron",
        "cron_expression": "0 9 * * 1-5",
        "approval_gates": ["Step one"],
        "required_connections": ["notion"],
    })
    routine_id = r.json()["id"]

    # Only change name
    r = client.patch(f"/routines/{routine_id}", json={"name": "Renamed"})
    body = r.json()

    assert body["name"] == "Renamed"
    assert body["description"] == "Original desc"
    assert body["plain_english_steps"] == ["Step one", "Step two"]
    assert json.loads(body["dag_json"]) == dag
    assert body["trigger_type"] == "cron"
    assert body["cron_expression"] == "0 9 * * 1-5"
    assert body["approval_gates"] == ["Step one"]
    assert body["required_connections"] == ["notion"]
