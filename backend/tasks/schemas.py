"""Pydantic schemas for /tasks/* endpoints."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel

from engine.schemas import RunRecordResponse


# ── Plan ──────────────────────────────────────────────────────────


class PlanPhase(BaseModel):
    id: str
    name: str
    description: str
    expert_slug: str | None = None
    needs_new_expert: bool = False
    new_expert: dict | None = None
    status: Literal["pending", "running", "completed", "failed", "skipped"] = "pending"
    child_run_id: str | None = None
    summary: str | None = None


class TaskPlan(BaseModel):
    phases: list[PlanPhase]


# ── Clarification ────────────────────────────────────────────────


class ClarificationQuestion(BaseModel):
    id: str
    q: str
    kind: Literal["text", "select", "bool"]
    options: list[str] | None = None
    default: Any | None = None
    placeholder: str | None = None


class ClarificationAnswer(BaseModel):
    id: str
    answer: Any


class ClarifySubmit(BaseModel):
    answers: list[ClarificationAnswer]


class ClarifyResponse(BaseModel):
    task_id: str
    answers_block: str


# ── Run info (dev server) ────────────────────────────────────────


class RunInfo(BaseModel):
    preview_type: Literal["web", "expo", "cli", "static"]
    setup_commands: list[str] = []
    start_command: str
    preview_url_pattern: str | None = None
    notes: str | None = None


# ── Task CRUD / lifecycle ────────────────────────────────────────


class TaskCreate(BaseModel):
    title: str
    goal: str
    expert_hint_id: str | None = None
    template_id: str | None = None
    max_turns: int = 60
    max_phases: int = 6
    skip_clarification: bool = False


class TaskRunStart(BaseModel):
    phase: Literal["clarify", "execute"]


class TaskFollowUp(BaseModel):
    instruction: str
    model: str | None = None


class TaskRunStartResponse(BaseModel):
    task_id: str
    run_id: str
    conversation_id: str
    workspace_path: str | None = None


class TaskFollowUpResponse(BaseModel):
    task_id: str
    run_id: str
    conversation_id: str
    workspace_path: str | None = None
    follow_up_context: str


class TaskPlanUpsert(BaseModel):
    kind: Literal["markdown", "code_app", "mixed"] | None = None
    phases: list[PlanPhase]


class TaskPhaseUpdate(BaseModel):
    phase_id: str
    status: Literal["pending", "running", "completed", "failed", "skipped"]
    child_run_id: str | None = None
    summary: str | None = None


class TaskFinalize(BaseModel):
    status: Literal["completed", "failed", "cancelled"]
    deliverable_markdown: str | None = None
    deliverable_title: str | None = None
    deliverable_kind: Literal["markdown", "code_app", "mixed"] | None = None
    run_info: RunInfo | None = None
    error: str | None = None
    created_expert_ids: list[str] | None = None


class TaskEventCreate(BaseModel):
    seq: int
    kind: str
    payload_json: str
    ts: datetime | None = None


class TaskEventBatch(BaseModel):
    events: list[TaskEventCreate]


class TaskEventResponse(BaseModel):
    id: str
    task_id: str
    seq: int
    kind: str
    payload_json: str
    ts: datetime

    model_config = {"from_attributes": True}


# ── Responses ────────────────────────────────────────────────────


class TaskResponse(BaseModel):
    id: str
    title: str
    goal: str
    status: str
    expert_hint_id: str | None = None
    template_id: str | None = None
    run_id: str | None = None
    conversation_id: str | None = None
    plan: TaskPlan | None = None
    deliverable_markdown: str | None = None
    deliverable_title: str | None = None
    deliverable_kind: str = "markdown"
    workspace_path: str | None = None
    run_info: RunInfo | None = None
    clarifications: dict | None = None
    skip_clarification: bool = False
    max_turns: int = 60
    max_phases: int = 6
    created_expert_ids: list[str] = []
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None


class TaskDetailResponse(TaskResponse):
    run: RunRecordResponse | None = None
    child_runs: list[RunRecordResponse] = []
    dev_server: dict | None = None


class TaskListResponse(BaseModel):
    tasks: list[TaskResponse]
    total: int


# ── Workspace browsing ───────────────────────────────────────────


class WorkspaceFileEntry(BaseModel):
    path: str
    size: int
    is_dir: bool


class WorkspaceTreeResponse(BaseModel):
    files: list[WorkspaceFileEntry]
    truncated: bool = False


class WorkspaceFileResponse(BaseModel):
    path: str
    content: str
    language: str | None = None
    size: int


# ── Dev server ───────────────────────────────────────────────────


class DevServerStatus(BaseModel):
    running: bool
    pid: int | None = None
    url: str | None = None
    started_at: datetime | None = None
    stdout_tail: str | None = None
    preview_type: str | None = None


class DevServerStartResponse(BaseModel):
    task_id: str
    pid: int
    stream_url: str
