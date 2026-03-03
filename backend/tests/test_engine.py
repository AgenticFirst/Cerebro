"""Tests for engine run/step/event CRUD endpoints."""

import uuid
from datetime import datetime, timezone


def _hex_id() -> str:
    return uuid.uuid4().hex


def _create_routine(client, name="Test Routine"):
    """Helper: create a routine and return its ID."""
    r = client.post("/routines", json={"name": name})
    assert r.status_code == 201
    return r.json()["id"]


def _create_run(client, **overrides):
    """Helper: create a run and return the response body."""
    body = {
        "id": _hex_id(),
        "run_type": "routine",
        "trigger": "manual",
        "total_steps": 0,
        **overrides,
    }
    r = client.post("/engine/runs", json=body)
    assert r.status_code == 201
    return r.json()


# ── Run CRUD ────────────────────────────────────────────────────


def test_create_run(client):
    routine_id = _create_routine(client, name="Engine Test Routine")
    run_id = _hex_id()
    r = client.post("/engine/runs", json={
        "id": run_id,
        "routine_id": routine_id,
        "run_type": "routine",
        "trigger": "manual",
        "dag_json": '{"steps":[]}',
        "total_steps": 3,
    })
    assert r.status_code == 201
    body = r.json()
    assert body["id"] == run_id
    assert body["status"] == "running"
    assert body["routine_id"] == routine_id
    assert body["total_steps"] == 3
    assert body["completed_steps"] == 0
    assert body["dag_json"] == '{"steps":[]}'
    assert "started_at" in body


def test_list_runs_empty(client):
    r = client.get("/engine/runs")
    assert r.status_code == 200
    body = r.json()
    assert body["runs"] == []
    assert body["total"] == 0


def test_list_runs_with_filters(client):
    rtn_1 = _create_routine(client, name="Filter Routine 1")
    rtn_2 = _create_routine(client, name="Filter Routine 2")
    _create_run(client, routine_id=rtn_1, trigger="manual")
    _create_run(client, routine_id=rtn_2, trigger="schedule")
    _create_run(client, routine_id=rtn_1, trigger="chat")

    # Filter by routine_id
    r = client.get("/engine/runs", params={"routine_id": rtn_1})
    assert r.json()["total"] == 2

    # Filter by trigger
    r = client.get("/engine/runs", params={"trigger": "schedule"})
    assert r.json()["total"] == 1
    assert r.json()["runs"][0]["routine_id"] == rtn_2

    # Filter by status (all should be "running")
    r = client.get("/engine/runs", params={"status": "running"})
    assert r.json()["total"] == 3

    # Filter by status with no match
    r = client.get("/engine/runs", params={"status": "completed"})
    assert r.json()["total"] == 0


