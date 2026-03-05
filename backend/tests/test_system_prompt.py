"""Tests for system prompt assembly (recall.py)."""

import json
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from sqlalchemy.orm import Session

from database import get_db
from models import Expert, Routine, Setting, _utcnow


def _hex_id() -> str:
    return uuid.uuid4().hex


def _db(client) -> Session:
    """Get a database session from the test client."""
    return next(get_db())


def _create_expert(
    db: Session,
    *,
    name: str = "Test Expert",
    domain: str | None = None,
    description: str = "A test expert",
    is_enabled: bool = True,
    last_active_at: datetime | None = None,
    expert_type: str = "expert",
    team_members: str | None = None,
    system_prompt: str | None = None,
) -> Expert:
    expert = Expert(
        id=_hex_id(),
        name=name,
        domain=domain,
        description=description,
        is_enabled=is_enabled,
        last_active_at=last_active_at,
        type=expert_type,
        team_members=team_members,
        system_prompt=system_prompt,
    )
    db.add(expert)
    db.commit()
    return expert


def _create_routine(
    db: Session,
    *,
    name: str = "Test Routine",
    description: str = "A test routine",
    is_enabled: bool = True,
    trigger_type: str = "manual",
    cron_expression: str | None = None,
    last_run_at: datetime | None = None,
) -> Routine:
    routine = Routine(
        id=_hex_id(),
        name=name,
        description=description,
        is_enabled=is_enabled,
        trigger_type=trigger_type,
        cron_expression=cron_expression,
        last_run_at=last_run_at,
    )
    db.add(routine)
    db.commit()
    return routine


# ── Base prompt tests ─────────────────────────────────────────────


def test_base_prompt_contains_identity(client):
    """Base prompt contains Identity & Role section."""
    r = client.post("/memory/context", json={})
    assert r.status_code == 200
    prompt = r.json()["system_prompt"]
    assert "## Identity & Role" in prompt
    assert "You are Cerebro" in prompt


def test_base_prompt_contains_routing(client):
    """Base prompt contains <routing> decision tree."""
    r = client.post("/memory/context", json={})
    prompt = r.json()["system_prompt"]
    assert "<routing>" in prompt
    assert "</routing>" in prompt
    assert "WHEN the user" in prompt
    assert "web_search" in prompt


# ── Expert catalog tests ─────────────────────────────────────────


