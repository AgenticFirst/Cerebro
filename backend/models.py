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
    expert_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("experts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)
    # Origin channel of the conversation. 'cerebro' = standard in-app chat,
    # 'telegram' = inbound from the Telegram bridge (external_chat_id is set).
    # Future: 'slack', 'sms', etc.
    source: Mapped[str] = mapped_column(String(20), default="cerebro")
    external_chat_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

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


class IMDAudit(Base):
    __tablename__ = "imd_audits"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    business_name: Mapped[str] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    website: Mapped[str | None] = mapped_column(String(500), nullable=True)
    instagram: Mapped[str | None] = mapped_column(String(100), nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    industry: Mapped[str] = mapped_column(String(50), default="aesthetic-medicine")
    language: Mapped[str] = mapped_column(String(5), default="en")
    ghl_contact_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ghl_opportunity_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # IMD scores /20 each
    d1: Mapped[float | None] = mapped_column(nullable=True)
    d2: Mapped[float | None] = mapped_column(nullable=True)
    d3: Mapped[float | None] = mapped_column(nullable=True)
    d4: Mapped[float | None] = mapped_column(nullable=True)
    d5: Mapped[float | None] = mapped_column(nullable=True)
    d6: Mapped[float | None] = mapped_column(nullable=True)
    total: Mapped[float | None] = mapped_column(nullable=True)
    classification: Mapped[str | None] = mapped_column(String(20), nullable=True)  # Básico | Intermedio | Avanzado | Líder
    d1_breakdown: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    d2_breakdown: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
    pain_points: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON list
    # D5 tracking
    d5_dm_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    d5_responded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    d5_hours_to_respond: Mapped[float | None] = mapped_column(nullable=True)
    # D6 tracking
    d6_called_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    d6_call_outcome: Mapped[str | None] = mapped_column(String(20), nullable=True)  # voicemail | answered | booked | no_answer
    # Pipeline
    pipeline_stage: Mapped[str] = mapped_column(String(30), default="raw")  # raw | validated | scored | ig_dm_sent | called | responded | visit_scheduled | proposal | won | lost
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
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
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
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
    title: Mapped[str] = mapped_column(String(200))
    description_md: Mapped[str] = mapped_column(Text, default="")
    column: Mapped[str] = mapped_column(String(20), default="backlog", index=True)
    # backlog | in_progress | to_review | completed | error

    expert_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
    parent_task_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True, index=True
    )
    priority: Mapped[str] = mapped_column(String(10), default="normal")
    # low | normal | high | urgent

    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    position: Mapped[float] = mapped_column(default=0.0)

    run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Absolute path to a folder the agent should treat as its working directory.
    # When set, runs spawn with cwd = project_path instead of the hidden per-task
    # workspace. Stored as the realpath-resolved canonical form.
    project_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    # Human-readable folder name used under <userData>/task-workspaces/.
    # Frozen at task creation as slugify(title) + "-" + id[:8]; never updated
    # when the title changes, so on-disk paths stay stable.
    workspace_dir: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)

    # Free-form tags for categorization. JSON-serialized list of strings.
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Final deliverable captured at run_completed. The expert's <deliverable>
    # body is parsed in the Electron runtime and POSTed here so the task row
    # carries the result independent of the PTY terminal buffer (which is
    # ephemeral and ANSI-laden). Used by the Vista previa tab.
    result_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    result_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # markdown | code_app | mixed

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TaskChecklistItem(Base):
    __tablename__ = "task_checklist_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    task_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    body: Mapped[str] = mapped_column(String(500))
    is_done: Mapped[bool] = mapped_column(Boolean, default=False)
    position: Mapped[float] = mapped_column(default=0.0)
    promoted_task_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class Bucket(Base):
    __tablename__ = "buckets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    icon: Mapped[str | None] = mapped_column(String(32), nullable=True)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[float] = mapped_column(default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class FileItem(Base):
    __tablename__ = "file_items"
    __table_args__ = (
        Index("ix_file_items_bucket_deleted", "bucket_id", "deleted_at"),
        Index("ix_file_items_sha256", "sha256"),
        Index("ix_file_items_starred", "starred"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    bucket_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("buckets.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(512))
    ext: Mapped[str] = mapped_column(String(32), default="")
    mime: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    storage_kind: Mapped[str] = mapped_column(String(16), default="managed")
    # managed: relative under <userData>/files; workspace: absolute path
    storage_path: Mapped[str] = mapped_column(String(1024))
    source: Mapped[str] = mapped_column(String(32), default="manual")
    # upload | chat-save | workspace-save | manual
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    source_message_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    source_task_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True
    )
    starred: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TaskComment(Base):
    __tablename__ = "task_comments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    task_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(20), default="comment")
    # comment | instruction | system
    author_kind: Mapped[str] = mapped_column(String(10), default="user")
    # user | expert | system
    expert_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
    body_md: Mapped[str] = mapped_column(Text)
    triggered_run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="SET NULL"), nullable=True
    )
    # Queue state for follow-up instructions sent while another run is active.
    # NULL = not queued; pending = waiting for current run to finish; delivered =
    # drained into a run; discarded = user dismissed after the previous run failed.
    queue_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    pending_expert_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class ParsedFile(Base):
    """Sidecar cache for binary files (.docx/.xlsx/.pptx/.pdf/audio) that have
    been extracted to plain markdown/text. Keyed by sha256 + parser_version so
    upgrades to a parser library invalidate stale parses automatically."""

    __tablename__ = "parsed_files"

    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    parsed_path: Mapped[str] = mapped_column(String(1024))
    # Relative path under <userData>/files/_parsed (just "<sha>.md" today).
    char_count: Mapped[int] = mapped_column(Integer, default=0)
    parser: Mapped[str] = mapped_column(String(32))
    # 'python-docx' | 'openpyxl' | 'python-pptx' | 'pypdf' | 'stt'
    parser_version: Mapped[str] = mapped_column(String(32), default="")
    warning: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class ExpertContextFile(Base):
    """Permanent reference document attached to an expert. Pre-parsed via
    ParsedFile and injected into the expert's system prompt every chat."""

    __tablename__ = "expert_context_files"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    expert_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="CASCADE"), index=True
    )
    file_item_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("file_items.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(20), default="reference")
    # 'reference' | 'template'
    sort_order: Mapped[float] = mapped_column(default=0.0)
    char_count: Mapped[int] = mapped_column(Integer, default=0)
    truncated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class KnowledgePage(Base):
    """A single page in the Knowledge Base (Notion-style notes app).

    We use the Notion model: there is no separate "folder" entity — every node
    is a page, and pages nest via ``parent_id``. A "folder" is simply a page
    that happens to have children. The page body is stored as one BlockNote
    document JSON blob (``content_json``, whole-document debounced autosave)
    plus a lossy markdown mirror (``content_markdown``) that the chat agent
    reads/writes without ever touching BlockNote's internal JSON.
    """

    __tablename__ = "knowledge_pages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    parent_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("knowledge_pages.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    title: Mapped[str] = mapped_column(String(255), default="Untitled")
    icon: Mapped[str | None] = mapped_column(String(32), nullable=True)        # emoji
    cover_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    content_json: Mapped[str | None] = mapped_column(Text, nullable=True)      # BlockNote doc JSON
    content_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)  # mirror for the agent
    sort_order: Mapped[float] = mapped_column(default=0.0)                     # cheap reordering
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)          # trash
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class KnowledgeAiThread(Base):
    """A per-page 'Ask AI' conversation. Threads are scoped to a Knowledge Base
    page; deleting the page cascades its threads (and their messages) away."""

    __tablename__ = "knowledge_ai_threads"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    page_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("knowledge_pages.id", ondelete="CASCADE"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(255), default="New chat")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class KnowledgeAiMessage(Base):
    """One message in a KnowledgeAiThread (role: 'user' | 'assistant')."""

    __tablename__ = "knowledge_ai_messages"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    thread_id: Mapped[str] = mapped_column(
        String(32),
        ForeignKey("knowledge_ai_threads.id", ondelete="CASCADE"),
        index=True,
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class WhatsAppClient(Base):
    """An operator-managed WhatsApp client (business).

    Each client has its own WhatsApp session directory, business profile, and
    conversation history. Operators can manage multiple clients from one
    Cerebro install — each client maps to a separate WhatsApp number.
    """

    __tablename__ = "whatsapp_clients"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    name: Mapped[str] = mapped_column(String(255))
    business_name: Mapped[str] = mapped_column(String(255), default="")
    business_description: Mapped[str] = mapped_column(Text, default="")
    business_hours: Mapped[str] = mapped_column(String(255), default="")
    # Free-text knowledge base: FAQs, pricing, services, policies, etc.
    # Injected directly into the AI context on every customer message.
    knowledge_base: Mapped[str] = mapped_column(Text, default="")
    # Calendly / booking URL — bot sends this when customer asks to schedule.
    booking_url: Mapped[str] = mapped_column(String(512), default="")
    # Optional: link to a specific Cerebro Expert for this business.
    expert_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("experts.id", ondelete="SET NULL"),
        nullable=True,
    )
    powered_by_footer: Mapped[bool] = mapped_column(Boolean, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class SyncOutbox(Base):
    """Local-only change log feeding the Supabase sync worker.

    One row per local insert/update/delete on a synced table, written in the
    same transaction as the change (see cloud_sync/outbox.py). The worker drains
    pending rows to Supabase and marks them done; rows accumulate while offline
    and flush on reconnect. Never itself synced.
    """

    __tablename__ = "sync_outbox"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    table_name: Mapped[str] = mapped_column(String(64), index=True)
    row_pk: Mapped[str] = mapped_column(String(128))
    op: Mapped[str] = mapped_column(String(10))  # "insert" | "update" | "delete"
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="pending", index=True)  # pending | done
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    __table_args__ = (Index("ix_sync_outbox_status_created", "status", "created_at"),)


