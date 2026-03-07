"""Tests for approval CRUD endpoints and stale recovery."""

import uuid


def _hex_id() -> str:
    return uuid.uuid4().hex


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


def _create_approval(client, run_id, **overrides):
    """Helper: create an approval for a given run and return the response body."""
    body = {
        "id": _hex_id(),
        "run_id": run_id,
        "step_id": "step-1",
        "step_name": "Step One",
        "summary": "Please approve this step",
        **overrides,
    }
    r = client.post("/engine/approvals", json=body)
    assert r.status_code == 201
    return r.json()


# ── Approval CRUD ────────────────────────────────────────────────


def test_create_approval(client):
    run = _create_run(client)
    approval_id = _hex_id()
    r = client.post("/engine/approvals", json={
        "id": approval_id,
        "run_id": run["id"],
        "step_id": "s1",
        "step_name": "Check Data",
        "summary": "Verify data before proceeding",
        "payload_json": '{"key": "value"}',
    })
    assert r.status_code == 201
    body = r.json()
    assert body["id"] == approval_id
    assert body["run_id"] == run["id"]
    assert body["step_id"] == "s1"
    assert body["step_name"] == "Check Data"
    assert body["summary"] == "Verify data before proceeding"
    assert body["payload_json"] == '{"key": "value"}'
    assert body["status"] == "pending"
    assert body["decision_reason"] is None
    assert body["resolved_at"] is None
    assert "requested_at" in body


def test_create_approval_requires_existing_run(client):
    r = client.post("/engine/approvals", json={
        "id": _hex_id(),
        "run_id": _hex_id(),
        "step_id": "s1",
        "step_name": "Step",
        "summary": "Orphan approval",
    })
    assert r.status_code == 404


def test_get_approval(client):
    run = _create_run(client)
    created = _create_approval(client, run["id"], step_name="Get Me")
    approval_id = created["id"]

    # Existing approval
    r = client.get(f"/engine/approvals/{approval_id}")
    assert r.status_code == 200
    assert r.json()["step_name"] == "Get Me"

    # Nonexistent approval
    r = client.get(f"/engine/approvals/{_hex_id()}")
    assert r.status_code == 404


def test_list_approvals_empty(client):
    r = client.get("/engine/approvals")
    assert r.status_code == 200
    body = r.json()
    assert body["approvals"] == []
    assert body["total"] == 0


def test_list_approvals_filter_by_status(client):
    run = _create_run(client)
    a1 = _create_approval(client, run["id"], step_name="A1")
    a2 = _create_approval(client, run["id"], step_name="A2")

    # Resolve one as approved
    client.patch(f"/engine/approvals/{a1['id']}/resolve", json={"decision": "approved"})

    # Filter by pending
    r = client.get("/engine/approvals", params={"status": "pending"})
    assert r.json()["total"] == 1
    assert r.json()["approvals"][0]["id"] == a2["id"]

    # Filter by approved
    r = client.get("/engine/approvals", params={"status": "approved"})
    assert r.json()["total"] == 1
    assert r.json()["approvals"][0]["id"] == a1["id"]


def test_list_approvals_filter_by_run_id(client):
    run1 = _create_run(client)
    run2 = _create_run(client)
    _create_approval(client, run1["id"], step_name="Run1 Approval")
    _create_approval(client, run1["id"], step_name="Run1 Approval 2")
    _create_approval(client, run2["id"], step_name="Run2 Approval")

    r = client.get("/engine/approvals", params={"run_id": run1["id"]})
    assert r.json()["total"] == 2

    r = client.get("/engine/approvals", params={"run_id": run2["id"]})
    assert r.json()["total"] == 1
    assert r.json()["approvals"][0]["step_name"] == "Run2 Approval"


def test_pending_count(client):
    # Initially zero
    r = client.get("/engine/approvals/pending/count")
    assert r.json()["count"] == 0

    run = _create_run(client)
    a1 = _create_approval(client, run["id"])
    _create_approval(client, run["id"])

    r = client.get("/engine/approvals/pending/count")
    assert r.json()["count"] == 2

    # Resolve one
    client.patch(f"/engine/approvals/{a1['id']}/resolve", json={"decision": "approved"})

    r = client.get("/engine/approvals/pending/count")
    assert r.json()["count"] == 1


# ── Resolve Flow ─────────────────────────────────────────────────


