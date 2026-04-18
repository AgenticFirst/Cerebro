"""Contract tests for the expert API paths the Electron runtime/installer depend on.

The `installer.ts` and `runtime.ts` code reaches the backend via plain HTTP for:

  - `GET  /experts?enabled=true`       — installAll() enumerates experts to materialize
  - `GET  /experts/{id}`               — runtime.fetchExpertName() when the slug is not in
                                         the on-disk index yet
  - `GET  /experts/{id}/skills`        — installer writes skills alongside the agent .md
  - `POST /experts`                    — UI "Create Expert" flow
  - `DELETE /experts/{id}`             — UI "Remove Expert" flow

These tests guard the *shape* of those responses and the read-after-write guarantee that
the installer relies on (create → fetch must succeed with no retry/backoff).
"""

import uuid


def test_create_then_get_returns_same_row_immediately(client):
    """Regression guard: installer does `POST /experts` then immediately fetches the same id.

    If the write is not visible on the next read, the installer races and produces a
    stale on-disk .md file — which is one path to the generic "Claude Code exited
    unexpectedly" error in expert chats.
    """
    create = client.post("/experts", json={
        "name": "Design Expert",
        "description": "Helps with design decisions",
        "system_prompt": "You are a design expert.",
        "domain": "creative",
    })
    assert create.status_code == 201, create.text
    expert_id = create.json()["id"]

    # Immediate read — no sleep, no retry.
    fetched = client.get(f"/experts/{expert_id}")
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["id"] == expert_id
    assert body["name"] == "Design Expert"
    assert body["system_prompt"] == "You are a design expert."
    assert body["domain"] == "creative"
    assert body["is_enabled"] is True


def test_get_expert_returns_fields_installer_requires(client):
    """installer.ts reads id, name, description, system_prompt, domain, is_enabled.

    If any of these keys ever go missing the agent .md will be written with blanks.
    """
    create = client.post("/experts", json={
        "name": "Code Reviewer",
        "description": "Reviews code for correctness",
        "system_prompt": "You review code.",
        "domain": "engineering",
    })
    expert_id = create.json()["id"]

    body = client.get(f"/experts/{expert_id}").json()
    for key in ("id", "name", "description", "system_prompt", "domain", "is_enabled"):
        assert key in body, f"installer depends on '{key}' in GET /experts/:id response"


def test_list_experts_shape_matches_installer_expectation(client):
    """installer.ts iterates `body.experts` from GET /experts."""
    client.post("/experts", json={"name": "A", "description": "first"})
    client.post("/experts", json={"name": "B", "description": "second"})

    r = client.get("/experts")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body.get("experts"), list)
    assert len(body["experts"]) == 2
    # Each row must carry the same core fields installer needs per-expert.
    for row in body["experts"]:
        for key in ("id", "name", "description", "is_enabled"):
            assert key in row


def test_expert_skills_endpoint_returns_list_shape(client):
    """installer.ts fetches `GET /experts/{id}/skills` and expects `.skills` array."""
    create = client.post("/experts", json={
        "name": "Skilled Expert",
        "description": "Has skills",
    })
    expert_id = create.json()["id"]

    r = client.get(f"/experts/{expert_id}/skills")
    assert r.status_code == 200
    body = r.json()
    assert "skills" in body
    assert isinstance(body["skills"], list)


def test_delete_then_get_returns_404(client):
    """After DELETE, the runtime's fetchExpertName() must see 404 so it can surface
    a structured 'Expert not found' error rather than silently re-deriving a dead slug."""
    create = client.post("/experts", json={
        "name": "Ephemeral",
        "description": "Short-lived",
    })
    expert_id = create.json()["id"]

    assert client.delete(f"/experts/{expert_id}").status_code == 204
    assert client.get(f"/experts/{expert_id}").status_code == 404


def test_get_unknown_expert_returns_404(client):
    """Unknown id must be a 404 (not a 500 or empty 200) so the runtime can branch on it."""
    assert client.get(f"/experts/{uuid.uuid4().hex}").status_code == 404


def test_create_with_minimal_payload_succeeds(client):
    """The UI's 'Create Expert' modal submits the minimal shape installed by runtime —
    name + description only. Anything stricter would break the expert-creation flow
    that triggers the race in the first place."""
    r = client.post("/experts", json={
        "name": "Minimal",
        "description": "Bare minimum",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["id"]
    # These defaults are what installer encodes into the frontmatter.
    assert body["is_enabled"] is True
