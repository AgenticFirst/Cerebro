"""Tests for the builtin "Cerebro" expert — the FK-safe way to let a task (or
routine step) say "let Cerebro decide which experts it needs".

Why a real expert row instead of a magic sentinel: ``Task.expert_id`` is a real
foreign key to ``experts.id`` and SQLite runs with ``PRAGMA foreign_keys=ON``,
so storing a non-existent id (e.g. the old ``__auto__`` sentinel) would raise an
IntegrityError at insert time. Cerebro ships as a builtin/verified expert with a
fixed id so the FK is satisfied and the runtime can map it to the orchestrator
agent. These tests lock that contract in.
"""

import uuid


# ── Seeding contract ──

def test_cerebro_expert_is_seeded(seeded_client):
    r = seeded_client.get("/experts?limit=200")
    assert r.status_code == 200, r.text
    experts = {e["id"]: e for e in r.json()["experts"]}
    assert "cerebro" in experts, "Cerebro expert must be seeded on startup"

    cerebro = experts["cerebro"]
    assert cerebro["name"] == "Cerebro"
    assert cerebro["type"] == "expert"
    assert cerebro["source"] == "builtin"
    assert cerebro["is_verified"] is True
    assert cerebro["is_enabled"] is True


def test_cerebro_seed_is_idempotent(seeded_client):
    # The seeded_client already ran the seeders once; re-running must not
    # duplicate the row or change its identity.
    from experts.seed import seed_cerebro_expert
    from database import SessionLocal

    db = SessionLocal()
    try:
        seed_cerebro_expert(db)
    finally:
        db.close()

    r = seeded_client.get("/experts?limit=200")
    cerebros = [e for e in r.json()["experts"] if e["id"] == "cerebro"]
    assert len(cerebros) == 1


# ── Edit / delete protection ──

def test_cerebro_expert_cannot_be_deleted(seeded_client):
    r = seeded_client.delete("/experts/cerebro")
    assert r.status_code == 403, r.text


def test_cerebro_expert_persona_is_locked(seeded_client):
    # Persona/content edits are rejected on verified experts…
    r = seeded_client.patch("/experts/cerebro", json={"name": "Hacked"})
    assert r.status_code == 403, r.text

    # …but harmless toggles (pin) are still allowed.
    r = seeded_client.patch("/experts/cerebro", json={"is_pinned": True})
    assert r.status_code == 200, r.text
    assert r.json()["is_pinned"] is True


# ── Foreign-key safety: this is the whole point ──

def test_task_can_be_assigned_to_cerebro(seeded_client):
    r = seeded_client.post("/tasks", json={"title": "Plan launch", "expert_id": "cerebro"})
    assert r.status_code == 200, r.text
    assert r.json()["expert_id"] == "cerebro"

    # And it survives a round-trip read.
    task_id = r.json()["id"]
    got = seeded_client.get(f"/tasks/{task_id}")
    assert got.json()["expert_id"] == "cerebro"


def test_task_can_be_assigned_to_a_team(seeded_client):
    # Teams are also real expert rows (type='team'), so they satisfy the FK too.
    teams = [
        e for e in seeded_client.get("/experts?type=team&limit=200").json()["experts"]
    ]
    assert teams, "expected at least one verified team to be seeded"
    team_id = teams[0]["id"]

    r = seeded_client.post("/tasks", json={"title": "Review PR", "expert_id": team_id})
    assert r.status_code == 200, r.text
    assert r.json()["expert_id"] == team_id


def test_task_rejects_nonexistent_assignee_id(seeded_client):
    """A bogus assignee id (like the old ``__auto__`` sentinel) must be rejected
    by the foreign key — never silently stored. Accept either a raised
    IntegrityError or a non-2xx response, since both prove the FK held."""
    try:
        r = seeded_client.post("/tasks", json={"title": "x", "expert_id": "__auto__"})
    except Exception:
        return  # FK violation raised on commit — contract upheld
    assert r.status_code >= 400, "non-existent expert_id must not be accepted"


# ── Reassignment system comment ──

def test_reassigning_to_cerebro_logs_readable_comment(seeded_client):
    task = seeded_client.post("/tasks", json={"title": "A task"}).json()
    r = seeded_client.patch(f"/tasks/{task['id']}", json={"expert_id": "cerebro"})
    assert r.status_code == 200, r.text

    comments = seeded_client.get(f"/tasks/{task['id']}/comments").json()
    system_texts = [c["body_md"] for c in comments if c["kind"] == "system"]
    assert any("Reassigned to Cerebro" in s for s in system_texts), system_texts


def test_queued_instruction_can_target_cerebro(seeded_client):
    """Reassigning a *running* task to Cerebro queues a comment whose
    pending_expert_id is validated against the experts table. Because Cerebro is
    a real row, the handoff is accepted; a bogus id is still rejected."""
    task = seeded_client.post("/tasks", json={"title": "Running task"}).json()
    # Queueing is only allowed while a run is in progress.
    started = seeded_client.post(
        f"/tasks/{task['id']}/run-event",
        json={"type": "run_started", "run_id": uuid.uuid4().hex},
    )
    assert started.status_code == 200, started.text

    ok = seeded_client.post(
        f"/tasks/{task['id']}/comments",
        json={
            "kind": "instruction",
            "body_md": "take it from here",
            "queue_status": "pending",
            "pending_expert_id": "cerebro",
        },
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["pending_expert_id"] == "cerebro"

    # A bogus assignee id (e.g. the old sentinel) is still rejected — on a fresh
    # running task so the "one queued instruction" guard doesn't mask it.
    other = seeded_client.post("/tasks", json={"title": "Another running task"}).json()
    seeded_client.post(
        f"/tasks/{other['id']}/run-event",
        json={"type": "run_started", "run_id": uuid.uuid4().hex},
    )
    bogus = seeded_client.post(
        f"/tasks/{other['id']}/comments",
        json={
            "kind": "instruction",
            "body_md": "x",
            "queue_status": "pending",
            "pending_expert_id": "__auto__",
        },
    )
    assert bogus.status_code == 400, bogus.text
