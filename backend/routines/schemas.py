"""Pydantic request/response schemas for the routines system."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

TriggerType = Literal["manual", "cron", "webhook", "telegram_message"]


class NotifyChannel(BaseModel):
    channel: Literal["telegram"]
    recipient: str


# ── Request Schemas ──────────────────────────────────────────────


class RoutineCreate(BaseModel):
    name: str
    description: str = ""
    plain_english_steps: list[str] | None = None
    dag_json: str | None = None
    trigger_type: TriggerType = "manual"
    cron_expression: str | None = None
    default_runner_id: str | None = None
    approval_gates: list[str] | None = None
    required_connections: list[str] | None = None
    notify_channels: list[NotifyChannel] | None = None
    source: str = "user"
    source_conversation_id: str | None = None


class RoutineUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    plain_english_steps: list[str] | None = None
    dag_json: str | None = None
    trigger_type: TriggerType | None = None
    cron_expression: str | None = None
    default_runner_id: str | None = None
    is_enabled: bool | None = None
    approval_gates: list[str] | None = None
    required_connections: list[str] | None = None
    notify_channels: list[NotifyChannel] | None = None


# ── Response Schemas ─────────────────────────────────────────────


class RoutineResponse(BaseModel):
    id: str
    name: str
    description: str
    plain_english_steps: list[str] | None
    dag_json: str | None
    trigger_type: str
    cron_expression: str | None
    default_runner_id: str | None
    is_enabled: bool
    approval_gates: list[str] | None
    required_connections: list[str] | None
    notify_channels: list[NotifyChannel] | None
    source: str
    source_conversation_id: str | None
    last_run_at: datetime | None
    last_run_status: str | None
    run_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RoutineListResponse(BaseModel):
    routines: list[RoutineResponse]
    total: int
