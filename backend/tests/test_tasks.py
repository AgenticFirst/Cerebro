"""Tests for the Tasks feature — CRUD, column transitions, run-event state
machine (run_started → in_progress, run_completed → to_review), cancel, queued
instructions, checklist, and subtasks."""

import uuid

import pytest


def _hex_id() -> str:
    return uuid.uuid4().hex


def _create_expert(client, name: str = "Coder") -> str:
    r = client.post("/experts", json={"name": name, "description": f"{name} agent"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _create_task(client, **overrides) -> dict:
    body = {"title": "A task"}
    body.update(overrides)
    r = client.post("/tasks", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _run_event(client, task_id: str, type_: str, run_id: str, **extra) -> dict:
    r = client.post(
        f"/tasks/{task_id}/run-event",
        json={"type": type_, "run_id": run_id, **extra},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _start_run(client, task_id: str) -> str:
    run_id = _hex_id()
    _run_event(client, task_id, "run_started", run_id)
    return run_id


def _queue_instruction(client, task_id: str, expert_id: str, body_md: str = "go") -> dict:
    r = client.post(f"/tasks/{task_id}/comments", json={
        "kind": "instruction", "body_md": body_md,
        "queue_status": "pending", "pending_expert_id": expert_id,
    })
    assert r.status_code == 200, r.text
    return r.json()


# ── A1. CRUD & validation ────────────────────────────────────────


def test_create_task_minimal(client):
    r = client.post("/tasks", json={"title": "Do thing"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Do thing"
    assert body["column"] == "backlog"
    assert body["priority"] == "normal"
    assert body["position"] > 0
    assert body["id"]
    assert body["tags"] == []
    assert body["checklist"] == []
    assert body["comment_count"] == 1


def test_create_task_all_fields(client):
    expert_id = _create_expert(client)
    r = client.post("/tasks", json={
        "title": "Big task",
        "description_md": "## Details",
        "expert_id": expert_id,
        "priority": "high",
        "tags": ["backend", "urgent", "backend"],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["description_md"] == "## Details"
    assert body["expert_id"] == expert_id
    assert body["priority"] == "high"
    assert body["tags"] == ["backend", "urgent"]


@pytest.mark.parametrize("payload", [
    {"title": "X", "column": "nope"},
    {"title": "X", "priority": "critical"},
    {"title": "X", "project_path": "/etc"},
])
def test_create_task_invalid_payload_rejected(client, payload):
    r = client.post("/tasks", json=payload)
    assert r.status_code == 400


def test_list_tasks_empty(client):
    r = client.get("/tasks")
    assert r.status_code == 200
    assert r.json() == []


def test_list_tasks_filter_by_column(client):
    a = _create_task(client, title="A")
    b = _create_task(client, title="B")
    client.post(f"/tasks/{b['id']}/move", json={"column": "in_progress"})

    r = client.get("/tasks?column=backlog")
    ids = [t["id"] for t in r.json()]
    assert a["id"] in ids
    assert b["id"] not in ids

    r = client.get("/tasks?column=in_progress")
    ids = [t["id"] for t in r.json()]
    assert b["id"] in ids
    assert a["id"] not in ids


def test_list_tasks_filter_by_expert(client):
    ex1 = _create_expert(client, "E1")
    ex2 = _create_expert(client, "E2")
    t1 = _create_task(client, title="T1", expert_id=ex1)
    _create_task(client, title="T2", expert_id=ex2)

    r = client.get(f"/tasks?expert_id={ex1}")
    assert [t["id"] for t in r.json()] == [t1["id"]]


def test_list_tasks_filter_by_parent(client):
    parent = _create_task(client, title="Parent")
    child = _create_task(client, title="Child", parent_task_id=parent["id"])

    r = client.get(f"/tasks?parent_task_id={parent['id']}")
    assert [t["id"] for t in r.json()] == [child["id"]]


def test_get_task_includes_rollups(client):
    task = _create_task(client)
    item = client.post(f"/tasks/{task['id']}/checklist", json={"body": "step"}).json()
    client.patch(f"/tasks/{task['id']}/checklist/{item['id']}", json={"is_done": True})

    r = client.get(f"/tasks/{task['id']}")
    body = r.json()
    assert body["checklist_total"] == 1
    assert body["checklist_done"] == 1
    assert body["comment_count"] >= 1


def test_get_task_404(client):
    r = client.get(f"/tasks/{_hex_id()}")
    assert r.status_code == 404


def test_task_stats_all_columns(client):
    _create_task(client, title="a")
    _create_task(client, title="b")
    t = _create_task(client, title="c")
    client.post(f"/tasks/{t['id']}/move", json={"column": "in_progress"})

    r = client.get("/tasks/stats")
    s = r.json()
    assert s["backlog"] == 2
    assert s["in_progress"] == 1
    assert s["to_review"] == 0
    assert s["completed"] == 0
    assert s["error"] == 0


def test_patch_updates_fields(client):
    task = _create_task(client)
    r = client.patch(f"/tasks/{task['id']}", json={
        "title": "Renamed",
        "priority": "urgent",
        "tags": ["x", "y"],
    })
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Renamed"
    assert body["priority"] == "urgent"
    assert body["tags"] == ["x", "y"]


def test_patch_reassign_expert_logs_system_comment(client):
    ex1 = _create_expert(client, "One")
    ex2 = _create_expert(client, "Two")
    task = _create_task(client, expert_id=ex1)

    r = client.patch(f"/tasks/{task['id']}", json={"expert_id": ex2})
    assert r.status_code == 200
    assert r.json()["expert_id"] == ex2

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    system_texts = [c["body_md"] for c in comments if c["kind"] == "system"]
    assert any("Reassigned to Two" in s for s in system_texts)


def test_patch_cannot_change_column_directly(client):
    task = _create_task(client)
    r = client.patch(f"/tasks/{task['id']}", json={"column": "completed"})
    assert r.status_code == 200
    assert r.json()["column"] == "backlog"


def test_patch_invalid_priority_rejected(client):
    task = _create_task(client)
    r = client.patch(f"/tasks/{task['id']}", json={"priority": "critical"})
    assert r.status_code == 400


def test_delete_task_cascades_comments_and_checklist(client):
    task = _create_task(client)
    client.post(f"/tasks/{task['id']}/checklist", json={"body": "step"})
    client.post(f"/tasks/{task['id']}/comments", json={"kind": "comment", "body_md": "note"})

    r = client.delete(f"/tasks/{task['id']}")
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    assert client.get(f"/tasks/{task['id']}").status_code == 404
    assert client.get(f"/tasks/{task['id']}/comments").json() == []


def test_delete_task_404(client):
    r = client.delete(f"/tasks/{_hex_id()}")
    assert r.status_code == 404


# ── A2. Column transitions ────────────────────────────────────────


def test_move_to_in_progress_sets_started_at(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/move", json={"column": "in_progress"})
    assert r.status_code == 200
    assert r.json()["column"] == "in_progress"
    assert r.json()["started_at"] is not None


def test_move_to_completed_sets_completed_at(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/move", json={"column": "completed"})
    assert r.status_code == 200
    assert r.json()["completed_at"] is not None


def test_move_invalid_column_rejected(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/move", json={"column": "nope"})
    assert r.status_code == 400


def test_move_preserves_explicit_position(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/move", json={"column": "backlog", "position": 42.5})
    assert r.status_code == 200
    assert r.json()["position"] == 42.5


def test_move_logs_system_comment(client):
    task = _create_task(client)
    client.post(f"/tasks/{task['id']}/move", json={"column": "in_progress"})
    comments = client.get(f"/tasks/{task['id']}/comments").json()
    texts = [c["body_md"] for c in comments if c["kind"] == "system"]
    assert any("Moved to In Progress" in t for t in texts)


# ── A3. Run-event state machine (CRITICAL) ─────────────────────────


def test_run_started_flips_to_in_progress(client):
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    run_id = _start_run(client, task["id"])

    fresh = client.get(f"/tasks/{task['id']}").json()
    assert fresh["column"] == "in_progress"
    assert fresh["run_id"] == run_id
    assert fresh["started_at"] is not None

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    assert any("Expert started working" in c["body_md"] for c in comments)


def test_run_started_creates_run_record_if_absent(client):
    task = _create_task(client)
    run_id = _start_run(client, task["id"])
    # A later run_completed against the same run_id proves the record was created.
    _run_event(client, task["id"], "run_completed", run_id)


def test_run_completed_flips_to_to_review(client):
    task = _create_task(client)
    run_id = _start_run(client, task["id"])
    _run_event(client, task["id"], "run_completed", run_id)

    fresh = client.get(f"/tasks/{task['id']}").json()
    assert fresh["column"] == "to_review"
    assert fresh["completed_at"] is not None

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    assert any("ready for review" in c["body_md"] for c in comments)


def test_run_failed_flips_to_error(client):
    task = _create_task(client)
    run_id = _start_run(client, task["id"])
    _run_event(client, task["id"], "run_failed", run_id, error="Exit code 137 — killed")

    fresh = client.get(f"/tasks/{task['id']}").json()
    assert fresh["column"] == "error"
    assert fresh["last_error"] == "Exit code 137 — killed"


def test_run_cancelled_flips_to_error_with_fixed_message(client):
    task = _create_task(client)
    run_id = _start_run(client, task["id"])
    _run_event(client, task["id"], "run_cancelled", run_id)

    fresh = client.get(f"/tasks/{task['id']}").json()
    assert fresh["column"] == "error"
    assert fresh["last_error"] == "Run was cancelled"


def test_run_event_missing_task_returns_404(client):
    r = client.post(f"/tasks/{_hex_id()}/run-event", json={
        "type": "run_started", "run_id": _hex_id(),
    })
    assert r.status_code == 404


def test_run_event_unknown_type_rejected(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/run-event", json={"type": "weird_event"})
    assert r.status_code == 400


def test_run_event_missing_type_rejected(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/run-event", json={"run_id": _hex_id()})
    assert r.status_code == 400


def test_run_completed_does_not_resurrect_errored_task(client):
    # Once errored, a late run_completed must not silently overwrite the failure.
    task = _create_task(client)
    run_id = _start_run(client, task["id"])
    _run_event(client, task["id"], "run_failed", run_id, error="boom")
    _run_event(client, task["id"], "run_completed", run_id)

    fresh = client.get(f"/tasks/{task['id']}").json()
    assert fresh["column"] == "error"
    assert fresh["last_error"] == "boom"


def test_double_run_completed_is_idempotent(client):
    # Engine retries / duplicate events must not add a second "ready for review" comment.
    task = _create_task(client)
    run_id = _start_run(client, task["id"])
    _run_event(client, task["id"], "run_completed", run_id)
    _run_event(client, task["id"], "run_completed", run_id)

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    review_comments = [c for c in comments if "ready for review" in c["body_md"]]
    assert len(review_comments) == 1


def test_stale_run_id_on_completion_ignored(client):
    # A late event for an OLD run_id must not affect the currently-active run.
    # This is the class of bug behind the "re-run prematurely marks task as done" regression.
    task = _create_task(client)
    first_run = _start_run(client, task["id"])
    client.post(f"/tasks/{task['id']}/cancel")
    second_run = _start_run(client, task["id"])

    _run_event(client, task["id"], "run_completed", first_run)

    fresh = client.get(f"/tasks/{task['id']}").json()
    assert fresh["column"] == "in_progress"
    assert fresh["run_id"] == second_run
    assert fresh["completed_at"] is None


def test_cancel_discards_pending_instruction(client):
    # Cancel must transition pending instructions to `discarded` so they don't
    # silently drain into a future run of the same task.
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    _start_run(client, task["id"])
    comment = _queue_instruction(client, task["id"], expert_id, "follow-up")

    client.post(f"/tasks/{task['id']}/cancel")

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    refreshed = next(c for c in comments if c["id"] == comment["id"])
    assert refreshed["queue_status"] == "discarded"


# ── A4. Cancel ────────────────────────────────────────────────────


def test_cancel_in_progress_returns_to_backlog(client):
    task = _create_task(client)
    _start_run(client, task["id"])

    r = client.post(f"/tasks/{task['id']}/cancel")
    assert r.status_code == 200
    body = r.json()
    assert body["column"] == "backlog"
    assert body["run_id"] is None

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    assert any("Task cancelled" in c["body_md"] for c in comments)


def test_cancel_missing_task_returns_404(client):
    r = client.post(f"/tasks/{_hex_id()}/cancel")
    assert r.status_code == 404


# ── A5. Comments & queued instructions ────────────────────────────


def test_create_plain_comment(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/comments", json={
        "kind": "comment",
        "body_md": "Looks good",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "comment"
    assert body["queue_status"] is None


def test_queue_instruction_requires_active_run(client):
    task = _create_task(client)
    r = client.post(f"/tasks/{task['id']}/comments", json={
        "kind": "instruction",
        "body_md": "Also add tests",
        "queue_status": "pending",
    })
    assert r.status_code == 400


def test_queue_instruction_while_running(client):
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    _start_run(client, task["id"])

    body = _queue_instruction(client, task["id"], expert_id, "Log the date too")
    assert body["queue_status"] == "pending"
    assert body["pending_expert_id"] == expert_id


def test_only_one_pending_instruction_allowed(client):
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    _start_run(client, task["id"])
    _queue_instruction(client, task["id"], expert_id, "first")

    r = client.post(f"/tasks/{task['id']}/comments", json={
        "kind": "instruction", "body_md": "second",
        "queue_status": "pending", "pending_expert_id": expert_id,
    })
    assert r.status_code == 409


def test_queue_status_delivered(client):
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    _start_run(client, task["id"])
    comment = _queue_instruction(client, task["id"], expert_id)

    r = client.patch(
        f"/tasks/{task['id']}/comments/{comment['id']}/queue-status",
        json={"queue_status": "delivered"},
    )
    assert r.status_code == 200
    assert r.json()["queue_status"] == "delivered"


def test_queue_status_discarded_is_irreversible(client):
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    _start_run(client, task["id"])
    comment = _queue_instruction(client, task["id"], expert_id)

    client.patch(
        f"/tasks/{task['id']}/comments/{comment['id']}/queue-status",
        json={"queue_status": "discarded"},
    )

    r = client.patch(
        f"/tasks/{task['id']}/comments/{comment['id']}/queue-status",
        json={"queue_status": "delivered"},
    )
    assert r.status_code == 400


def test_queue_status_rejects_invalid_target(client):
    expert_id = _create_expert(client)
    task = _create_task(client, expert_id=expert_id)
    _start_run(client, task["id"])
    comment = _queue_instruction(client, task["id"], expert_id)

    r = client.patch(
        f"/tasks/{task['id']}/comments/{comment['id']}/queue-status",
        json={"queue_status": "pending"},
    )
    assert r.status_code == 400


def test_list_comments_ordering(client):
    task = _create_task(client)
    client.post(f"/tasks/{task['id']}/comments", json={"kind": "comment", "body_md": "first"})
    client.post(f"/tasks/{task['id']}/comments", json={"kind": "comment", "body_md": "second"})

    comments = client.get(f"/tasks/{task['id']}/comments").json()
    assert comments[0]["body_md"] == "Task created"
    assert any(c["body_md"] == "first" for c in comments)
    assert any(c["body_md"] == "second" for c in comments)


# ── A6. Checklist ─────────────────────────────────────────────────


def test_checklist_crud(client):
    task = _create_task(client)
    item = client.post(f"/tasks/{task['id']}/checklist", json={"body": "step one"}).json()
    assert item["body"] == "step one"
    assert item["is_done"] is False

    r = client.patch(
        f"/tasks/{task['id']}/checklist/{item['id']}",
        json={"is_done": True, "body": "updated"},
    )
    assert r.status_code == 200
    assert r.json()["is_done"] is True
    assert r.json()["body"] == "updated"

    r = client.delete(f"/tasks/{task['id']}/checklist/{item['id']}")
    assert r.status_code == 200


def test_promote_checklist_item_creates_linked_task(client):
    parent = _create_task(client, title="Parent")
    item = client.post(f"/tasks/{parent['id']}/checklist", json={"body": "sub-work"}).json()

    r = client.post(f"/tasks/{parent['id']}/checklist/{item['id']}/promote")
    assert r.status_code == 200
    child = r.json()
    assert child["title"] == "sub-work"
    assert child["parent_task_id"] == parent["id"]

    items = client.get(f"/tasks/{parent['id']}").json()["checklist"]
    match = [i for i in items if i["id"] == item["id"]]
    assert len(match) == 1
    assert match[0]["promoted_task_id"] == child["id"]


def test_promote_twice_rejected(client):
    parent = _create_task(client, title="Parent")
    item = client.post(f"/tasks/{parent['id']}/checklist", json={"body": "once"}).json()
    client.post(f"/tasks/{parent['id']}/checklist/{item['id']}/promote")

    r = client.post(f"/tasks/{parent['id']}/checklist/{item['id']}/promote")
    assert r.status_code == 400


# ── A7. Subtasks ──────────────────────────────────────────────────


def test_subtask_filter_and_cascade_delete(client):
    parent = _create_task(client, title="Parent")
    child = _create_task(client, title="Child", parent_task_id=parent["id"])

    r = client.get(f"/tasks?parent_task_id={parent['id']}")
    assert [t["id"] for t in r.json()] == [child["id"]]

    client.delete(f"/tasks/{parent['id']}")
    assert client.get(f"/tasks/{child['id']}").status_code == 404
