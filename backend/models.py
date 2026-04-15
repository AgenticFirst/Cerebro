import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def _uuid_hex() -> str:
    return uuid.uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    title: Mapped[str] = mapped_column(String(255), default="New Chat")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    conversation_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    expert_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True)
    agent_run_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True)
    metadata_json: Mapped[str | None] = mapped_column("metadata", Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    conversation: Mapped["Conversation"] = relationship(back_populates="messages")

    @property
    def metadata_parsed(self) -> dict | None:
        if not self.metadata_json:
            return None
        try:
            return json.loads(self.metadata_json)
        except (json.JSONDecodeError, TypeError):
            return None


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class Expert(Base):
    __tablename__ = "experts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    slug: Mapped[str | None] = mapped_column(String(100), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(255))
    domain: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str] = mapped_column(Text)
    system_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    type: Mapped[str] = mapped_column(String(20), default="expert")       # expert | team
    source: Mapped[str] = mapped_column(String(20), default="user")       # builtin | user | marketplace
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    tool_access: Mapped[str | None] = mapped_column(Text, nullable=True)           # JSON list
    policies: Mapped[str | None] = mapped_column(Text, nullable=True)              # JSON object
    required_connections: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    recommended_routines: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    team_members: Mapped[str | None] = mapped_column(Text, nullable=True)          # JSON [{expert_id, role, order}]
    strategy: Mapped[str | None] = mapped_column(String(20), nullable=True)
    coordinator_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    max_turns: Mapped[int] = mapped_column(Integer, default=10)
    token_budget: Mapped[int] = mapped_column(Integer, default=25000)
    version: Mapped[str | None] = mapped_column(String(20), nullable=True, default="1.0.0")
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class Skill(Base):
    __tablename__ = "skills"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(50), default="general")
    icon: Mapped[str | None] = mapped_column(String(50), nullable=True)
    instructions: Mapped[str] = mapped_column(Text)
    tool_requirements: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    source: Mapped[str] = mapped_column(String(20), default="builtin")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    author: Mapped[str | None] = mapped_column(String(255), nullable=True)
    version: Mapped[str] = mapped_column(String(20), default="1.0.0")
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class ExpertSkill(Base):
    __tablename__ = "expert_skills"
    __table_args__ = (
        Index("uq_expert_skill", "expert_id", "skill_id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    expert_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="CASCADE"), index=True
    )
    skill_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("skills.id", ondelete="CASCADE"), index=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    assigned_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    expert_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    parent_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(20), default="running")  # running | completed | cancelled | error
    turns: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    tools_used: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list of tool names
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Routine(Base):
    __tablename__ = "routines"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    plain_english_steps: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of strings: ["Pull calendar events", "Check todo backlog", "Draft plan"]
    dag_json: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON DAGDefinition — the compiled action graph
    trigger_type: Mapped[str] = mapped_column(String(20), default="manual")
        # "manual" | "cron" | "webhook"
    cron_expression: Mapped[str | None] = mapped_column(String(100), nullable=True)
    default_runner_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    approval_gates: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of step IDs/names that require approval
    required_connections: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of connection service names, e.g. ["google_calendar", "gmail"]
    notify_channels: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of {channel, recipient} objects to notify on run completion/failure,
        # e.g. [{"channel": "telegram", "recipient": "123456789"}]
    source: Mapped[str] = mapped_column(String(20), default="user")
        # "user" | "chat" | "marketplace"
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
        # "completed" | "failed" | "cancelled" — denormalized for list display
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class RunRecord(Base):
    __tablename__ = "run_records"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    routine_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("routines.id", ondelete="SET NULL"), nullable=True, index=True
    )
    expert_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), index=True, default="created")  # created | running | completed | failed | cancelled
    run_type: Mapped[str] = mapped_column(String(20), default="routine")
    trigger: Mapped[str] = mapped_column(String(20), default="manual")
    dag_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    total_steps: Mapped[int] = mapped_column(Integer, default=0)
    completed_steps: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    failed_step_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    parent_run_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)


class StepRecord(Base):
    __tablename__ = "step_records"
    __table_args__ = (
        Index("ix_step_records_run_id_order_index", "run_id", "order_index"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run_records.id", ondelete="CASCADE"), index=True)
    step_id: Mapped[str] = mapped_column(String(32))
    step_name: Mapped[str] = mapped_column(String(255))
    action_type: Mapped[str] = mapped_column(String(50))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    input_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    output_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    approval_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("approval_requests.id", ondelete="SET NULL"), nullable=True
    )
    approval_status: Mapped[str | None] = mapped_column(String(20), nullable=True)


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="CASCADE"), index=True
    )
    step_id: Mapped[str] = mapped_column(String(32))
    step_name: Mapped[str] = mapped_column(String(255))
    summary: Mapped[str] = mapped_column(Text)
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ExecutionEventRecord(Base):
    __tablename__ = "execution_events"
    __table_args__ = (
        Index("ix_execution_events_run_id_seq", "run_id", "seq"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    run_id: Mapped[str] = mapped_column(String(32), ForeignKey("run_records.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(50), index=True)
    step_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text)
    timestamp: Mapped[datetime] = mapped_column(DateTime, index=True)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    title: Mapped[str] = mapped_column(String(255))
    goal: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="pending", index=True)
    # pending | clarifying | awaiting_clarification | planning
    # | awaiting_plan_approval | running | completed | failed | cancelled

    expert_hint_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
    template_id: Mapped[str | None] = mapped_column(String(50), nullable=True)

    run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    # Tracking ID passed to agent.run() — NOT a FK to conversations.
    # Tasks are fully independent from the chat conversations system.
    conversation_id: Mapped[str | None] = mapped_column(
        String(32), nullable=True
    )

    plan_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    deliverable_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    deliverable_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    deliverable_kind: Mapped[str] = mapped_column(String(20), default="markdown")
    # "markdown" | "code_app" | "mixed"

    workspace_path: Mapped[str | None] = mapped_column(Text, nullable=True)

    run_info_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    clarifications_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    skip_clarification: Mapped[bool] = mapped_column(Boolean, default=False)

    max_turns: Mapped[int] = mapped_column(Integer, default=60)
    max_phases: Mapped[int] = mapped_column(Integer, default=6)

    created_expert_ids_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TaskEvent(Base):
    __tablename__ = "task_events"
    __table_args__ = (
        UniqueConstraint("task_id", "seq", name="uq_task_event_seq"),
        Index("ix_task_events_task_id_seq", "task_id", "seq"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    task_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(30))
    # text_delta | tool_start | tool_end | phase_start | phase_end | error | system
    payload_json: Mapped[str] = mapped_column(Text)
    ts: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
