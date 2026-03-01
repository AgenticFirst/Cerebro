"""Tests for expert CRUD endpoints."""

import uuid


def _hex_id() -> str:
    return uuid.uuid4().hex


# ── Basic CRUD ───────────────────────────────────────────────────


def test_list_experts_empty(client):
    r = client.get("/experts")
    assert r.status_code == 200
    body = r.json()
    assert body["experts"] == []
    assert body["total"] == 0


def test_create_expert(client):
    r = client.post("/experts", json={
        "name": "Fitness Coach",
        "description": "Helps with workout planning and nutrition",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Fitness Coach"
    assert body["description"] == "Helps with workout planning and nutrition"
    assert body["type"] == "expert"
    assert body["source"] == "user"
    assert body["is_enabled"] is True
    assert body["is_pinned"] is False
    assert body["version"] == "1.0.0"
    assert "id" in body
    assert "created_at" in body
    assert "updated_at" in body


def test_get_expert(client):
    r = client.post("/experts", json={
        "name": "Writer",
        "description": "Creative writing assistant",
    })
    expert_id = r.json()["id"]

    r = client.get(f"/experts/{expert_id}")
    assert r.status_code == 200
    assert r.json()["name"] == "Writer"


def test_delete_expert(client):
    r = client.post("/experts", json={
        "name": "Temp",
        "description": "Temporary expert",
    })
    expert_id = r.json()["id"]

    r = client.delete(f"/experts/{expert_id}")
    assert r.status_code == 204

    r = client.get(f"/experts/{expert_id}")
    assert r.status_code == 404


# ── Full Fields ──────────────────────────────────────────────────


def test_create_expert_with_all_fields(client):
    r = client.post("/experts", json={
        "name": "Executive Assistant",
        "description": "Manages calendar and communications",
        "slug": "exec-assistant",
        "domain": "productivity",
        "system_prompt": "You are a professional executive assistant.",
        "type": "expert",
        "source": "user",
        "is_enabled": True,
        "is_pinned": True,
        "tool_access": ["calendar", "email"],
        "policies": {"max_meetings_per_day": 8, "block_weekends": True},
        "required_connections": ["google-calendar", "gmail"],
        "recommended_routines": ["daily-briefing", "weekly-review"],
        "avatar_url": "https://example.com/avatar.png",
        "version": "2.0.0",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["slug"] == "exec-assistant"
    assert body["domain"] == "productivity"
    assert body["system_prompt"] == "You are a professional executive assistant."
    assert body["is_pinned"] is True
    assert body["tool_access"] == ["calendar", "email"]
    assert body["policies"] == {"max_meetings_per_day": 8, "block_weekends": True}
    assert body["required_connections"] == ["google-calendar", "gmail"]
    assert body["recommended_routines"] == ["daily-briefing", "weekly-review"]
    assert body["avatar_url"] == "https://example.com/avatar.png"
    assert body["version"] == "2.0.0"


# ── Teams ────────────────────────────────────────────────────────


def test_create_team_with_members(client):
    # Create two experts first
    r1 = client.post("/experts", json={"name": "Researcher", "description": "Research expert"})
    r2 = client.post("/experts", json={"name": "Writer", "description": "Writing expert"})
    id1 = r1.json()["id"]
    id2 = r2.json()["id"]

    r = client.post("/experts", json={
        "name": "Content Team",
        "description": "Research and write content",
        "type": "team",
        "team_members": [
            {"expert_id": id1, "role": "lead", "order": 0},
            {"expert_id": id2, "role": "member", "order": 1},
        ],
    })
    assert r.status_code == 201
    body = r.json()
    assert body["type"] == "team"
    assert len(body["team_members"]) == 2
    assert body["team_members"][0]["expert_id"] == id1
    assert body["team_members"][0]["role"] == "lead"
    assert body["team_members"][1]["expert_id"] == id2


# ── Partial Update ───────────────────────────────────────────────


def test_patch_updates_only_sent_fields(client):
    r = client.post("/experts", json={
        "name": "Original Name",
        "description": "Original description",
        "domain": "health",
    })
    expert_id = r.json()["id"]

    r = client.patch(f"/experts/{expert_id}", json={"name": "Updated Name"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Updated Name"
    assert body["description"] == "Original description"
    assert body["domain"] == "health"


def test_patch_toggle_flags(client):
    r = client.post("/experts", json={
        "name": "Toggleable",
        "description": "Toggle test",
    })
    expert_id = r.json()["id"]
    assert r.json()["is_enabled"] is True
    assert r.json()["is_pinned"] is False

    r = client.patch(f"/experts/{expert_id}", json={"is_enabled": False, "is_pinned": True})
    assert r.status_code == 200
    assert r.json()["is_enabled"] is False
    assert r.json()["is_pinned"] is True


# ── Slug Uniqueness ──────────────────────────────────────────────


def test_duplicate_slug_returns_409(client):
    client.post("/experts", json={
        "name": "First",
        "description": "First expert",
        "slug": "unique-slug",
    })
    r = client.post("/experts", json={
        "name": "Second",
        "description": "Second expert",
        "slug": "unique-slug",
    })
    assert r.status_code == 409


# ── Builtin Protection ──────────────────────────────────────────


def test_delete_builtin_returns_403(client):
    r = client.post("/experts", json={
        "name": "Builtin Expert",
        "description": "System expert",
        "source": "builtin",
    })
    expert_id = r.json()["id"]

    r = client.delete(f"/experts/{expert_id}")
    assert r.status_code == 403


# ── Not Found ────────────────────────────────────────────────────


def test_get_nonexistent_returns_404(client):
    r = client.get(f"/experts/{_hex_id()}")
    assert r.status_code == 404


def test_patch_nonexistent_returns_404(client):
    r = client.patch(f"/experts/{_hex_id()}", json={"name": "Ghost"})
    assert r.status_code == 404


def test_delete_nonexistent_returns_404(client):
    r = client.delete(f"/experts/{_hex_id()}")
    assert r.status_code == 404


# ── Filters ──────────────────────────────────────────────────────


def test_filter_by_type(client):
    client.post("/experts", json={"name": "Solo", "description": "Solo expert", "type": "expert"})
    client.post("/experts", json={"name": "Team", "description": "A team", "type": "team"})

    r = client.get("/experts", params={"type": "team"})
    body = r.json()
    assert body["total"] == 1
    assert body["experts"][0]["name"] == "Team"


def test_filter_by_is_enabled(client):
    client.post("/experts", json={"name": "Active", "description": "Active", "is_enabled": True})
    client.post("/experts", json={"name": "Disabled", "description": "Disabled", "is_enabled": False})

    r = client.get("/experts", params={"is_enabled": True})
    body = r.json()
    assert body["total"] == 1
    assert body["experts"][0]["name"] == "Active"


def test_filter_by_search(client):
    client.post("/experts", json={"name": "Fitness Coach", "description": "Workout planning"})
    client.post("/experts", json={"name": "Writer", "description": "Creative writing"})

    r = client.get("/experts", params={"search": "fitness"})
    body = r.json()
    assert body["total"] == 1
    assert body["experts"][0]["name"] == "Fitness Coach"

    # Search in description too
    r = client.get("/experts", params={"search": "creative"})
    body = r.json()
    assert body["total"] == 1
    assert body["experts"][0]["name"] == "Writer"


def test_pinned_first_ordering(client):
    client.post("/experts", json={"name": "Alpha", "description": "A", "is_pinned": False})
    client.post("/experts", json={"name": "Beta", "description": "B", "is_pinned": True})
    client.post("/experts", json={"name": "Charlie", "description": "C", "is_pinned": False})

    r = client.get("/experts")
    names = [e["name"] for e in r.json()["experts"]]
    assert names[0] == "Beta"  # pinned first
    assert names[1] == "Alpha"  # then alphabetical
    assert names[2] == "Charlie"
