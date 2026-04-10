"""FastAPI router for the skills system — /skills/* and /experts/{id}/skills endpoints."""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_

from database import get_db
from models import Expert, ExpertSkill, Skill, _uuid_hex

from .schemas import (
    ExpertSkillAssign,
    ExpertSkillListResponse,
    ExpertSkillResponse,
    ExpertSkillToggle,
    SkillCreate,
    SkillImportRequest,
    SkillImportResponse,
    SkillListResponse,
    SkillResponse,
    SkillUpdate,
)

skills_router = APIRouter(prefix="/skills", tags=["skills"])
expert_skills_router = APIRouter(prefix="/experts", tags=["expert-skills"])


def _slugify(name: str) -> str:
    """Generate a URL-friendly slug from a name."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")


def _skill_to_response(skill: Skill) -> SkillResponse:
    """Convert an ORM Skill to a SkillResponse, parsing JSON text columns."""
    tool_reqs = skill.tool_requirements
    if isinstance(tool_reqs, str):
        tool_reqs = json.loads(tool_reqs)
    return SkillResponse(
        id=skill.id,
        slug=skill.slug,
        name=skill.name,
        description=skill.description,
        category=skill.category,
        icon=skill.icon,
        instructions=skill.instructions,
        tool_requirements=tool_reqs,
        source=skill.source,
        is_default=skill.is_default,
        author=skill.author,
        version=skill.version,
        is_enabled=skill.is_enabled,
        created_at=skill.created_at,
        updated_at=skill.updated_at,
    )


def _expert_skill_to_response(es: ExpertSkill, skill: Skill) -> ExpertSkillResponse:
    return ExpertSkillResponse(
        id=es.id,
        expert_id=es.expert_id,
        skill_id=es.skill_id,
        is_active=es.is_active,
        assigned_at=es.assigned_at,
        skill=_skill_to_response(skill),
    )


# ── Import ───────────────────────────────────────────────────────


@skills_router.post("/import", response_model=SkillImportResponse)
async def import_skill(body: SkillImportRequest):
    """Fetch and parse a skill from a URL, npx command, GitHub shorthand, or raw text."""
    from .importer import fetch_and_parse, parse_skill_markdown

    raw = body.input.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Input is required")

    # Try URL/command resolution first
    parsed = await fetch_and_parse(raw)

    if parsed is None:
        # Input is raw text — parse it directly as markdown
        parsed = parse_skill_markdown(raw)
        if not parsed.instructions:
            parsed.instructions = raw

    if not parsed.name and not parsed.instructions:
        raise HTTPException(
            status_code=422,
            detail="Could not resolve the input to a valid skill. Check the URL or paste the skill content directly.",
        )

    return SkillImportResponse(
        name=parsed.name,
        description=parsed.description,
        instructions=parsed.instructions,
        category=parsed.category,
        icon=parsed.icon,
        author=parsed.author,
        version=parsed.version,
    )


# ── Skills CRUD ──────────────────────────────────────────────────


@skills_router.get("", response_model=SkillListResponse)
def list_skills(
    category: str | None = None,
    source: str | None = None,
    is_default: bool | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(Skill)

    if category is not None:
        q = q.filter(Skill.category == category)
    if source is not None:
        q = q.filter(Skill.source == source)
    if is_default is not None:
        q = q.filter(Skill.is_default == is_default)
    if search:
        pattern = f"%{search}%"
        q = q.filter(or_(Skill.name.ilike(pattern), Skill.description.ilike(pattern)))

    total = q.count()
    skills = (
        q.order_by(Skill.is_default.desc(), Skill.category, Skill.name)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return SkillListResponse(
        skills=[_skill_to_response(s) for s in skills],
        total=total,
    )


@skills_router.get("/{skill_id}", response_model=SkillResponse)
def get_skill(skill_id: str, db=Depends(get_db)):
    skill = db.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    return _skill_to_response(skill)


@skills_router.post("", response_model=SkillResponse, status_code=201)
def create_skill(body: SkillCreate, db=Depends(get_db)):
    slug = body.slug or _slugify(body.name)

    # Ensure slug uniqueness
    existing = db.query(Skill).filter(Skill.slug == slug).first()
    if existing:
        raise HTTPException(status_code=409, detail="Skill with this slug already exists")

    tool_reqs_json = json.dumps(body.tool_requirements) if body.tool_requirements else None

    skill = Skill(
        id=_uuid_hex(),
        slug=slug,
        name=body.name,
        description=body.description,
        instructions=body.instructions,
        category=body.category,
        icon=body.icon,
        tool_requirements=tool_reqs_json,
        source=body.source,
        is_default=body.is_default,
        author=body.author,
        version=body.version,
    )
    db.add(skill)
    db.commit()
    db.refresh(skill)
    return _skill_to_response(skill)


@skills_router.patch("/{skill_id}", response_model=SkillResponse)
def update_skill(skill_id: str, body: SkillUpdate, db=Depends(get_db)):
    skill = db.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")

    updates = body.model_dump(exclude_unset=True)

    # Serialize tool_requirements to JSON string
    if "tool_requirements" in updates and updates["tool_requirements"] is not None:
        updates["tool_requirements"] = json.dumps(updates["tool_requirements"])

    # Check slug uniqueness if being changed
    if "slug" in updates and updates["slug"] is not None:
        existing = db.query(Skill).filter(
            Skill.slug == updates["slug"], Skill.id != skill_id
        ).first()
        if existing:
            raise HTTPException(status_code=409, detail="Skill with this slug already exists")

    for key, val in updates.items():
        setattr(skill, key, val)
    db.commit()
    db.refresh(skill)
    return _skill_to_response(skill)


@skills_router.get("/{skill_id}/assignments", response_model=ExpertSkillListResponse)
def list_skill_assignments(skill_id: str, db=Depends(get_db)):
    """List all expert assignments for a given skill (avoids N+1 from client)."""
    skill = db.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    rows = db.query(ExpertSkill).filter(ExpertSkill.skill_id == skill_id).all()
    return ExpertSkillListResponse(
        skills=[_expert_skill_to_response(es, skill) for es in rows],
        total=len(rows),
    )


@skills_router.delete("/{skill_id}", status_code=204)
def delete_skill(skill_id: str, db=Depends(get_db)):
    skill = db.get(Skill, skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")
    if skill.source == "builtin":
        raise HTTPException(status_code=403, detail="Cannot delete builtin skills")
    db.delete(skill)
    db.commit()
    return Response(status_code=204)


# ── Expert-Skill Assignment ──────────────────────────────────────


@expert_skills_router.get("/{expert_id}/skills", response_model=ExpertSkillListResponse)
def list_expert_skills(expert_id: str, db=Depends(get_db)):
    expert = db.get(Expert, expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail="Expert not found")

    rows = (
        db.query(ExpertSkill, Skill)
        .join(Skill, ExpertSkill.skill_id == Skill.id)
        .filter(ExpertSkill.expert_id == expert_id)
        .order_by(Skill.is_default.desc(), Skill.name)
        .all()
    )
    return ExpertSkillListResponse(
        skills=[_expert_skill_to_response(es, skill) for es, skill in rows],
        total=len(rows),
    )


@expert_skills_router.post("/{expert_id}/skills", response_model=ExpertSkillResponse, status_code=201)
def assign_skill(expert_id: str, body: ExpertSkillAssign, db=Depends(get_db)):
    expert = db.get(Expert, expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail="Expert not found")

    skill = db.get(Skill, body.skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found")

    # Check if already assigned
    existing = (
        db.query(ExpertSkill)
        .filter(ExpertSkill.expert_id == expert_id, ExpertSkill.skill_id == body.skill_id)
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="Skill already assigned to this expert")

    es = ExpertSkill(
        id=_uuid_hex(),
        expert_id=expert_id,
        skill_id=body.skill_id,
    )
    db.add(es)
    db.commit()
    db.refresh(es)
    return _expert_skill_to_response(es, skill)


@expert_skills_router.patch(
    "/{expert_id}/skills/{skill_id}", response_model=ExpertSkillResponse
)
def toggle_expert_skill(
    expert_id: str, skill_id: str, body: ExpertSkillToggle, db=Depends(get_db)
):
    es = (
        db.query(ExpertSkill)
        .filter(ExpertSkill.expert_id == expert_id, ExpertSkill.skill_id == skill_id)
        .first()
    )
    if not es:
        raise HTTPException(status_code=404, detail="Skill assignment not found")

    skill = db.get(Skill, skill_id)
    es.is_active = body.is_active
    db.commit()
    db.refresh(es)
    return _expert_skill_to_response(es, skill)


@expert_skills_router.delete("/{expert_id}/skills/{skill_id}", status_code=204)
def unassign_skill(expert_id: str, skill_id: str, db=Depends(get_db)):
    es = (
        db.query(ExpertSkill)
        .filter(ExpertSkill.expert_id == expert_id, ExpertSkill.skill_id == skill_id)
        .first()
    )
    if not es:
        raise HTTPException(status_code=404, detail="Skill assignment not found")
    db.delete(es)
    db.commit()
    return Response(status_code=204)
