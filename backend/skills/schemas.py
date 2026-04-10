"""Pydantic request/response schemas for the skills system."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


# ── Request Schemas ──────────────────────────────────────────────


class SkillCreate(BaseModel):
    name: str
    description: str
    instructions: str
    slug: str | None = None
    category: str = "general"
    icon: str | None = None
    tool_requirements: list[str] | None = None
    source: str = "user"
    is_default: bool = False
    author: str | None = None
    version: str = "1.0.0"


class SkillUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    slug: str | None = None
    category: str | None = None
    icon: str | None = None
    tool_requirements: list[str] | None = None
    is_default: bool | None = None
    author: str | None = None
    version: str | None = None
    is_enabled: bool | None = None


class SkillImportRequest(BaseModel):
    input: str  # URL, npx command, owner/repo shorthand, or raw markdown


class SkillImportResponse(BaseModel):
    name: str
    description: str
    instructions: str
    category: str = "general"
    icon: str | None = None
    author: str | None = None
    version: str | None = None
    source_url: str | None = None


class ExpertSkillAssign(BaseModel):
    skill_id: str


class ExpertSkillToggle(BaseModel):
    is_active: bool


# ── Response Schemas ─────────────────────────────────────────────


class SkillResponse(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    category: str
    icon: str | None
    instructions: str
    tool_requirements: list[str] | None
    source: str
    is_default: bool
    author: str | None
    version: str
    is_enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class SkillListResponse(BaseModel):
    skills: list[SkillResponse]
    total: int


class ExpertSkillResponse(BaseModel):
    id: str
    expert_id: str
    skill_id: str
    is_active: bool
    assigned_at: datetime
    skill: SkillResponse

    model_config = {"from_attributes": True}


class ExpertSkillListResponse(BaseModel):
    skills: list[ExpertSkillResponse]
    total: int