def test_empty_expert_catalog(client):
    """Empty expert catalog message when no experts exist."""
    r = client.post("/memory/context", json={
        "include_expert_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    assert "## Available Experts" in prompt
    assert "No experts configured yet" in prompt
    assert "propose_expert" in prompt


def test_expert_catalog_shows_only_enabled(client):
    """Expert catalog shows only enabled experts."""
    db = _db(client)
    _create_expert(db, name="Enabled Expert", is_enabled=True)
    _create_expert(db, name="Disabled Expert", is_enabled=False)

    r = client.post("/memory/context", json={
        "include_expert_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    assert "Enabled Expert" in prompt
    assert "Disabled Expert" not in prompt


def test_expert_catalog_respects_limit(client):
    """Expert catalog respects 20-expert limit and shows overflow note."""
    db = _db(client)
    now = datetime.now(timezone.utc)
    for i in range(25):
        _create_expert(
            db,
            name=f"Expert {i:02d}",
            is_enabled=True,
            last_active_at=now - timedelta(hours=i),
        )

    r = client.post("/memory/context", json={
        "include_expert_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    # Should show first 20 (most recent), not 24
    assert "Expert 00" in prompt
    assert "Expert 19" in prompt
    assert "Expert 20" not in prompt
    assert "25 experts total" in prompt
    assert "list_experts" in prompt


def test_expert_catalog_ordered_by_last_active(client):
    """Expert catalog ordered by last_active_at desc."""
    db = _db(client)
    now = datetime.now(timezone.utc)
    _create_expert(db, name="Old Expert", last_active_at=now - timedelta(days=10))
    _create_expert(db, name="New Expert", last_active_at=now)
    _create_expert(db, name="Null Expert")  # no last_active_at

    r = client.post("/memory/context", json={
        "include_expert_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    # "New Expert" should appear before "Old Expert"
    assert prompt.index("New Expert") < prompt.index("Old Expert")
    # "Null Expert" should appear last (nullslast)
    assert prompt.index("Old Expert") < prompt.index("Null Expert")


def test_expert_catalog_not_injected_when_flag_false(client):
    """Expert catalog not injected when flag is False."""
    db = _db(client)
    _create_expert(db, name="Some Expert")

    r = client.post("/memory/context", json={
        "include_expert_catalog": False,
    })
    prompt = r.json()["system_prompt"]
    assert "## Available Experts" not in prompt
    assert "Some Expert" not in prompt


# ── Routine catalog tests ────────────────────────────────────────


def test_empty_routine_catalog(client):
    """Empty routine catalog message when no routines exist."""
    r = client.post("/memory/context", json={
        "include_routine_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    assert "## Available Routines" in prompt
    assert "No routines saved yet" in prompt
    assert "propose_routine" in prompt


def test_routine_catalog_shows_only_enabled(client):
    """Routine catalog shows only enabled routines."""
    db = _db(client)
    _create_routine(db, name="Active Routine", is_enabled=True)
    _create_routine(db, name="Disabled Routine", is_enabled=False)

    r = client.post("/memory/context", json={
        "include_routine_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    assert "Active Routine" in prompt
    assert "Disabled Routine" not in prompt


def test_routine_catalog_includes_cron(client):
    """Routine catalog includes cron expressions."""
    db = _db(client)
    _create_routine(
        db,
        name="Morning News",
        description="Fetch and summarize daily news",
        trigger_type="cron",
        cron_expression="0 9 * * *",
    )

    r = client.post("/memory/context", json={
        "include_routine_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    assert "Morning News" in prompt
    assert "trigger: cron" in prompt
    assert "`0 9 * * *`" in prompt


# ── Guidance section tests ───────────────────────────────────────


def test_expert_proposal_guidance_in_personal_scope(client):
    """Expert proposal guidance present in personal scope."""
    r = client.post("/memory/context", json={})
    prompt = r.json()["system_prompt"]
    assert "## Expert Proposals" in prompt
    assert "propose_expert" in prompt


def test_expert_proposal_guidance_absent_in_expert_scope(client):
    """Expert proposal guidance absent in expert scope."""
    db = _db(client)
    expert = _create_expert(db, name="My Expert", system_prompt="You are a helpful expert.")

    r = client.post("/memory/context", json={
        "scope": "expert",
        "scope_id": expert.id,
    })
    prompt = r.json()["system_prompt"]
    assert "## Expert Proposals" not in prompt


def test_routine_proposal_guidance_in_personal_scope(client):
    """Routine proposal guidance present in personal scope."""
    r = client.post("/memory/context", json={})
    prompt = r.json()["system_prompt"]
    assert "## Routine Proposals" in prompt
    assert "propose_routine" in prompt


# ── Section ordering tests ───────────────────────────────────────


def test_full_prompt_section_ordering(client):
    """Full prompt section ordering is correct."""
    db = _db(client)
    _create_expert(db, name="Test Expert", domain="testing")
    _create_routine(db, name="Test Routine")

    # Add profile and style context files
    db.add(Setting(key="memory:context:profile", value="The user is a software engineer."))
    db.add(Setting(key="memory:context:style", value="Be brief and technical."))
    db.commit()

    r = client.post("/memory/context", json={
        "include_expert_catalog": True,
        "include_routine_catalog": True,
    })
    prompt = r.json()["system_prompt"]

    # Verify ordering: Identity -> Expert Catalog -> Routine Catalog ->
    # Expert Guidance -> Routine Guidance -> Profile -> Style
    identity_pos = prompt.index("## Identity & Role")
    expert_cat_pos = prompt.index("## Available Experts")
    routine_cat_pos = prompt.index("## Available Routines")
    expert_guide_pos = prompt.index("## Expert Proposals")
    routine_guide_pos = prompt.index("## Routine Proposals")
    profile_pos = prompt.index("## About the User")
    style_pos = prompt.index("## Communication Style")

    assert identity_pos < expert_cat_pos
    assert expert_cat_pos < routine_cat_pos
    assert routine_cat_pos < expert_guide_pos
    assert expert_guide_pos < routine_guide_pos
    assert routine_guide_pos < profile_pos
    assert profile_pos < style_pos


# ── Backward compatibility tests ─────────────────────────────────


def test_backward_compatibility_no_flags(client):
    """Backward compatibility — no flags = no catalogs."""
    db = _db(client)
    _create_expert(db, name="Hidden Expert")
    _create_routine(db, name="Hidden Routine")

    r = client.post("/memory/context", json={})
    prompt = r.json()["system_prompt"]
    assert "## Available Experts" not in prompt
    assert "## Available Routines" not in prompt
    assert "Hidden Expert" not in prompt
    assert "Hidden Routine" not in prompt


# ── Team-type expert test ────────────────────────────────────────


def test_team_expert_shows_member_count(client):
    """Team-type expert in catalog shows member count."""
    db = _db(client)
    members = [
        {"expert_id": _hex_id(), "role": "researcher", "order": 0},
        {"expert_id": _hex_id(), "role": "writer", "order": 1},
        {"expert_id": _hex_id(), "role": "editor", "order": 2},
    ]
    _create_expert(
        db,
        name="Content Team",
        description="A team for content creation",
        expert_type="team",
        team_members=json.dumps(members),
    )

    r = client.post("/memory/context", json={
        "include_expert_catalog": True,
    })
    prompt = r.json()["system_prompt"]
    assert "Content Team" in prompt
    assert "(type: team, 3 members)" in prompt


# ── Expert-scoped prompt test ────────────────────────────────────


def test_expert_scoped_prompt_uses_expert_system_prompt(client):
    """Expert-scoped prompt uses expert's own system_prompt."""
    db = _db(client)
    expert = _create_expert(
        db,
        name="Finance Expert",
        system_prompt="You are a financial advisor. Be precise with numbers.",
    )

    r = client.post("/memory/context", json={
        "scope": "expert",
        "scope_id": expert.id,
    })
    prompt = r.json()["system_prompt"]
    assert "You are a financial advisor" in prompt
    assert "## Identity & Role" not in prompt
