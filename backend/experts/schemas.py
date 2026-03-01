"""Pydantic request/response schemas for the experts system."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


# ── Embedded Models ──────────────────────────────────────────────


class TeamMember(BaseModel):
    expert_id: str
    role: str
    order: int = 0


# ── Request Schemas ──────────────────────────────────────────────


class ExpertCreate(BaseModel):
    name: str
    description: str
    slug: str | None = None
    domain: str | None = None
    system_prompt: str | None = None
    type: str = "expert"
    source: str = "user"
    is_enabled: bool = True
    is_pinned: bool = False
    tool_access: list[str] | None = None
    policies: dict | None = None
    required_connections: list[str] | None = None
    recommended_routines: list[str] | None = None
    team_members: list[TeamMember] | None = None
    avatar_url: str | None = None
    version: str | None = "1.0.0"


class ExpertUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    slug: str | None = None
    domain: str | None = None
    system_prompt: str | None = None
    type: str | None = None
    source: str | None = None
    is_enabled: bool | None = None
    is_pinned: bool | None = None
    tool_access: list[str] | None = None
    policies: dict | None = None
    required_connections: list[str] | None = None
    recommended_routines: list[str] | None = None
    team_members: list[TeamMember] | None = None
    avatar_url: str | None = None
    version: str | None = None


# ── Response Schemas ─────────────────────────────────────────────


class ExpertResponse(BaseModel):
    id: str
    slug: str | None
    name: str
    domain: str | None
    description: str
    system_prompt: str | None
    type: str
    source: str
    is_enabled: bool
    is_pinned: bool
    tool_access: list[str] | None
    policies: dict | None
    required_connections: list[str] | None
    recommended_routines: list[str] | None
    team_members: list[TeamMember] | None
    avatar_url: str | None
    version: str | None
    last_active_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ExpertListResponse(BaseModel):
    experts: list[ExpertResponse]
    total: int