def test_get_run_with_steps(client):
    run = _create_run(client, total_steps=2)
    run_id = run["id"]

    # Add steps to the run
    steps = [
        {"id": _hex_id(), "step_id": "step-a", "step_name": "Step A", "action_type": "transformer", "order_index": 0},
        {"id": _hex_id(), "step_id": "step-b", "step_name": "Step B", "action_type": "model_call", "order_index": 1},
    ]
    client.post(f"/engine/runs/{run_id}/steps", json=steps)

    r = client.get(f"/engine/runs/{run_id}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == run_id
    assert body["steps"] is not None
    assert len(body["steps"]) == 2
    assert body["steps"][0]["step_name"] == "Step A"
    assert body["steps"][1]["step_name"] == "Step B"


def test_update_run(client):
    run = _create_run(client)
    run_id = run["id"]

    r = client.patch(f"/engine/runs/{run_id}", json={
        "status": "completed",
        "completed_steps": 3,
        "duration_ms": 1234,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "completed"
    assert body["completed_steps"] == 3
    assert body["duration_ms"] == 1234


def test_delete_run_cascades(client):
    run = _create_run(client)
    run_id = run["id"]

    # Add steps and events
    step_id = _hex_id()
    client.post(f"/engine/runs/{run_id}/steps", json=[
        {"id": step_id, "step_id": "s1", "step_name": "S1", "action_type": "transformer", "order_index": 0},
    ])
    client.post(f"/engine/runs/{run_id}/events", json={
        "events": [
            {"seq": 0, "event_type": "run_started", "payload_json": "{}", "timestamp": datetime.now(timezone.utc).isoformat()},
        ],
    })

    r = client.delete(f"/engine/runs/{run_id}")
    assert r.status_code == 204

    # Run gone
    r = client.get(f"/engine/runs/{run_id}")
    assert r.status_code == 404

    # Verify the run no longer appears in the list
    r = client.get("/engine/runs")
    assert r.json()["total"] == 0


# ── Step CRUD ───────────────────────────────────────────────────


def test_batch_create_steps(client):
    run = _create_run(client)
    run_id = run["id"]

    steps = [
        {"id": _hex_id(), "step_id": "a", "step_name": "Alpha", "action_type": "transformer", "order_index": 0},
        {"id": _hex_id(), "step_id": "b", "step_name": "Beta", "action_type": "model_call", "order_index": 1},
        {"id": _hex_id(), "step_id": "c", "step_name": "Gamma", "action_type": "expert_step", "order_index": 2},
    ]

    r = client.post(f"/engine/runs/{run_id}/steps", json=steps)
    assert r.status_code == 201
    body = r.json()
    assert len(body) == 3
    assert body[0]["step_name"] == "Alpha"
    assert body[0]["run_id"] == run_id
    assert body[0]["status"] == "pending"


def test_list_steps_ordered(client):
    run = _create_run(client)
    run_id = run["id"]

    steps = [
        {"id": _hex_id(), "step_id": "z", "step_name": "Last", "action_type": "transformer", "order_index": 2},
        {"id": _hex_id(), "step_id": "a", "step_name": "First", "action_type": "transformer", "order_index": 0},
        {"id": _hex_id(), "step_id": "m", "step_name": "Middle", "action_type": "transformer", "order_index": 1},
    ]
    client.post(f"/engine/runs/{run_id}/steps", json=steps)

    r = client.get(f"/engine/runs/{run_id}/steps")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 3
    assert body[0]["step_name"] == "First"
    assert body[1]["step_name"] == "Middle"
    assert body[2]["step_name"] == "Last"


def test_update_step(client):
    run = _create_run(client)
    run_id = run["id"]

    step_record_id = _hex_id()
    client.post(f"/engine/runs/{run_id}/steps", json=[
        {"id": step_record_id, "step_id": "s1", "step_name": "S1", "action_type": "transformer", "order_index": 0},
    ])

    r = client.patch(f"/engine/runs/{run_id}/steps/{step_record_id}", json={
        "status": "completed",
        "summary": "Transformed data",
        "duration_ms": 42,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "completed"
    assert body["summary"] == "Transformed data"
    assert body["duration_ms"] == 42


def test_update_step_wrong_run_id(client):
    run1 = _create_run(client)
    run2 = _create_run(client)

    step_record_id = _hex_id()
    client.post(f"/engine/runs/{run1['id']}/steps", json=[
        {"id": step_record_id, "step_id": "s1", "step_name": "S1", "action_type": "transformer", "order_index": 0},
    ])

    # Try to update via run2's URL — should 404 because step.run_id != run2.id
    r = client.patch(f"/engine/runs/{run2['id']}/steps/{step_record_id}", json={
        "status": "completed",
    })
    assert r.status_code == 404


# ── Event CRUD ──────────────────────────────────────────────────


def test_batch_create_events(client):
    run = _create_run(client)
    run_id = run["id"]

    now = datetime.now(timezone.utc).isoformat()
    r = client.post(f"/engine/runs/{run_id}/events", json={
        "events": [
            {"seq": 0, "event_type": "run_started", "payload_json": '{"runId":"x"}', "timestamp": now},
            {"seq": 1, "event_type": "step_queued", "step_id": "s1", "payload_json": '{"stepId":"s1"}', "timestamp": now},
            {"seq": 2, "event_type": "step_started", "step_id": "s1", "payload_json": '{"stepId":"s1"}', "timestamp": now},
        ],
    })
    assert r.status_code == 201
    assert r.json()["created"] == 3


def test_list_events_ordered_with_pagination(client):
    run = _create_run(client)
    run_id = run["id"]

    now = datetime.now(timezone.utc).isoformat()
    events = [{"seq": i, "event_type": f"event_{i}", "payload_json": "{}", "timestamp": now} for i in range(5)]
    client.post(f"/engine/runs/{run_id}/events", json={"events": events})

    # Get all
    r = client.get(f"/engine/runs/{run_id}/events")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 5
    assert body[0]["seq"] == 0
    assert body[4]["seq"] == 4

    # With offset and limit
    r = client.get(f"/engine/runs/{run_id}/events", params={"offset": 2, "limit": 2})
    body = r.json()
    assert len(body) == 2
    assert body[0]["seq"] == 2
    assert body[1]["seq"] == 3


def test_events_for_nonexistent_run(client):
    # Listing events for a run that doesn't exist returns empty (not 404)
    # because the query simply finds no matching records
    r = client.get(f"/engine/runs/{_hex_id()}/events")
    assert r.status_code == 200
    assert r.json() == []

    # But creating events for a nonexistent run returns 404
    r = client.post(f"/engine/runs/{_hex_id()}/events", json={
        "events": [
            {"seq": 0, "event_type": "test", "payload_json": "{}", "timestamp": datetime.now(timezone.utc).isoformat()},
        ],
    })
    assert r.status_code == 404


# ── Edge Cases ──────────────────────────────────────────────────


def test_get_nonexistent_run(client):
    r = client.get(f"/engine/runs/{_hex_id()}")
    assert r.status_code == 404


def test_patch_nonexistent_run(client):
    r = client.patch(f"/engine/runs/{_hex_id()}", json={"status": "completed"})
    assert r.status_code == 404