class NewsArticle(Base):
    """A cached news story parsed from a public RSS/Atom feed.

    The primary key is sha1(url) so re-fetching the same story (across feeds or
    refreshes) is idempotent via ``db.merge`` rather than producing duplicates.
    Rows are time-sensitive cache entries — the News router replaces a category's
    rows wholesale on each successful refresh.
    """

    __tablename__ = "news_articles"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)  # sha1(url) hex
    feed_id: Mapped[str] = mapped_column(String(50), index=True)
    source_name: Mapped[str] = mapped_column(String(120))
    title: Mapped[str] = mapped_column(Text)
    url: Mapped[str] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class NewsFetchMeta(Base):
    """One row per category tracking when its feed cache was last refreshed.

    Drives the stale-while-revalidate TTL in the News router so each tab has its
    own freshness clock (id = the category, e.g. 'top', 'world', 'tech')."""

    __tablename__ = "news_fetch_meta"

    id: Mapped[str] = mapped_column(String(20), primary_key=True)  # category
    last_fetched_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class CalendarAccount(Base):
    """A connected calendar account (Google or Outlook).

    Holds only non-secret identity + status metadata so it can replicate to
    Supabase. The OAuth client id/secret and access/refresh tokens live ONLY in
    device-local ``calendar_*`` settings (encrypted via Electron safeStorage) and
    never reach this table or the cloud — see cloud_sync/config.py.
    """

    __tablename__ = "calendar_accounts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    provider: Mapped[str] = mapped_column(String(20))  # 'google' | 'outlook'
    email: Mapped[str] = mapped_column(String(320))
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    primary_calendar_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # JSON: [{id, name, color, selected}] — the calendars within this account.
    calendars_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    # connected | token_expired | error | disconnected
    status: Mapped[str] = mapped_column(String(20), default="connected")
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)


