"""Tests for the verified teams data contract + edit protection.

The `client` fixture triggers FastAPI's lifespan, which seeds the 4 verified
teams (see `experts/seed.py::VERIFIED_TEAMS`). These tests pin that contract.
"""

from __future__ import annotations

import pytest

from experts.seed import seed_verified_teams


@pytest.fixture()
def client(seeded_client):
    """Override the default `client` fixture in this module so tests here
    receive a client backed by a DB that has been populated by the lifespan
    seeders (builtin skills + verified experts + verified teams).
    """
    return seeded_client


EXPECTED_TEAM_SLUGS = {
    "market-research-and-business-plan",
    "app-build-team",
    "product-launch-team",
    "code-review-team",
}


def _teams(client) -> list[dict]:
    r = client.get("/experts", params={"type": "team", "limit": 200})
    assert r.status_code == 200
    return r.json()["experts"]


def _team_by_slug(client, slug: str) -> dict:
    for t in _teams(client):
        if t["slug"] == slug:
            return t
    raise AssertionError(f"team '{slug}' not seeded")


# ── 1. Seed creates all four teams ─────────────────────────────────


def test_seed_creates_all_four_teams(client):
    teams = _teams(client)
    slugs = {t["slug"] for t in teams}
    assert EXPECTED_TEAM_SLUGS.issubset(slugs), f"missing teams: {EXPECTED_TEAM_SLUGS - slugs}"
    # Every seeded team is verified + builtin.
    for t in teams:
        if t["slug"] in EXPECTED_TEAM_SLUGS:
            assert t["type"] == "team"
            assert t["is_verified"] is True
            assert t["source"] == "builtin"


# ── 2-5. Each team has the right members + strategy ─────────────────


def test_market_research_team_has_correct_members(client):
    team = _team_by_slug(client, "market-research-and-business-plan")
    assert team["strategy"] == "sequential"
    assert team["coordinator_prompt"]
    assert len(team["coordinator_prompt"].strip()) > 100
    ordered = sorted(team["team_members"], key=lambda m: m["order"])
    member_ids = [m["expert_id"] for m in ordered]
    # Map ids back to slugs via /experts
    all_experts = client.get("/experts", params={"limit": 200}).json()["experts"]
    by_id = {e["id"]: e["slug"] for e in all_experts}
    assert [by_id[mid] for mid in member_ids] == [
        "data-analyst",
        "growth-marketer",
        "product-manager",
    ]


def test_app_build_team_has_correct_members(client):
    team = _team_by_slug(client, "app-build-team")
    assert team["strategy"] == "sequential"
    ordered = sorted(team["team_members"], key=lambda m: m["order"])
    all_experts = client.get("/experts", params={"limit": 200}).json()["experts"]
    by_id = {e["id"]: e["slug"] for e in all_experts}
    assert [by_id[m["expert_id"]] for m in ordered] == [
        "product-designer",
        "full-stack-engineer",
        "backend-engineer",
        "frontend-engineer",
        "security-engineer",
    ]


def test_product_launch_team_has_correct_members(client):
    team = _team_by_slug(client, "product-launch-team")
    assert team["strategy"] == "parallel"
    ordered = sorted(team["team_members"], key=lambda m: m["order"])
    all_experts = client.get("/experts", params={"limit": 200}).json()["experts"]
    by_id = {e["id"]: e["slug"] for e in all_experts}
    assert [by_id[m["expert_id"]] for m in ordered] == [
        "growth-marketer",
        "technical-writer",
        "customer-support-specialist",
        "product-manager",
    ]


def test_code_review_team_has_correct_members(client):
    team = _team_by_slug(client, "code-review-team")
    assert team["strategy"] == "parallel"
    ordered = sorted(team["team_members"], key=lambda m: m["order"])
    all_experts = client.get("/experts", params={"limit": 200}).json()["experts"]
    by_id = {e["id"]: e["slug"] for e in all_experts}
    assert [by_id[m["expert_id"]] for m in ordered] == [
        "security-engineer",
        "frontend-engineer",
        "backend-engineer",
        "full-stack-engineer",
    ]


# ── 6-8. Edit protection ────────────────────────────────────────────


def test_verified_team_rejects_content_edits(client):
    team = _team_by_slug(client, "market-research-and-business-plan")
    tid = team["id"]

    for field, val in [
        ("name", "Tampered Name"),
        ("description", "tampered description"),
        ("coordinator_prompt", "new prompt"),
        ("strategy", "auto"),
        (
            "team_members",
            [{"expert_id": team["team_members"][0]["expert_id"], "role": "x", "order": 0}],
        ),
    ]:
        r = client.patch(f"/experts/{tid}", json={field: val})
        assert r.status_code == 403, f"expected 403 when PATCHing {field}, got {r.status_code}"


def test_verified_team_allows_toggle_edits(client):
    team = _team_by_slug(client, "app-build-team")
    tid = team["id"]

    r = client.patch(f"/experts/{tid}", json={"is_pinned": True})
    assert r.status_code == 200
    assert r.json()["is_pinned"] is True

    r = client.patch(f"/experts/{tid}", json={"is_enabled": False})
    assert r.status_code == 200
    assert r.json()["is_enabled"] is False

    # Restore so later tests see the default state.
    client.patch(f"/experts/{tid}", json={"is_pinned": False, "is_enabled": True})


def test_verified_team_rejects_delete(client):
    team = _team_by_slug(client, "product-launch-team")
    r = client.delete(f"/experts/{team['id']}")
    assert r.status_code == 403


# ── 9. Seed idempotency preserves toggles ───────────────────────────


def test_seed_is_idempotent_preserves_toggles(client):
    team = _team_by_slug(client, "code-review-team")
    tid = team["id"]

    r = client.patch(f"/experts/{tid}", json={"is_pinned": True})
    assert r.status_code == 200
    assert r.json()["is_pinned"] is True

    # Re-run the seeder on a fresh session against the same DB.
    # Import lazily — `SessionLocal` is only assigned after init_db() runs.
    import database
    db = database.SessionLocal()
    try:
        seed_verified_teams(db)
    finally:
        db.close()

    r = client.get(f"/experts/{tid}")
    body = r.json()
    assert body["is_pinned"] is True, "seed must preserve user-toggled is_pinned"
    # Content should still match seed.
    assert body["strategy"] == "parallel"

    # Restore.
    client.patch(f"/experts/{tid}", json={"is_pinned": False})


# ── 10. Member references resolve ───────────────────────────────────


def test_team_member_ids_resolve_to_real_experts(client):
    teams = [t for t in _teams(client) if t["slug"] in EXPECTED_TEAM_SLUGS]
    assert len(teams) == 4

    all_experts = client.get("/experts", params={"limit": 200}).json()["experts"]
    by_id = {e["id"]: e for e in all_experts}

    for team in teams:
        for m in team["team_members"]:
            eid = m["expert_id"]
            assert eid in by_id, f"{team['slug']} references missing expert {eid}"
            member = by_id[eid]
            assert member["is_verified"] is True, (
                f"{team['slug']} member {member['slug']} should be verified"
            )
            assert member["type"] == "expert", (
                f"{team['slug']} member {member['slug']} must be a regular expert, not a team"
            )