def test_resolve_approval_approve(client):
    run = _create_run(client)
    approval = _create_approval(client, run["id"])

    r = client.patch(f"/engine/approvals/{approval['id']}/resolve", json={
        "decision": "approved",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "approved"
    assert body["decision_reason"] is None
    assert body["resolved_at"] is not None


def test_resolve_approval_deny_with_reason(client):
    run = _create_run(client)
    approval = _create_approval(client, run["id"])

    r = client.patch(f"/engine/approvals/{approval['id']}/resolve", json={
        "decision": "denied",
        "reason": "Too risky",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "denied"
    assert body["decision_reason"] == "Too risky"
    assert body["resolved_at"] is not None


def test_resolve_already_resolved_returns_409(client):
    run = _create_run(client)
    approval = _create_approval(client, run["id"])

    # First resolve succeeds
    r = client.patch(f"/engine/approvals/{approval['id']}/resolve", json={
        "decision": "approved",
    })
    assert r.status_code == 200

    # Second resolve returns 409
    r = client.patch(f"/engine/approvals/{approval['id']}/resolve", json={
        "decision": "denied",
    })
    assert r.status_code == 409
    assert "already resolved" in r.json()["detail"].lower()


def test_resolve_nonexistent_returns_404(client):
    r = client.patch(f"/engine/approvals/{_hex_id()}/resolve", json={
        "decision": "approved",
    })
    assert r.status_code == 404


# ── Stale Recovery ───────────────────────────────────────────────


def test_recover_stale_marks_running_runs_failed(client):
    running = _create_run(client)
    completed = _create_run(client)
    client.patch(f"/engine/runs/{completed['id']}", json={"status": "completed"})

    r = client.post("/engine/runs/recover-stale")
    assert r.status_code == 200
    body = r.json()
    assert body["recovered_runs"] == 1

    # Running run is now failed
    r = client.get(f"/engine/runs/{running['id']}")
    assert r.json()["status"] == "failed"
    assert "unexpected shutdown" in r.json()["error"].lower()

    # Completed run is untouched
    r = client.get(f"/engine/runs/{completed['id']}")
    assert r.json()["status"] == "completed"


def test_recover_stale_marks_paused_runs_failed(client):
    paused = _create_run(client)
    client.patch(f"/engine/runs/{paused['id']}", json={"status": "paused"})

    r = client.post("/engine/runs/recover-stale")
    assert r.json()["recovered_runs"] == 1

    r = client.get(f"/engine/runs/{paused['id']}")
    assert r.json()["status"] == "failed"


def test_recover_stale_expires_pending_approvals(client):
    run = _create_run(client)
    client.patch(f"/engine/runs/{run['id']}", json={"status": "paused"})
    approval = _create_approval(client, run["id"])

    r = client.post("/engine/runs/recover-stale")
    body = r.json()
    assert body["recovered_runs"] == 1
    assert body["expired_approvals"] == 1

    # Approval is now expired with resolved_at set
    r = client.get(f"/engine/approvals/{approval['id']}")
    assert r.json()["status"] == "expired"
    assert r.json()["resolved_at"] is not None


def test_recover_stale_no_stale_runs(client):
    # No running/paused runs exist
    r = client.post("/engine/runs/recover-stale")
    body = r.json()
    assert body["recovered_runs"] == 0
    assert body["expired_approvals"] == 0


# ── Step-Approval Linkage ────────────────────────────────────────


def test_step_approval_fields(client):
    run = _create_run(client)
    approval = _create_approval(client, run["id"])

    step_id = _hex_id()
    client.post(f"/engine/runs/{run['id']}/steps", json=[
        {"id": step_id, "step_id": "s1", "step_name": "S1", "action_type": "approval_gate", "order_index": 0},
    ])

    r = client.patch(f"/engine/runs/{run['id']}/steps/{step_id}", json={
        "approval_id": approval["id"],
        "approval_status": "approved",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["approval_id"] == approval["id"]
    assert body["approval_status"] == "approved"

    # Verify persistence via GET
    r = client.get(f"/engine/runs/{run['id']}/steps")
    step = r.json()[0]
    assert step["approval_id"] == approval["id"]
    assert step["approval_status"] == "approved"


# ── Cascade ──────────────────────────────────────────────────────


def test_delete_run_cascades_approvals(client):
    run = _create_run(client)
    approval = _create_approval(client, run["id"])

    r = client.delete(f"/engine/runs/{run['id']}")
    assert r.status_code == 204

    # Approval is also gone
    r = client.get(f"/engine/approvals/{approval['id']}")
    assert r.status_code == 404