class CalendarEvent(Base):
    """A normalized calendar event from any provider.

    Provider-agnostic: the Electron-side provider adapters map Google
    ``events.list`` and Microsoft Graph ``/events/delta`` payloads into this one
    shape. Times are stored as UTC plus the original IANA zone so DST math and
    round-tripping on edit stay correct. Deletes are soft (status='cancelled') so
    the tombstone replicates to other devices.
    """

    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    account_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("calendar_accounts.id", ondelete="CASCADE"), index=True
    )
    calendar_id: Mapped[str] = mapped_column(String(255))
    # Provider's id for the event — null until a Cerebro-origin event is first pushed.
    provider_event_id: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    etag: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Cross-provider identity for the same meeting (phase-2 dedup / booking links).
    ical_uid: Mapped[str | None] = mapped_column(String(512), nullable=True)
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    end_utc: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    start_tz: Mapped[str | None] = mapped_column(String(64), nullable=True)  # IANA
    end_tz: Mapped[str | None] = mapped_column(String(64), nullable=True)
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    recurrence_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # RRULE[] for master
    recurring_master_id: Mapped[str | None] = mapped_column(String(512), nullable=True)
    attendees_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # [{email,name,response}]
    organizer_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    # accepted | declined | tentative | needsAction
    rsvp_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    visibility: Mapped[str] = mapped_column(String(16), default="default")  # default|public|private
    transparency: Mapped[str] = mapped_column(String(16), default="opaque")  # opaque(busy)|transparent(free)
    status: Mapped[str] = mapped_column(String(16), default="confirmed")  # confirmed|cancelled (soft-delete)
    conference_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # Meet/Teams link
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)  # user-chosen hex (local events)
    origin: Mapped[str] = mapped_column(String(12), default="provider")  # provider|cerebro
    # synced | pending_push | pending_delete | error
    sync_status: Mapped[str] = mapped_column(String(16), default="synced")
    provider_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    conflict_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # losing side of a surfaced conflict
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)

    __table_args__ = (
        UniqueConstraint(
            "account_id", "calendar_id", "provider_event_id", name="uq_calendar_event_provider_id"
        ),
        Index("ix_calendar_events_window", "account_id", "start_utc"),
    )


class CalendarSyncState(Base):
    """Per-(account, calendar) incremental sync bookkeeping.

    LOCAL-ONLY — must never replicate (each device syncs independently, holding
    its own provider sync cursor). Registered in cloud_sync LOCAL_ONLY_TABLES.
    """

    __tablename__ = "calendar_sync_state"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    account_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("calendar_accounts.id", ondelete="CASCADE"), index=True
    )
    calendar_id: Mapped[str] = mapped_column(String(255))
    # Google syncToken / Outlook @odata.deltaLink.
    sync_cursor: Mapped[str | None] = mapped_column(Text, nullable=True)
    cursor_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    full_sync_window_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("account_id", "calendar_id", name="uq_calendar_sync_state"),
    )
