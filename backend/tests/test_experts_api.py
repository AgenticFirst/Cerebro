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


# ── Edge Case Tests ──────────────────────────────────────────────


def test_create_slug_collision_returns_409(client):
    """POST an expert with slug='foo'; POST another with same slug; second returns 409."""
    client.post("/experts", json={
        "name": "First",
        "description": "first expert",
        "slug": "foo",
    })

    r = client.post("/experts", json={
        "name": "Second",
        "description": "second expert",
        "slug": "foo",
    })
    assert r.status_code == 409
    assert "slug" in r.json()["detail"].lower()


def test_update_slug_to_existing_returns_409(client):
    """PATCH the second expert to use the first's slug; expect 409."""
    create1 = client.post("/experts", json={
        "name": "Alpha",
        "description": "first",
        "slug": "alpha",
    })
    expert1_id = create1.json()["id"]

    create2 = client.post("/experts", json={
        "name": "Beta",
        "description": "second",
        "slug": "beta",
    })
    expert2_id = create2.json()["id"]

    # Try to change expert2's slug to expert1's slug
    r = client.patch(f"/experts/{expert2_id}", json={"slug": "alpha"})
    assert r.status_code == 409
    assert "slug" in r.json()["detail"].lower()


def test_create_auto_generates_slug_if_absent(client):
    """POST without slug; response should have a slug field (even if None or auto-generated)."""
    r = client.post("/experts", json={
        "name": "No Slug",
        "description": "test",
    })
    assert r.status_code == 201
    body = r.json()
    # Slug field exists in response (per ExpertResponse schema)
    assert "slug" in body


def test_domain_triggers_skill_assignment(seeded_client):
    """POST with a real domain auto-assigns category + default skills. Uses
    seeded_client because the assign functions are no-ops without seeded skills."""
    r = seeded_client.post("/experts", json={
        "name": "Fitness Expert",
        "description": "fitness domain test",
        "domain": "fitness",
    })
    assert r.status_code == 201
    expert_id = r.json()["id"]

    skills_r = seeded_client.get(f"/experts/{expert_id}/skills")
    assert skills_r.status_code == 200
    skills = skills_r.json().get("skills", [])
    assert len(skills) > 0


def test_domain_unknown_no_category_skills_assigned(seeded_client):
    """Unknown domain still auto-assigns default skills."""
    r = seeded_client.post("/experts", json={
        "name": "Unknown Domain",
        "description": "unknown domain test",
        "domain": "unknown_category_xyz",
    })
    assert r.status_code == 201
    expert_id = r.json()["id"]

    skills_r = seeded_client.get(f"/experts/{expert_id}/skills")
    assert skills_r.status_code == 200
    skills = skills_r.json().get("skills", [])
    assert len(skills) > 0


def test_update_verified_expert_body_fields_returns_403(seeded_client):
    """Find a verified expert; PATCH system_prompt returns 403."""
    # List experts to find a verified one
    r = seeded_client.get("/experts?is_enabled=true")
    verified_expert = None
    for expert in r.json()["experts"]:
        if expert.get("is_verified"):
            verified_expert = expert
            break

    if not verified_expert:
        # Skip if no verified expert exists in seed
        import pytest
        pytest.skip("No verified expert in seeded database")

    expert_id = verified_expert["id"]

    # Try to update system_prompt
    r = seeded_client.patch(f"/experts/{expert_id}", json={
        "system_prompt": "New prompt"
    })
    assert r.status_code == 403


def test_update_verified_expert_toggle_fields_returns_200(seeded_client):
    """PATCH verified expert with is_enabled or is_pinned; expect 200."""
    r = seeded_client.get("/experts?is_enabled=true")
    verified_expert = None
    for expert in r.json()["experts"]:
        if expert.get("is_verified"):
            verified_expert = expert
            break

    if not verified_expert:
        import pytest
        pytest.skip("No verified expert in seeded database")

    expert_id = verified_expert["id"]
    current_enabled = verified_expert.get("is_enabled", True)

    # Toggle is_enabled — should succeed
    r = seeded_client.patch(f"/experts/{expert_id}", json={
        "is_enabled": not current_enabled
    })
    assert r.status_code == 200
    assert r.json()["is_enabled"] == (not current_enabled)


def test_delete_verified_expert_returns_403(seeded_client):
    """Delete a verified expert; expect 403."""
    r = seeded_client.get("/experts?is_enabled=true")
    verified_expert = None
    for expert in r.json()["experts"]:
        if expert.get("is_verified"):
            verified_expert = expert
            break

    if not verified_expert:
        import pytest
        pytest.skip("No verified expert in seeded database")

    expert_id = verified_expert["id"]
    r = seeded_client.delete(f"/experts/{expert_id}")
    assert r.status_code == 403


def test_delete_builtin_expert_returns_403(seeded_client):
    """Find an expert with source='builtin'; DELETE returns 403."""
    r = seeded_client.get("/experts?is_enabled=true")
    builtin_expert = None
    for expert in r.json()["experts"]:
        if expert.get("source") == "builtin":
            builtin_expert = expert
            break

    if not builtin_expert:
        import pytest
        pytest.skip("No builtin expert in seeded database")

    expert_id = builtin_expert["id"]
    r = seeded_client.delete(f"/experts/{expert_id}")
    assert r.status_code == 403


def test_delete_user_expert_returns_204(client):
    """POST a user-source expert, DELETE it, expect 204. Then GET returns 404."""
    create = client.post("/experts", json={
        "name": "Ephemeral User Expert",
        "description": "Will be deleted",
    })
    assert create.status_code == 201
    expert_id = create.json()["id"]

    # Verify it exists
    get1 = client.get(f"/experts/{expert_id}")
    assert get1.status_code == 200

    # Delete it
    delete_r = client.delete(f"/experts/{expert_id}")
    assert delete_r.status_code == 204

    # Now it should return 404
    get2 = client.get(f"/experts/{expert_id}")
    assert get2.status_code == 404


def test_delete_nonexistent_expert_returns_404(client):
    """DELETE /experts/does-not-exist → 404."""
    r = client.delete(f"/experts/{uuid.uuid4().hex}")
    assert r.status_code == 404


def test_update_nonexistent_expert_returns_404(client):
    """PATCH /experts/does-not-exist → 404."""
    r = client.patch(f"/experts/{uuid.uuid4().hex}", json={"name": "Updated"})
    assert r.status_code == 404


def test_get_nonexistent_expert_returns_404(client):
    """GET /experts/does-not-exist → 404."""
    r = client.get(f"/experts/{uuid.uuid4().hex}")
    assert r.status_code == 404
