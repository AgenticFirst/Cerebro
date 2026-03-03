# Routines

## Problem Statement

The Execution Engine (roadmap #5) gave Cerebro a local runtime for DAG-based workflows — actions compose into graphs that execute with event streaming, approval gates, and run records. But the engine is infrastructure. It executes a DAG definition that somebody gives it. The missing piece is the *definition layer*: where do DAGs come from, how do users create and manage them, how do they run on schedule, and how does the AI itself propose them?

Today, a user who wants to automate "every weekday at 9am, pull my calendar, check my todo backlog, and draft a plan for the day" has no path to expressing that as a saved, executable artifact. They can describe it in chat and get advice. They can manually construct a DAG in JSON and submit it via IPC. Neither is a product.

Routines bridge intent to outcome:

1. **Chat-first creation.** The user says "I want a morning routine that prepares my day." Cerebro proposes a Routine (name, plain-english steps, trigger, runner, approval gates) as an inline card. The user previews it (real execution with live logs), edits if needed, and saves.

2. **Reusable and manageable.** Saved routines appear in the Routines screen with on/off toggles, trigger configuration, run history, and an Edit panel. No routine lives only in a chat conversation.

3. **Scheduled and triggered.** Routines can run manually ("Run Now"), on a cron schedule, or (in the future) via webhook. The cron scheduler runs in the Electron main process and calls `ExecutionEngine.startRun()` directly.

4. **Visually inspectable.** A React Flow-based DAG editor lets users see and modify the action graph — drag nodes, wire connections, configure step parameters — matching the visual workflow-builder paradigm users expect from modern automation platforms.

5. **Observable.** Every routine run produces a RunRecord with live inline logs in chat, step-level detail in Activity, and full event replay.

**Scope:** This design covers the Routine data model, backend API, frontend screens (list + detail + DAG editor), chat integration (proposal cards + run log cards), agent tools (`run_routine`, `propose_routine`), proposal logic, preview execution, and cron scheduling. It builds entirely on the completed Execution Engine.

## Design Principles

1. **Reuse the engine, don't reinvent it.** Routines are *definitions* that compile to DAGs. Execution goes through `ExecutionEngine.startRun()` unchanged. Preview uses the same path with a different `run_type`. There is no "routine executor" separate from the engine.

2. **Chat is the entrypoint.** Users should be able to create routines by talking to Cerebro. The proposal → preview → save flow happens inline in chat, not in a separate wizard. The Routines screen is for management and editing, not first-time creation.

3. **Progressive disclosure.** Routines start as a list of plain-English steps. The DAG graph is a "Show Details" view for power users. Most users never need to see the underlying action graph — but it's always there and always editable.

4. **Follow established patterns.** `RoutineContext` follows `ExpertContext`. Backend CRUD follows `backend/experts/`. Agent tools follow `search-tools.ts`. The tech design follows `execution-engine.md`. No novel patterns unless a problem during implementation demands one.

5. **Frontend state matches backend state.** Routines are persisted in SQLite via the backend API. The `RoutineContext` mirrors backend state and refreshes after mutations. No client-only routine state.

6. **Incremental delivery.** The six implementation phases are ordered so each delivers testable, demoable functionality. Phase 1 (data model + API + list view) is useful without Phase 6 (DAG editor).

## Architecture Overview

### Where Routines Live

Routines span three layers:

- **Backend (Python/FastAPI):** Persistent storage. The `routines` table stores routine definitions. CRUD at `/routines`. The `run_records` table (already exists) stores execution history via `routine_id` FK.
- **Main Process (Electron/TypeScript):** Runtime. The `ExecutionEngine` executes routine DAGs. The `RoutineScheduler` manages cron jobs. Agent tools (`run_routine`, `propose_routine`) bridge chat to routines.
- **Renderer (React):** UI. The `RoutineContext` provides CRUD state. The `RoutinesScreen` shows the list and edit panel. The `DAGEditor` renders the visual graph. `RunLogCard` and `RoutineProposalCard` render inline in chat.

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Renderer Process                             │
│                                                                     │
│  RoutineContext ──────── RoutinesScreen                              │
│  (CRUD state)            ├── RoutineCard (list items)               │
│       │                  ├── RoutineDetailPanel (slide-in editor)   │
│       │                  ├── CreateRoutineDialog (modal)            │
│       │                  └── DAGEditor (React Flow canvas)          │
│       │                                                             │
│  ChatContext ───────────── ChatView                                  │
│  (chat state)              ├── RoutineProposalCard (inline)         │
│       │                    └── RunLogCard (inline, live events)     │
│       │                                                             │
│  window.cerebro.engine.onEvent(runId, cb)   ← live event stream    │
│  window.cerebro.invoke(...)                 ← REST via IPC         │
│  window.cerebro.scheduler.sync()            ← trigger resync       │
└────────────────────┬───────────────────────────────────────────────┘
                     │ IPC
┌────────────────────┴───────────────────────────────────────────────┐
│                    Main Process (Electron)                          │
│                                                                     │
│  ┌─────────────────────────┐    ┌──────────────────────┐           │
│  │     ExecutionEngine     │    │  RoutineScheduler    │           │
│  │  (unchanged from #5)   │    │  (node-cron jobs)    │           │
│  │                         │    │                      │           │
│  │  startRun(dag) ◄────────┼────┤  fires at cron time │           │
│  │  cancelRun(runId)       │    │  syncs on startup    │           │
│  └─────────────────────────┘    └──────────────────────┘           │
│                                                                     │
│  Agent Tools (in AgentRuntime context)                              │
│  ├── run_routine    → fetches routine → engine.startRun()          │
│  └── propose_routine → returns structured proposal to chat         │
│                                                                     │
│  IPC Handlers                                                       │
│  ├── scheduler:sync → RoutineScheduler.sync()                      │
│  └── engine:*       → (existing from #5)                           │
└────────────────────┬───────────────────────────────────────────────┘
                     │ HTTP (REST)
┌────────────────────┴───────────────────────────────────────────────┐
│                  Python Backend (FastAPI)                           │
│                                                                     │
│  /routines         CRUD                                            │
│  /routines/{id}/run  → returns routine data (engine runs locally)  │
│  /engine/runs      (existing from #5)                              │
│                                                                     │
│  ┌─ SQLite ──────────────────────────────────────────────┐         │
│  │  routines (NEW)                                       │         │
│  │  run_records.routine_id FK (already nullable)         │         │
│  │  step_records, execution_events (existing from #5)    │         │
│  └───────────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
```

### Relationship to Existing Systems

| System | Relationship |
|--------|-------------|
| **ExecutionEngine** | Routines compile to DAGs and call `engine.startRun()`. The engine is unmodified. |
| **AgentRuntime** | Agent tools (`run_routine`, `propose_routine`) run inside agent loops. The runtime is unmodified. |
| **ChatContext** | Extended with `engineRunId` and `routineProposal` fields on `Message`. New inline components render when these fields are present. |
| **ExpertContext** | `RoutineContext` follows the same pattern. Routines can reference experts via `default_runner_id`. |
| **RunRecord** | `RunRecord.routine_id` already exists (nullable). Routine runs populate this FK. No schema migration needed. |
| **Memory system** | Routine-scoped memory is a future enhancement. V0 routines use the global and expert-scoped memory already available. |

### Data Flow: Chat → Routine → Execution

```
User: "I want a morning routine that prepares my day"
       │
       ▼
AgentRuntime (Cerebro or expert)
       │
       ├──► Detects repeatable intent
       ├──► Calls propose_routine tool with structured proposal
       │
       ▼
ChatContext receives tool result
       │
       ├──► Creates message with routineProposal field
       ├──► Renders RoutineProposalCard inline
       │
       ▼
User clicks "Preview"
       │
       ├──► Compiles plain-english steps → DAG
       ├──► Calls engine.startRun() with triggerSource: 'preview'
       ├──► Creates message with engineRunId field
       ├──► RunLogCard renders inline with live event stream
       │
       ▼
User clicks "Save Routine"
       │
       ├──► POST /routines (creates backend record)
       ├──► RoutineContext refreshes
       ├──► Routine appears in Routines screen
       ├──► Proposal status updated to 'saved'
       │
       ▼
User configures cron trigger in Routines screen
       │
       ├──► PATCH /routines/{id} with trigger_type: 'cron', cron_expression
       ├──► window.cerebro.scheduler.sync()
       ├──► RoutineScheduler creates node-cron job
       │
       ▼
Cron fires
       │
       ├──► RoutineScheduler fetches routine from backend
       ├──► Compiles DAG from routine definition
       ├──► engine.startRun() with triggerSource: 'schedule'
       ├──► RunRecord persisted with routine_id
       └──► Events stream to renderer (if window is open)
```

## Data Model

### Routine Table

A new `Routine` SQLAlchemy model in `backend/models.py`:

```python
# backend/models.py (addition)

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
        # e.g. "0 9 * * 1-5" (weekdays at 9am). Only used when trigger_type is "cron"
    default_runner_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
        # FK to the expert/team that runs this routine by default
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    approval_gates: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of step IDs that require approval, e.g. ["send_email", "update_calendar"]
    required_connections: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of connection service names needed, e.g. ["google_calendar", "gmail"]
    source: Mapped[str] = mapped_column(String(20), default="user")
        # "user" | "chat" | "marketplace"
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
        # The conversation where this routine was proposed (if created from chat)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
        # "completed" | "failed" | "cancelled" — denormalized for list display
    run_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, onupdate=_utcnow)
```

### RunRecord.routine_id

The `routine_id` column already exists on `RunRecord` as a nullable `String(32)` with an index (added in the Execution Engine design). When Routines ship, this column links routine executions to their definitions. **No migration needed** — the column is already present and nullable.

When the Routine model is added, we add a proper foreign key relationship:

```python
# In RunRecord (update existing):
routine_id: Mapped[str | None] = mapped_column(
    String(32), ForeignKey("routines.id", ondelete="SET NULL"), nullable=True, index=True
)
```

Since we use SQLite with `create_all()` (no Alembic migrations in V0), and the column already exists, we handle this by updating the model definition. SQLAlchemy's `create_all()` will create the `routines` table and the FK constraint is applied at the ORM level.

### Schema Relationships

```
┌──────────┐         ┌──────────────┐        ┌──────────────┐
│ routines │ 1 ── N  │  run_records │ 1 ── N │ step_records │
│          │         │              │        │              │
│ id       │◄────────│ routine_id   │        │ run_id       │
│ name     │         │ status       │        │ step_id      │
│ dag_json │         │ dag_json     │        │ status       │
│ trigger  │         │ trigger      │        │ output_json  │
│ runner   │──┐      │ started_at   │        └──────────────┘
└──────────┘  │      └──────────────┘
              │                                ┌────────────────────┐
              │      ┌──────────┐              │ execution_events   │
              └─────►│ experts  │              │                    │
                     │          │              │ run_id             │
                     │ id       │              │ event_type         │
                     │ name     │              │ payload_json       │
                     └──────────┘              └────────────────────┘
```

## Backend API

### Module Structure

```
backend/routines/
    __init__.py
    schemas.py          # Pydantic request/response models
    router.py           # FastAPI router mounted at /routines
```

### Pydantic Schemas

```python
# backend/routines/schemas.py

from pydantic import BaseModel


class RoutineCreate(BaseModel):
    name: str
    description: str = ""
    plain_english_steps: list[str] | None = None
    dag_json: str | None = None
    trigger_type: str = "manual"
    cron_expression: str | None = None
    default_runner_id: str | None = None
    approval_gates: list[str] | None = None
    required_connections: list[str] | None = None
    source: str = "user"
    source_conversation_id: str | None = None


class RoutineUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    plain_english_steps: list[str] | None = None
    dag_json: str | None = None
    trigger_type: str | None = None
    cron_expression: str | None = None
    default_runner_id: str | None = None
    is_enabled: bool | None = None
    approval_gates: list[str] | None = None
    required_connections: list[str] | None = None


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
    source: str
    source_conversation_id: str | None
    last_run_at: str | None
    last_run_status: str | None
    run_count: int
    created_at: str
    updated_at: str
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/routines` | Create a routine |
| `GET` | `/routines` | List routines (optional filter: `is_enabled`, `trigger_type`) |
| `GET` | `/routines/{id}` | Get a routine by ID |
| `PATCH` | `/routines/{id}` | Update routine fields |
| `DELETE` | `/routines/{id}` | Delete a routine |
| `POST` | `/routines/{id}/run` | Return routine data for execution (engine runs locally) |

### Router Implementation

```python
# backend/routines/router.py

import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from database import get_session
from models import Routine

from .schemas import RoutineCreate, RoutineResponse, RoutineUpdate

router = APIRouter(prefix="/routines", tags=["routines"])


def _to_response(r: Routine) -> RoutineResponse:
    return RoutineResponse(
        id=r.id,
        name=r.name,
        description=r.description,
        plain_english_steps=json.loads(r.plain_english_steps) if r.plain_english_steps else None,
        dag_json=r.dag_json,
        trigger_type=r.trigger_type,
        cron_expression=r.cron_expression,
        default_runner_id=r.default_runner_id,
        is_enabled=r.is_enabled,
        approval_gates=json.loads(r.approval_gates) if r.approval_gates else None,
        required_connections=json.loads(r.required_connections) if r.required_connections else None,
        source=r.source,
        source_conversation_id=r.source_conversation_id,
        last_run_at=r.last_run_at.isoformat() if r.last_run_at else None,
        last_run_status=r.last_run_status,
        run_count=r.run_count,
        created_at=r.created_at.isoformat(),
        updated_at=r.updated_at.isoformat(),
    )


@router.post("", response_model=RoutineResponse, status_code=201)
async def create_routine(body: RoutineCreate):
    with get_session() as session:
        routine = Routine(
            name=body.name,
            description=body.description,
            plain_english_steps=json.dumps(body.plain_english_steps) if body.plain_english_steps else None,
            dag_json=body.dag_json,
            trigger_type=body.trigger_type,
            cron_expression=body.cron_expression,
            default_runner_id=body.default_runner_id,
            approval_gates=json.dumps(body.approval_gates) if body.approval_gates else None,
            required_connections=json.dumps(body.required_connections) if body.required_connections else None,
            source=body.source,
            source_conversation_id=body.source_conversation_id,
        )
        session.add(routine)
        session.commit()
        session.refresh(routine)
        return _to_response(routine)


@router.get("", response_model=dict)
async def list_routines(
    is_enabled: bool | None = None,
    trigger_type: str | None = None,
    limit: int = 200,
    offset: int = 0,
):
    with get_session() as session:
        query = select(Routine)
        if is_enabled is not None:
            query = query.where(Routine.is_enabled == is_enabled)
        if trigger_type is not None:
            query = query.where(Routine.trigger_type == trigger_type)
        query = query.order_by(Routine.updated_at.desc()).limit(limit).offset(offset)
        routines = session.scalars(query).all()
        total = session.query(Routine).count()
        return {"routines": [_to_response(r) for r in routines], "total": total}


@router.get("/{routine_id}", response_model=RoutineResponse)
async def get_routine(routine_id: str):
    with get_session() as session:
        routine = session.get(Routine, routine_id)
        if not routine:
            raise HTTPException(status_code=404, detail="Routine not found")
        return _to_response(routine)


@router.patch("/{routine_id}", response_model=RoutineResponse)
async def update_routine(routine_id: str, body: RoutineUpdate):
    with get_session() as session:
        routine = session.get(Routine, routine_id)
        if not routine:
            raise HTTPException(status_code=404, detail="Routine not found")

        update_data = body.model_dump(exclude_unset=True)

        # Serialize JSON list fields
        if "plain_english_steps" in update_data:
            v = update_data["plain_english_steps"]
            update_data["plain_english_steps"] = json.dumps(v) if v is not None else None
        if "approval_gates" in update_data:
            v = update_data["approval_gates"]
            update_data["approval_gates"] = json.dumps(v) if v is not None else None
        if "required_connections" in update_data:
            v = update_data["required_connections"]
            update_data["required_connections"] = json.dumps(v) if v is not None else None

        for key, value in update_data.items():
            setattr(routine, key, value)

        session.commit()
        session.refresh(routine)
        return _to_response(routine)


@router.delete("/{routine_id}", status_code=204)
async def delete_routine(routine_id: str):
    with get_session() as session:
        routine = session.get(Routine, routine_id)
        if not routine:
            raise HTTPException(status_code=404, detail="Routine not found")
        session.delete(routine)
        session.commit()


@router.post("/{routine_id}/run", response_model=RoutineResponse)
async def get_routine_for_run(routine_id: str):
    """Return the routine data needed for execution. The actual execution
    happens in the Electron main process via ExecutionEngine."""
    with get_session() as session:
        routine = session.get(Routine, routine_id)
        if not routine:
            raise HTTPException(status_code=404, detail="Routine not found")
        if not routine.is_enabled:
            raise HTTPException(status_code=400, detail="Routine is disabled")

        # Update run metadata
        routine.last_run_at = datetime.now(timezone.utc)
        routine.run_count = (routine.run_count or 0) + 1
        session.commit()
        session.refresh(routine)

        return _to_response(routine)
```

### Registration in `backend/main.py`

```python
# In backend/main.py — add alongside existing router imports:
from routines.router import router as routines_router

# In the router mounting section:
app.include_router(routines_router)
```

The `Routine` model import must be added before `Base.metadata.create_all()` in the lifespan function, following the existing pattern for `Expert`, `AgentRun`, `RunRecord`, etc.

## Frontend: Routine Types

### Routine Interface

```typescript
// src/types/routines.ts

export type TriggerType = 'manual' | 'cron' | 'webhook';
export type RoutineSource = 'user' | 'chat' | 'marketplace';

export interface Routine {
  id: string;
  name: string;
  description: string;
  plainEnglishSteps: string[] | null;
  dagJson: string | null;
  triggerType: TriggerType;
  cronExpression: string | null;
  defaultRunnerId: string | null;
  isEnabled: boolean;
  approvalGates: string[] | null;
  requiredConnections: string[] | null;
  source: RoutineSource;
  sourceConversationId: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoutineInput {
  name: string;
  description?: string;
  plainEnglishSteps?: string[];
  dagJson?: string;
  triggerType?: TriggerType;
  cronExpression?: string;
  defaultRunnerId?: string;
  approvalGates?: string[];
  requiredConnections?: string[];
  source?: RoutineSource;
  sourceConversationId?: string;
}
```

### Extended Message Type

```typescript
// src/types/chat.ts (additions)

export interface RoutineProposal {
  name: string;
  steps: string[];
  triggerType: TriggerType;
  cronExpression?: string;
  defaultRunnerId?: string;
  requiredConnections: string[];
  approvalGates: string[];
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
  savedRoutineId?: string;  // Populated after save
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  model?: string;
  tokenCount?: number;
  expertId?: string;
  agentRunId?: string;
  createdAt: Date;
  isStreaming?: boolean;
  isThinking?: boolean;
  toolCalls?: ToolCall[];
  engineRunId?: string;           // NEW — links to a live/completed engine run
  routineProposal?: RoutineProposal;  // NEW — inline routine proposal card data
}
```

## Frontend: RoutineContext

Following the `ExpertContext` pattern — types, API mapping, CRUD, state.

```typescript
// src/context/RoutineContext.tsx

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';
import type { Routine, CreateRoutineInput, TriggerType, RoutineSource } from '../types/routines';

// ── API response types (snake_case) ────────────────────────────

interface ApiRoutine {
  id: string;
  name: string;
  description: string;
  plain_english_steps: string[] | null;
  dag_json: string | null;
  trigger_type: string;
  cron_expression: string | null;
  default_runner_id: string | null;
  is_enabled: boolean;
  approval_gates: string[] | null;
  required_connections: string[] | null;
  source: string;
  source_conversation_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

function toRoutine(api: ApiRoutine): Routine {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    plainEnglishSteps: api.plain_english_steps,
    dagJson: api.dag_json,
    triggerType: api.trigger_type as TriggerType,
    cronExpression: api.cron_expression,
    defaultRunnerId: api.default_runner_id,
    isEnabled: api.is_enabled,
    approvalGates: api.approval_gates,
    requiredConnections: api.required_connections,
    source: api.source as RoutineSource,
    sourceConversationId: api.source_conversation_id,
    lastRunAt: api.last_run_at,
    lastRunStatus: api.last_run_status,
    runCount: api.run_count,
    createdAt: api.created_at,
    updatedAt: api.updated_at,
  };
}

function toApiBody(input: CreateRoutineInput): Record<string, unknown> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.description) body.description = input.description;
  if (input.plainEnglishSteps) body.plain_english_steps = input.plainEnglishSteps;
  if (input.dagJson) body.dag_json = input.dagJson;
  if (input.triggerType) body.trigger_type = input.triggerType;
  if (input.cronExpression) body.cron_expression = input.cronExpression;
  if (input.defaultRunnerId) body.default_runner_id = input.defaultRunnerId;
  if (input.approvalGates) body.approval_gates = input.approvalGates;
  if (input.requiredConnections) body.required_connections = input.requiredConnections;
  if (input.source) body.source = input.source;
  if (input.sourceConversationId) body.source_conversation_id = input.sourceConversationId;
  return body;
}

// ── Context ────────────────────────────────────────────────────

interface RoutineContextValue {
  routines: Routine[];
  total: number;
  isLoading: boolean;
  enabledCount: number;
  scheduledCount: number;
  loadRoutines: () => Promise<void>;
  createRoutine: (input: CreateRoutineInput) => Promise<Routine | null>;
  updateRoutine: (id: string, fields: Partial<ApiRoutine>) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  toggleEnabled: (routine: Routine) => Promise<void>;
}

const RoutineCtx = createContext<RoutineContextValue | null>(null);

export function RoutineProvider({ children }: { children: ReactNode }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const enabledCount = useMemo(
    () => routines.filter((r) => r.isEnabled).length,
    [routines],
  );

  const scheduledCount = useMemo(
    () => routines.filter((r) => r.triggerType === 'cron' && r.isEnabled).length,
    [routines],
  );

  const loadRoutines = useCallback(async () => {
    setIsLoading(true);
    try {
      const res: BackendResponse<{ routines: ApiRoutine[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: '/routines?limit=200',
        });
      if (res.ok) {
        setRoutines(res.data.routines.map(toRoutine));
        setTotal(res.data.total);
      }
    } catch {
      // Backend not ready
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createRoutine = useCallback(
    async (input: CreateRoutineInput): Promise<Routine | null> => {
      try {
        const res: BackendResponse<ApiRoutine> = await window.cerebro.invoke({
          method: 'POST',
          path: '/routines',
          body: toApiBody(input),
        });
        if (res.ok) {
          const routine = toRoutine(res.data);
          setRoutines((prev) => [routine, ...prev]);
          setTotal((prev) => prev + 1);
          return routine;
        }
      } catch (e) {
        console.error('Failed to create routine:', e);
      }
      return null;
    },
    [],
  );

  const updateRoutine = useCallback(
    async (id: string, fields: Partial<ApiRoutine>) => {
      try {
        const res: BackendResponse<ApiRoutine> = await window.cerebro.invoke({
          method: 'PATCH',
          path: `/routines/${id}`,
          body: fields,
        });
        if (res.ok) {
          const updated = toRoutine(res.data);
          setRoutines((prev) => prev.map((r) => (r.id === id ? updated : r)));
        }
      } catch (e) {
        console.error('Failed to update routine:', e);
      }
    },
    [],
  );

  const deleteRoutine = useCallback(async (id: string) => {
    try {
      const res = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/routines/${id}`,
      });
      if (res.ok || res.status === 204) {
        setRoutines((prev) => prev.filter((r) => r.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (e) {
      console.error('Failed to delete routine:', e);
    }
  }, []);

  const toggleEnabled = useCallback(
    async (routine: Routine) => {
      await updateRoutine(routine.id, { is_enabled: !routine.isEnabled });
    },
    [updateRoutine],
  );

  return (
    <RoutineCtx.Provider
      value={{
        routines,
        total,
        isLoading,
        enabledCount,
        scheduledCount,
        loadRoutines,
        createRoutine,
        updateRoutine,
        deleteRoutine,
        toggleEnabled,
      }}
    >
      {children}
    </RoutineCtx.Provider>
  );
}

export function useRoutines(): RoutineContextValue {
  const ctx = useContext(RoutineCtx);
  if (!ctx) throw new Error('useRoutines must be used within RoutineProvider');
  return ctx;
}
```

### Provider Registration

`RoutineProvider` is added to the provider hierarchy in `src/App.tsx`, alongside the existing providers:

```tsx
// src/App.tsx (updated provider order)
<ProviderProvider>
  <ModelProvider>
    <MemoryProvider>
      <RoutineProvider>    {/* NEW */}
        <ChatProvider>
          <AppLayout />
        </ChatProvider>
      </RoutineProvider>
    </MemoryProvider>
  </ModelProvider>
</ProviderProvider>
```

`RoutineProvider` goes above `ChatProvider` because `ChatProvider` may need routine context for proposal card save actions.

## Frontend: Routines Screen

### Component Structure

```
src/components/screens/
    RoutinesScreen.tsx              # Main screen with list + detail panel
    routines/
        RoutineCard.tsx             # Individual routine in the list
        RoutineDetailPanel.tsx      # Slide-in edit panel
        CreateRoutineDialog.tsx     # Modal for manual creation
        DAGEditor.tsx               # React Flow visual editor (Phase 6)
        DAGStepNode.tsx             # Custom React Flow node component
        NodePropertiesPanel.tsx     # Right sidebar for selected node config
```

### RoutinesScreen

The main screen displays a list of routines with a header containing a count badge and "New Routine" button. Clicking a routine opens the `RoutineDetailPanel` as a slide-in from the right.

```tsx
// src/components/screens/RoutinesScreen.tsx

export default function RoutinesScreen() {
  const { routines, isLoading, loadRoutines, toggleEnabled } = useRoutines();
  const [selectedRoutine, setSelectedRoutine] = useState<Routine | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => { loadRoutines(); }, [loadRoutines]);

  return (
    <div className="flex h-full">
      {/* List panel */}
      <div className="flex-1 flex flex-col min-h-0 p-6">
        <header className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-zinc-100">Routines</h1>
            <span className="badge">{routines.length}</span>
          </div>
          <button onClick={() => setShowCreate(true)}>New Routine</button>
        </header>

        <div className="flex-1 overflow-y-auto space-y-3">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              onToggle={() => toggleEnabled(routine)}
              onSelect={() => setSelectedRoutine(routine)}
              onRunNow={() => handleRunNow(routine)}
            />
          ))}
        </div>
      </div>

      {/* Detail panel (slide-in) */}
      {selectedRoutine && (
        <RoutineDetailPanel
          routine={selectedRoutine}
          onClose={() => setSelectedRoutine(null)}
        />
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateRoutineDialog onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}
```

### RoutineCard

Each card displays:

| Element | Source |
|---------|--------|
| Name | `routine.name` |
| On/Off toggle | `routine.isEnabled` → calls `toggleEnabled()` |
| Trigger summary | `routine.triggerType` + formatted `cronExpression` |
| Default runner | Expert name via `routine.defaultRunnerId` (look up from ExpertContext) |
| Last run | `routine.lastRunAt` + `routine.lastRunStatus` with status badge |
| Run count | `routine.runCount` |
| Actions | **Edit** (opens detail panel), **Run Now** (starts execution) |

### RoutineDetailPanel

A slide-in panel from the right (similar to how ExpertsScreen could have a detail view) containing:

- **Header:** Routine name (editable inline), back/close button
- **Description:** Editable text area
- **Steps:** Ordered list of plain-english steps (reorderable, editable)
- **Trigger section:** Dropdown for trigger type + cron expression input (with human-readable preview, e.g. "Every weekday at 9:00 AM")
- **Runner section:** Expert selector dropdown (from ExpertContext)
- **Approval gates:** Toggle per step that requires approval
- **Required connections:** List of needed services (informational, validated against connected apps)
- **Show Details button:** Opens the DAG Editor (Phase 6)
- **Actions:** Save, Delete, Run Now

### CreateRoutineDialog

A modal for manual routine creation (outside of chat flow):

- **Name** (required text input)
- **Description** (optional text area)
- **Steps** (dynamic list — add/remove plain-english step descriptions)
- **Trigger** (dropdown: Manual, Cron, Webhook)
- **Default Runner** (expert selector)
- **Create button** → `POST /routines`

### Integration with AppLayout

Replace `PlaceholderScreen` for the `'routines'` screen:

```tsx
// src/components/layout/AppLayout.tsx (addition)
import RoutinesScreen from '../screens/RoutinesScreen';

// In renderContent():
if (activeScreen === 'routines') {
  return <RoutinesScreen />;
}
```

## Frontend: Visual DAG Editor

### Why React Flow

The existing `ExpertsScreen` uses a custom SVG canvas with pan/zoom for displaying expert relationships. This canvas is display-only — it renders a static layout with no drag-to-connect, no node editing, and no interactive graph manipulation. Building a full interactive DAG editor (drag nodes, create edges by connecting ports, node configuration panels, auto-layout) on top of this custom canvas would require reimplementing most of what React Flow provides out of the box.

React Flow is the standard React library for node-based graph editors. It provides:

- Draggable nodes with input/output handles (ports)
- Edge creation by dragging between handles
- Built-in zoom, pan, minimap, and controls
- Custom node components with full React rendering
- Bidirectional state management (controlled or uncontrolled)
- Layout algorithms (dagre, elkjs) for auto-arrangement

**Decision:** Use React Flow for the DAG editor. The ExpertsScreen canvas remains as-is (display-only, no dependency on React Flow).

### DAGEditor Component

```tsx
// src/components/screens/routines/DAGEditor.tsx

import { useCallback, useMemo } from 'react';
import ReactFlow, {
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import DAGStepNode from './DAGStepNode';
import NodePropertiesPanel from './NodePropertiesPanel';

interface DAGEditorProps {
  dagJson: string;                           // Current DAG as JSON string
  onDagChange: (dagJson: string) => void;    // Callback when DAG is modified
  onClose: () => void;                       // Close the editor
}

// Custom node types registered with React Flow
const nodeTypes = {
  dagStep: DAGStepNode,
};

export default function DAGEditor({ dagJson, onDagChange, onClose }: DAGEditorProps) {
  // Parse DAG into React Flow nodes and edges
  const { initialNodes, initialEdges } = useMemo(
    () => dagToReactFlow(JSON.parse(dagJson)),
    [dagJson],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // Sync React Flow state back to DAG JSON on changes
  const syncToDag = useCallback(() => {
    const dag = reactFlowToDAG(nodes, edges);
    onDagChange(JSON.stringify(dag));
  }, [nodes, edges, onDagChange]);

  const onConnect: OnConnect = useCallback(
    (params) => {
      setEdges((eds) => addEdge(params, eds));
      // Sync after edge creation
      setTimeout(syncToDag, 0);
    },
    [setEdges, syncToDag],
  );

  return (
    <div className="flex h-full">
      {/* Canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => setSelectedNode(node.id)}
          fitView
        >
          <Controls />
          <MiniMap />
          <Background />
        </ReactFlow>
      </div>

      {/* Properties panel */}
      {selectedNode && (
        <NodePropertiesPanel
          node={nodes.find((n) => n.id === selectedNode)}
          onUpdate={(updatedData) => {
            setNodes((nds) =>
              nds.map((n) =>
                n.id === selectedNode ? { ...n, data: { ...n.data, ...updatedData } } : n,
              ),
            );
            syncToDag();
          }}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
```

### Bidirectional Sync: React Flow ↔ DAG JSON

Two conversion functions handle the mapping:

```typescript
// dagToReactFlow(dag: DAGDefinition) → { nodes: Node[], edges: Edge[] }
//
// Each StepDefinition becomes a Node with:
//   - id: step.id
//   - type: 'dagStep'
//   - data: { name: step.name, actionType: step.actionType, params: step.params, ... }
//   - position: auto-layout via dagre (top-to-bottom)
//
// Each dependency (step.dependsOn) becomes an Edge:
//   - id: `${sourceId}-${targetId}`
//   - source: dependency step ID
//   - target: dependent step ID
//
// InputMappings are stored in node data for the properties panel.

// reactFlowToDAG(nodes: Node[], edges: Edge[]) → DAGDefinition
//
// Each Node becomes a StepDefinition:
//   - dependsOn: derived from incoming edges
//   - inputMappings: restored from node data
//   - All other fields from node.data
```

### DAGStepNode Component

```tsx
// src/components/screens/routines/DAGStepNode.tsx

import { Handle, Position, type NodeProps } from 'reactflow';

interface DAGStepData {
  name: string;
  actionType: string;
  params: Record<string, unknown>;
  requiresApproval: boolean;
}

export default function DAGStepNode({ data }: NodeProps<DAGStepData>) {
  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 min-w-[180px]">
      <Handle type="target" position={Position.Top} />

      {/* Action type badge */}
      <div className="text-xs text-accent font-mono mb-1">
        {data.actionType}
      </div>

      {/* Step name */}
      <div className="text-sm text-zinc-100 font-medium">
        {data.name}
      </div>

      {/* Approval indicator */}
      {data.requiresApproval && (
        <div className="text-xs text-amber-400 mt-1">Requires approval</div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
```

### NodePropertiesPanel

A right sidebar that appears when a node is selected, showing:

- **Step name** (editable)
- **Action type** (dropdown: model_call, transformer, expert_step, connector, channel)
- **Parameters** (dynamic form based on action type):
  - `model_call`: prompt, system prompt, temperature, max tokens
  - `transformer`: operation type, template/path/predicate
  - `expert_step`: expert selector, prompt, max turns, tool access
  - `connector`: service, operation, payload
  - `channel`: channel, operation, recipients, message
- **Error policy** (dropdown: fail, skip, retry + max retries)
- **Requires approval** (toggle)
- **Timeout** (number input, ms)
- **Input mappings** (read-only list showing wired inputs from upstream nodes)

## Chat Integration: RunLogCard

### Purpose

`RunLogCard` renders inline in chat when a message has an `engineRunId`. It subscribes to real-time engine events and displays a collapsible log of the run's progress — step-by-step status, timing, and outputs. This is used for both "Run Now" from chat and "Preview" from a routine proposal.

### Component Design

```tsx
// src/components/chat/RunLogCard.tsx

import { useState, useEffect } from 'react';
import type { ExecutionEvent } from '../../engine/events/types';

interface RunLogCardProps {
  runId: string;
}

interface StepState {
  id: string;
  name: string;
  actionType: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  summary?: string;
  error?: string;
  durationMs?: number;
}

export default function RunLogCard({ runId }: RunLogCardProps) {
  const [runStatus, setRunStatus] = useState<'running' | 'completed' | 'failed' | 'cancelled'>('running');
  const [steps, setSteps] = useState<StepState[]>([]);
  const [totalSteps, setTotalSteps] = useState(0);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    const unsubscribe = window.cerebro.engine.onEvent(runId, (event: ExecutionEvent) => {
      switch (event.type) {
        case 'run_started':
          setTotalSteps(event.totalSteps);
          break;

        case 'step_started':
          setSteps((prev) => [
            ...prev.filter((s) => s.id !== event.stepId),
            {
              id: event.stepId,
              name: event.stepName,
              actionType: event.actionType,
              status: 'running',
            },
          ]);
          break;

        case 'step_completed':
          setSteps((prev) =>
            prev.map((s) =>
              s.id === event.stepId
                ? { ...s, status: 'completed', summary: event.summary, durationMs: event.durationMs }
                : s,
            ),
          );
          break;

        case 'step_failed':
          setSteps((prev) =>
            prev.map((s) =>
              s.id === event.stepId
                ? { ...s, status: 'failed', error: event.error }
                : s,
            ),
          );
          break;

        case 'run_completed':
          setRunStatus('completed');
          break;

        case 'run_failed':
          setRunStatus('failed');
          break;

        case 'run_cancelled':
          setRunStatus('cancelled');
          break;
      }
    });

    return unsubscribe;
  }, [runId]);

  return (
    <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-4 my-2">
      {/* Header with run status */}
      <button
        className="flex items-center justify-between w-full"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          <StatusIcon status={runStatus} />
          <span className="text-sm font-medium text-zinc-200">
            Routine Run
          </span>
          <span className="text-xs text-zinc-400">
            {steps.filter((s) => s.status === 'completed').length}/{totalSteps} steps
          </span>
        </div>
        <ChevronIcon expanded={isExpanded} />
      </button>

      {/* Collapsible step list */}
      {isExpanded && (
        <div className="mt-3 space-y-2">
          {steps.map((step) => (
            <div key={step.id} className="flex items-center gap-2 text-sm">
              <StepStatusIcon status={step.status} />
              <span className="text-zinc-300">{step.name}</span>
              {step.summary && (
                <span className="text-zinc-500 text-xs ml-auto">{step.summary}</span>
              )}
              {step.durationMs && (
                <span className="text-zinc-600 text-xs">{step.durationMs}ms</span>
              )}
              {step.error && (
                <span className="text-red-400 text-xs">{step.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Integration with ChatMessage

In `ChatMessage`, when `message.engineRunId` is present, render the `RunLogCard` below the message content:

```tsx
// In src/components/chat/ChatMessage.tsx (addition)
{message.engineRunId && (
  <RunLogCard runId={message.engineRunId} />
)}
```

## Chat Integration: RoutineProposalCard

### Purpose

`RoutineProposalCard` renders inline when a message has a `routineProposal` field. It displays the proposed routine with action buttons (Preview, Edit, Save Routine) that let the user progress through the proposal → preview → save flow entirely within the chat.

### RoutineProposal Interface

```typescript
// Already defined in src/types/chat.ts additions above:
export interface RoutineProposal {
  name: string;
  steps: string[];                 // Plain-english step descriptions
  triggerType: TriggerType;
  cronExpression?: string;
  defaultRunnerId?: string;
  requiredConnections: string[];
  approvalGates: string[];
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
  savedRoutineId?: string;
}
```

### Component Design

```tsx
// src/components/chat/RoutineProposalCard.tsx

interface RoutineProposalCardProps {
  proposal: RoutineProposal;
  messageId: string;
  onPreview: () => void;
  onSave: () => void;
  onDismiss: () => void;
}

export default function RoutineProposalCard({
  proposal,
  messageId,
  onPreview,
  onSave,
  onDismiss,
}: RoutineProposalCardProps) {
  return (
    <div className="bg-zinc-800/50 border border-accent/30 rounded-lg p-4 my-2">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <ZapIcon className="text-accent" size={16} />
        <span className="text-sm font-semibold text-zinc-100">{proposal.name}</span>
        <StatusBadge status={proposal.status} />
      </div>

      {/* Steps list */}
      <ol className="space-y-1 mb-3">
        {proposal.steps.map((step, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
            <span className="text-zinc-500 font-mono text-xs mt-0.5">{i + 1}.</span>
            {step}
          </li>
        ))}
      </ol>

      {/* Metadata */}
      <div className="flex flex-wrap gap-3 text-xs text-zinc-400 mb-3">
        <span>Trigger: {formatTrigger(proposal.triggerType, proposal.cronExpression)}</span>
        {proposal.defaultRunnerId && <span>Runner: {runnerName}</span>}
        {proposal.requiredConnections.length > 0 && (
          <span>Connections: {proposal.requiredConnections.join(', ')}</span>
        )}
        {proposal.approvalGates.length > 0 && (
          <span>Approval gates: {proposal.approvalGates.length}</span>
        )}
      </div>

      {/* Missing connections warning */}
      {missingConnections.length > 0 && (
        <div className="text-xs text-amber-400 mb-3">
          Missing connections: {missingConnections.join(', ')}
        </div>
      )}

      {/* Action buttons */}
      {proposal.status === 'proposed' && (
        <div className="flex gap-2">
          <button onClick={onPreview} className="btn-secondary text-sm">
            Preview
          </button>
          <button onClick={onSave} className="btn-primary text-sm">
            Save Routine
          </button>
          <button onClick={onDismiss} className="btn-ghost text-sm">
            Dismiss
          </button>
        </div>
      )}

      {proposal.status === 'saved' && (
        <div className="text-xs text-green-400">
          Saved as routine
        </div>
      )}
    </div>
  );
}
```

### Integration with ChatMessage

```tsx
// In src/components/chat/ChatMessage.tsx (addition)
{message.routineProposal && (
  <RoutineProposalCard
    proposal={message.routineProposal}
    messageId={message.id}
    onPreview={() => handlePreview(message)}
    onSave={() => handleSaveRoutine(message)}
    onDismiss={() => handleDismissProposal(message)}
  />
)}
```

### Save Flow

When the user clicks "Save Routine":

1. `ChatContext.handleSaveRoutine(message)` is called
2. It extracts the proposal data and calls `RoutineContext.createRoutine()`:
   ```typescript
   const routine = await createRoutine({
     name: proposal.name,
     plainEnglishSteps: proposal.steps,
     dagJson: compiledDagJson,
     triggerType: proposal.triggerType,
     cronExpression: proposal.cronExpression,
     defaultRunnerId: proposal.defaultRunnerId,
     approvalGates: proposal.approvalGates,
     requiredConnections: proposal.requiredConnections,
     source: 'chat',
     sourceConversationId: message.conversationId,
   });
   ```
3. On success, update the proposal status to `'saved'` with `savedRoutineId`
4. If the routine has a cron trigger, call `window.cerebro.scheduler.sync()` to register the cron job

## Agent Tools

### Tool Context Extension

The `ToolContext` interface needs the execution engine reference for `run_routine`:

```typescript
// src/agents/types.ts (addition)
import type { ExecutionEngine } from '../engine/engine';
import type { WebContents } from 'electron';

export interface ToolContext {
  expertId: string | null;
  conversationId: string;
  scope: string;
  scopeId: string | null;
  backendPort: number;
  executionEngine?: ExecutionEngine;   // NEW — available for routine tools
  webContents?: WebContents;           // NEW — needed for engine.startRun()
}
```

### run_routine Tool

```typescript
// src/agents/tools/routine-tools.ts

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ToolContext } from '../types';

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: 'text', text }], details: undefined as any };
}

interface RoutineApiResponse {
  id: string;
  name: string;
  dag_json: string | null;
  is_enabled: boolean;
  plain_english_steps: string[] | null;
}

export function createRunRoutine(ctx: ToolContext): AgentTool {
  return {
    name: 'run_routine',
    description:
      'Run an existing routine by name or ID. The routine executes through the execution engine ' +
      'with live event streaming. Use this when the user asks to run a saved routine.',
    label: 'Run Routine',
    parameters: Type.Object({
      routine_name_or_id: Type.String({
        description: 'The name or ID of the routine to run',
      }),
    }),
    execute: async (_toolCallId, params) => {
      if (!ctx.executionEngine || !ctx.webContents) {
        return textResult('Execution engine is not available.');
      }

      // Look up routine from backend
      let routine: RoutineApiResponse;
      try {
        routine = await backendRequest<RoutineApiResponse>(
          ctx.backendPort,
          'POST',
          `/routines/${encodeURIComponent(params.routine_name_or_id)}/run`,
        );
      } catch {
        // Try fuzzy match by name via list endpoint
        try {
          const list = await backendRequest<{ routines: RoutineApiResponse[] }>(
            ctx.backendPort,
            'GET',
            '/routines?limit=200',
          );
          const match = list.routines.find(
            (r) =>
              r.name.toLowerCase() === params.routine_name_or_id.toLowerCase() ||
              r.id === params.routine_name_or_id,
          );
          if (!match) {
            return textResult(
              `No routine found matching "${params.routine_name_or_id}". ` +
              'The user can create routines from the Routines screen or by asking me to propose one.',
            );
          }
          routine = await backendRequest<RoutineApiResponse>(
            ctx.backendPort,
            'POST',
            `/routines/${match.id}/run`,
          );
        } catch (err) {
          return textResult(`Failed to find routine: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (!routine.dag_json) {
        return textResult(
          `Routine "${routine.name}" has no compiled DAG. ` +
          'It needs to be compiled from its plain-english steps first.',
        );
      }

      // Execute the routine via the engine
      try {
        const dag = JSON.parse(routine.dag_json);
        const runId = await ctx.executionEngine.startRun(ctx.webContents, {
          dag,
          routineId: routine.id,
          triggerSource: 'chat',
        });

        return textResult(
          `Started routine "${routine.name}" (run ID: ${runId}). ` +
          'The execution is streaming live — the user can see step-by-step progress in the chat.',
        );
      } catch (err) {
        return textResult(`Failed to start routine: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
```

### propose_routine Tool

```typescript
// src/agents/tools/routine-tools.ts (continued)

export function createProposeRoutine(ctx: ToolContext): AgentTool {
  return {
    name: 'propose_routine',
    description:
      'Propose saving a repeatable task as a routine. Returns a structured proposal that ' +
      'renders as an interactive card in chat. Use this when you detect the user wants to ' +
      'automate a repeatable task. Include clear step descriptions, trigger type, and any ' +
      'required connections or approval gates.',
    label: 'Propose Routine',
    parameters: Type.Object({
      name: Type.String({ description: 'Name for the routine' }),
      steps: Type.Array(Type.String(), {
        description: 'Plain-english step descriptions in execution order',
      }),
      trigger_type: Type.Optional(
        Type.Union([
          Type.Literal('manual'),
          Type.Literal('cron'),
          Type.Literal('webhook'),
        ], { description: 'How the routine is triggered (default: manual)', default: 'manual' }),
      ),
      cron_expression: Type.Optional(
        Type.String({ description: 'Cron expression if trigger_type is cron' }),
      ),
      default_runner_id: Type.Optional(
        Type.String({ description: 'Expert ID to assign as default runner' }),
      ),
      required_connections: Type.Optional(
        Type.Array(Type.String(), { description: 'Service connections needed' }),
      ),
      approval_gates: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Step descriptions that require user approval before executing',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      // Return structured proposal data that ChatContext renders as a card.
      // The tool result is interpreted by ChatContext to create a RoutineProposal.
      const proposal = {
        type: 'routine_proposal',
        name: params.name,
        steps: params.steps,
        triggerType: params.trigger_type ?? 'manual',
        cronExpression: params.cron_expression,
        defaultRunnerId: params.default_runner_id,
        requiredConnections: params.required_connections ?? [],
        approvalGates: params.approval_gates ?? [],
      };

      return textResult(JSON.stringify(proposal));
    },
  };
}
```

### Tool Registration

```typescript
// src/agents/tools/index.ts (additions)

import { createRunRoutine, createProposeRoutine } from './routine-tools';

// Add to TOOL_FACTORIES:
const TOOL_FACTORIES: Record<string, (ctx: ToolContext) => AgentTool> = {
  // ... existing tools ...
  run_routine: createRunRoutine,
  propose_routine: createProposeRoutine,
};

// Add to DEFAULT_TOOLS:
const DEFAULT_TOOLS = [
  // ... existing tools ...
  'run_routine',
  'propose_routine',
];
```

### ChatContext Integration

When `ChatContext` processes a tool result from `propose_routine`, it checks for the `type: 'routine_proposal'` marker and creates a `RoutineProposal` on the message:

```typescript
// In ChatContext, when processing tool results:
if (toolResult.includes('"type":"routine_proposal"')) {
  try {
    const proposal = JSON.parse(toolResult);
    if (proposal.type === 'routine_proposal') {
      // Attach proposal to the assistant message
      currentMessage.routineProposal = {
        name: proposal.name,
        steps: proposal.steps,
        triggerType: proposal.triggerType,
        cronExpression: proposal.cronExpression,
        defaultRunnerId: proposal.defaultRunnerId,
        requiredConnections: proposal.requiredConnections,
        approvalGates: proposal.approvalGates,
        status: 'proposed',
      };
    }
  } catch {
    // Not a proposal, treat as normal text
  }
}
```

## Cerebro Proposal Logic

### Approach: Prompt Engineering

Rather than building a separate "intent detection" system, we add guidance to Cerebro's system prompt that teaches it when and how to use the `propose_routine` tool. This is consistent with how the agent system works — tools are the mechanism for structured actions, and the system prompt guides when to use them.

### System Prompt Addition

```
## Routine Proposals

When you detect that a user is describing a repeatable task — something they want to happen
regularly, on a schedule, or as a reusable workflow — use the `propose_routine` tool to
suggest saving it as a routine.

Signs of repeatable intent:
- Time-based language: "every morning", "weekly", "after each meeting", "daily at 9am"
- Automation language: "automatically", "I want it to always", "set up a routine"
- Multi-step descriptions: "first do X, then Y, then Z"
- Explicit requests: "create a routine", "save this as a routine"

When proposing a routine:
- Give it a clear, descriptive name
- Break the task into discrete, ordered steps
- Set the appropriate trigger type (manual, cron, webhook)
- Include a cron expression for scheduled routines
- List any required external connections (google_calendar, gmail, etc.)
- Mark steps that should require user approval (sending emails, modifying calendars, etc.)
- If the user mentions an expert by name, set that expert as the default runner

Do NOT propose a routine when:
- The user is asking a one-off question
- The task is simple enough to just do directly
- The user explicitly says they don't want a routine
```

### Linear DAG Generator

For V0, Cerebro converts plain-english steps into a **sequential (linear) DAG** — each step depends on the previous one. This is the simplest compilation strategy and covers the majority of initial use cases.

```typescript
// src/engine/dag/compiler.ts

import type { DAGDefinition, StepDefinition } from './types';

interface CompileOptions {
  steps: string[];
  defaultRunnerId?: string;
  approvalGates?: string[];
}

/**
 * Compile plain-english steps into a linear DAG.
 *
 * Each step becomes a `model_call` or `expert_step` action depending on
 * whether a default runner is specified. Steps execute sequentially,
 * with each step's output wired as context to the next.
 */
export function compileLinearDAG(options: CompileOptions): DAGDefinition {
  const { steps, defaultRunnerId, approvalGates = [] } = options;

  const dagSteps: StepDefinition[] = steps.map((stepText, index) => {
    const stepId = `step_${index + 1}`;
    const prevStepId = index > 0 ? `step_${index}` : undefined;

    // Determine action type: expert_step if runner specified, model_call otherwise
    const actionType = defaultRunnerId ? 'expert_step' : 'model_call';

    const params: Record<string, unknown> =
      actionType === 'expert_step'
        ? {
            prompt: stepText,
            expertId: defaultRunnerId,
            additionalContext: prevStepId
              ? `Previous step output: {{previous_output}}`
              : undefined,
          }
        : {
            prompt: stepText,
            systemPrompt: 'You are executing a step in a routine. Complete the task described.',
          };

    return {
      id: stepId,
      name: stepText,
      actionType,
      params,
      dependsOn: prevStepId ? [prevStepId] : [],
      inputMappings: prevStepId
        ? [{ sourceStepId: prevStepId, sourceField: 'response', targetField: 'previous_output' }]
        : [],
      requiresApproval: approvalGates.includes(stepText),
      onError: 'fail' as const,
    };
  });

  return { steps: dagSteps };
}
```

**Future enhancement:** An LLM-based DAG compiler that analyzes step descriptions, detects parallel branches (e.g., "fetch calendar" and "check todos" can run in parallel), identifies data dependencies, and generates optimized DAGs with appropriate action types. This is a natural evolution but not needed for V0.

## Preview Execution

### How Preview Works

Preview uses the exact same execution path as a real routine run. The only differences are metadata:

1. `triggerSource` is set to `'preview'` in the `EngineRunRequest`
2. `run_type` is set to `'preview'` in the `RunRecord`

The engine, DAG executor, actions, events, and persistence all behave identically. This ensures "what you preview is what you get" — there's no separate preview mode that could diverge from real execution.

### Preview Flow

```
User clicks "Preview" on RoutineProposalCard
       │
       ▼
ChatContext.handlePreview(message)
       │
       ├──► Compile plain-english steps → DAG via compileLinearDAG()
       ├──► Update proposal status to 'previewing'
       │
       ▼
window.cerebro.engine.run({
  dag: compiledDag,
  triggerSource: 'preview',
})
       │
       ├──► Returns runId
       ├──► Create a new assistant message with engineRunId = runId
       ├──► RunLogCard renders inline with live event stream
       │
       ▼
Execution completes (same as any engine run)
       │
       ├──► RunRecord created with run_type: 'preview'
       ├──► Visible in Activity screen (filterable by run_type)
       └──► Proposal status remains 'previewing' (user can still Save)
```

### Activity Filtering

The Activity screen (roadmap #8) will filter runs by `run_type`. Preview runs are included but distinguished with a "Preview" badge so users can tell them apart from real executions.

## Cron Scheduler

### Design

The `RoutineScheduler` runs in the Electron main process alongside the `ExecutionEngine`. It manages `node-cron` jobs for routines with `trigger_type: 'cron'` and `is_enabled: true`.

### RoutineScheduler Class

```typescript
// src/scheduler/scheduler.ts

import cron from 'node-cron';
import type { WebContents } from 'electron';
import type { ExecutionEngine } from '../engine/engine';
import { compileLinearDAG } from '../engine/dag/compiler';

interface ScheduledJob {
  routineId: string;
  task: cron.ScheduledTask;
}

interface RoutineData {
  id: string;
  name: string;
  cron_expression: string;
  dag_json: string | null;
  plain_english_steps: string[] | null;
  default_runner_id: string | null;
  approval_gates: string[] | null;
  is_enabled: boolean;
}

export class RoutineScheduler {
  private jobs = new Map<string, ScheduledJob>();
  private engine: ExecutionEngine;
  private backendPort: number;
  private webContents: WebContents | null = null;

  constructor(engine: ExecutionEngine, backendPort: number) {
    this.engine = engine;
    this.backendPort = backendPort;
  }

  /** Set the webContents reference (called after window creation). */
  setWebContents(webContents: WebContents): void {
    this.webContents = webContents;
  }

  /**
   * Sync scheduled jobs with the backend.
   * Fetches all enabled cron routines and reconciles with active jobs.
   */
  async sync(): Promise<void> {
    // Fetch enabled cron routines from backend
    const routines = await this.fetchCronRoutines();

    // Build set of routine IDs that should have jobs
    const desiredIds = new Set(routines.map((r) => r.id));

    // Remove jobs for routines that are no longer enabled/cron
    for (const [routineId, job] of this.jobs) {
      if (!desiredIds.has(routineId)) {
        job.task.stop();
        this.jobs.delete(routineId);
      }
    }

    // Add or update jobs for current routines
    for (const routine of routines) {
      const existing = this.jobs.get(routine.id);

      if (existing) {
        // Check if cron expression changed
        // node-cron doesn't expose the expression, so we recreate
        existing.task.stop();
      }

      if (!cron.validate(routine.cron_expression)) {
        console.error(`[Scheduler] Invalid cron expression for "${routine.name}": ${routine.cron_expression}`);
        continue;
      }

      const task = cron.schedule(routine.cron_expression, () => {
        this.executeRoutine(routine);
      });

      this.jobs.set(routine.id, { routineId: routine.id, task });
    }

    console.log(`[Scheduler] Synced ${this.jobs.size} cron jobs`);
  }

  /** Stop all scheduled jobs. */
  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.task.stop();
    }
    this.jobs.clear();
  }

  private async executeRoutine(routine: RoutineData): Promise<void> {
    if (!this.webContents) {
      console.error('[Scheduler] No webContents available — cannot stream events');
      return;
    }

    // Compile or use existing DAG
    let dag;
    if (routine.dag_json) {
      dag = JSON.parse(routine.dag_json);
    } else if (routine.plain_english_steps) {
      const steps = JSON.parse(routine.plain_english_steps) as string[];
      dag = compileLinearDAG({
        steps,
        defaultRunnerId: routine.default_runner_id ?? undefined,
        approvalGates: routine.approval_gates
          ? JSON.parse(routine.approval_gates) as string[]
          : undefined,
      });
    } else {
      console.error(`[Scheduler] Routine "${routine.name}" has no DAG or steps`);
      return;
    }

    try {
      const runId = await this.engine.startRun(this.webContents, {
        dag,
        routineId: routine.id,
        triggerSource: 'schedule',
      });
      console.log(`[Scheduler] Started routine "${routine.name}" (run: ${runId})`);
    } catch (err) {
      console.error(`[Scheduler] Failed to start routine "${routine.name}":`, err);
    }
  }

  private async fetchCronRoutines(): Promise<RoutineData[]> {
    return new Promise((resolve) => {
      const http = require('node:http');
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path: '/routines?trigger_type=cron&is_enabled=true&limit=200',
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000,
        },
        (res: any) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.routines ?? []);
            } catch {
              resolve([]);
            }
          });
        },
      );
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    });
  }
}
```

### Lifecycle in main.ts

```typescript
// src/main.ts (additions)

import { RoutineScheduler } from './scheduler/scheduler';

// After ExecutionEngine is created:
const scheduler = new RoutineScheduler(executionEngine, backendPort);

// After window is created:
scheduler.setWebContents(mainWindow.webContents);

// After backend is healthy:
scheduler.sync();

// On app quit:
scheduler.stopAll();
```

### IPC Channel

```typescript
// src/types/ipc.ts (addition)
SCHEDULER_SYNC: 'scheduler:sync',

// In CerebroAPI:
scheduler: {
  sync(): Promise<void>;
}
```

### IPC Handler in main.ts

```typescript
ipcMain.handle(IPC_CHANNELS.SCHEDULER_SYNC, async () => {
  await scheduler.sync();
});
```

### Preload Bridge

```typescript
// src/preload.ts (addition)
scheduler: {
  sync: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_SYNC),
},
```

### Trigger After Routine Mutations

The renderer calls `window.cerebro.scheduler.sync()` after any routine mutation that could affect scheduling:

- Creating a routine with `trigger_type: 'cron'`
- Updating a routine's `trigger_type`, `cron_expression`, or `is_enabled`
- Deleting a routine

This is called in `RoutineContext` after successful API calls:

```typescript
// In RoutineContext, after updateRoutine/createRoutine/deleteRoutine:
window.cerebro.scheduler?.sync().catch(console.error);
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Routine storage | SQLite via backend API (same as Experts) | Consistent with existing data model patterns. Backend handles all persistence. |
| DAG compilation | Linear DAG from plain-english steps (V0) | Simple, covers most initial use cases. LLM-based compilation is a future enhancement. |
| Visual editor | React Flow library | Industry-standard React graph editor. Custom SVG canvas in ExpertsScreen is display-only, not suited for interactive DAG editing. |
| Cron scheduler | `node-cron` in Electron main process | Runs alongside ExecutionEngine. No external scheduler service. Jobs sync from backend. |
| Preview execution | Same engine path with `run_type: 'preview'` | Guarantees preview matches real execution. No separate "simulation" mode to maintain. |
| Proposal flow | Agent tool (`propose_routine`) → structured result → card in chat | Uses existing agent tool infrastructure. No separate proposal API needed. |
| Routine run initiation | Agent tool (`run_routine`) calls `engine.startRun()` directly | Both live in the main process. No IPC overhead for the critical path. Chat trigger uses the agent tool; schedule trigger uses the scheduler. |
| Context provider order | `RoutineProvider` above `ChatProvider` | Chat's proposal save flow needs routine context. Mirrors how ProviderProvider wraps ModelProvider wraps MemoryProvider. |
| `run_routine` name matching | Try by ID first, fall back to fuzzy name match | Users will say "run my morning routine" not "run routine abc123". Agent passes the name; tool resolves it. |
| Scheduler resync | Explicit `sync()` call after mutations | More predictable than polling. Lightweight — reads a small number of routines. |
| `RunRecord.routine_id` FK | Already exists as nullable column | Execution Engine design anticipated this. No migration needed. |
| Message extensions | `engineRunId` + `routineProposal` on Message type | Minimal type extension. Inline components check for presence of these fields. |

## Implementation Phases

### Phase 1: Data Model + Backend API + Routines Screen (List View)

**Roadmap tasks:** Routine data model and schema + Routines screen (list, toggle, trigger summary, Run Now).

- Add `Routine` model to `backend/models.py`
- Create `backend/routines/` module with `schemas.py` and `router.py`
- Mount `/routines` router in `backend/main.py`
- Create `src/types/routines.ts` with frontend types
- Create `src/context/RoutineContext.tsx` (CRUD state, following ExpertContext pattern)
- Add `RoutineProvider` to `src/App.tsx` provider hierarchy
- Create `src/components/screens/RoutinesScreen.tsx` with list view
- Create `RoutineCard.tsx`, `RoutineDetailPanel.tsx`, `CreateRoutineDialog.tsx`
- Wire `RoutinesScreen` into `AppLayout.tsx` (replacing PlaceholderScreen)
- "Run Now" button compiles DAG and calls `engine.startRun()` via IPC

**Deliverable:** Users can create, edit, enable/disable, delete routines from the Routines screen. Run Now executes the routine through the engine.

### Phase 2: RunLogCard + run_routine Tool

**Roadmap task:** Run Now with live inline logs in Chat.

- Extend `Message` type in `src/types/chat.ts` with `engineRunId`
- Create `src/components/chat/RunLogCard.tsx`
- Integrate RunLogCard into `ChatMessage` (renders when `engineRunId` present)
- Create `src/agents/tools/routine-tools.ts` with `createRunRoutine()`
- Register `run_routine` in `src/agents/tools/index.ts`
- Extend `ToolContext` with `executionEngine` and `webContents`
- When `run_routine` executes, create a message with `engineRunId` for inline logs

**Deliverable:** Users can say "run my morning routine" in chat, and see live step-by-step execution logs inline.

### Phase 3: RoutineProposalCard + propose_routine Tool + Proposal Logic

**Roadmap task:** Routine Proposal Cards in Chat (propose → preview → save) + Cerebro routine proposal logic.

- Extend `Message` type with `routineProposal` (RoutineProposal interface)
- Create `src/components/chat/RoutineProposalCard.tsx`
- Integrate RoutineProposalCard into `ChatMessage`
- Create `createProposeRoutine()` in `routine-tools.ts`
- Register `propose_routine` in `src/agents/tools/index.ts`
- Add ChatContext logic to detect `routine_proposal` tool results and attach to messages
- Add system prompt guidance for when to call `propose_routine`
- Create `src/engine/dag/compiler.ts` with `compileLinearDAG()`
- Implement Save flow (RoutineProposalCard → RoutineContext.createRoutine → update status)

**Deliverable:** Cerebro proposes routines as inline cards when it detects repeatable intent. Users can save proposals as routines.

### Phase 4: Preview Execution

**Roadmap task:** Preview execution with streaming logs.

- Add "Preview" button handler in RoutineProposalCard
- Compile proposal steps into DAG via `compileLinearDAG()`
- Call `engine.run()` with `triggerSource: 'preview'`
- Create follow-up message with `engineRunId` for inline RunLogCard
- Update proposal status to `'previewing'`
- Verify RunRecord has `run_type: 'preview'` for Activity filtering

**Deliverable:** Users can preview a proposed routine before saving, seeing the same live execution they'd get from a real run.

### Phase 5: Cron Scheduler

**Roadmap task:** Cron scheduler for scheduled routines.

- Install `node-cron` and `@types/node-cron`
- Create `src/scheduler/scheduler.ts` with `RoutineScheduler` class
- Add `SCHEDULER_SYNC` IPC channel to `src/types/ipc.ts`
- Add `scheduler` to `CerebroAPI` interface and preload bridge
- Register IPC handler in `src/main.ts`
- Initialize scheduler after engine, set webContents after window, sync after backend healthy
- Add `sync()` calls to RoutineContext after mutations that affect scheduling
- Add cron expression input to RoutineDetailPanel with human-readable preview

**Deliverable:** Routines with cron triggers execute automatically on schedule.

### Phase 6: Visual DAG Editor

**Roadmap task:** (Highest complexity phase, independent of chat features.)

- Install `reactflow`
- Create `src/components/screens/routines/DAGEditor.tsx`
- Create `DAGStepNode.tsx` custom node component
- Create `NodePropertiesPanel.tsx` for selected node configuration
- Implement `dagToReactFlow()` and `reactFlowToDAG()` conversion functions
- Add auto-layout via dagre integration
- Add "Show Details" button in RoutineDetailPanel that opens DAGEditor
- Bidirectional sync: editing nodes/edges updates `dagJson`, and vice versa
- Test: create DAG visually, save, execute, verify correct execution

**Deliverable:** Users can see and edit the action graph of any routine in a visual node-based editor, matching the visual workflow-builder interaction model.

## Testing Strategy

### Backend Tests

Following the `test_engine.py` pattern in `backend/tests/`:

```python
# backend/tests/test_routines.py

def test_create_routine(client):
    """Create a routine and verify response fields."""
    resp = client.post("/routines", json={
        "name": "Morning Prep",
        "plain_english_steps": ["Pull calendar", "Check todos", "Draft plan"],
        "trigger_type": "manual",
    })
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Morning Prep"
    assert data["plain_english_steps"] == ["Pull calendar", "Check todos", "Draft plan"]
    assert data["trigger_type"] == "manual"
    assert data["is_enabled"] is True
    assert data["run_count"] == 0

def test_list_routines_filter(client):
    """Filter routines by trigger_type and is_enabled."""

def test_update_routine(client):
    """PATCH updates only provided fields."""

def test_delete_routine(client):
    """DELETE removes routine and returns 204."""

def test_get_routine_for_run(client):
    """POST /routines/{id}/run increments run_count and returns routine data."""

def test_run_disabled_routine(client):
    """POST /routines/{id}/run returns 400 for disabled routines."""
```

### Frontend Tests

- **RoutineContext:** Unit tests for `toRoutine()` mapping, `loadRoutines()` API call, `createRoutine()`, `updateRoutine()`, `deleteRoutine()`, `toggleEnabled()`
- **RunLogCard:** Test event handling — verify that `run_started`, `step_started`, `step_completed`, `step_failed`, `run_completed` events update component state correctly
- **RoutineProposalCard:** Test status rendering (proposed, previewing, saved), button visibility per status
- **DAG compiler:** Test `compileLinearDAG()` with various step counts, with/without runner, with approval gates

### Integration Tests

- **End-to-end creation:** Create routine via API → list in RoutinesScreen → Run Now → verify RunRecord created with `routine_id`
- **Chat proposal flow:** Send chat message → agent calls `propose_routine` → RoutineProposalCard renders → Save → routine appears in backend
- **Cron execution:** Create cron routine → sync scheduler → advance time → verify engine.startRun() called with correct routine_id

## Dependencies

### New npm Packages

| Package | Purpose | Used In |
|---------|---------|---------|
| `node-cron` | Cron job scheduling | `src/scheduler/scheduler.ts` |
| `@types/node-cron` | TypeScript types for node-cron | Dev dependency |
| `reactflow` | Visual DAG editor | `src/components/screens/routines/DAGEditor.tsx` |

### No New Python Packages

The backend changes are pure FastAPI/SQLAlchemy CRUD — no additional Python dependencies needed.

## Files Created

| File | Purpose |
|------|---------|
| `src/types/routines.ts` | Routine, CreateRoutineInput, TriggerType types |
| `src/context/RoutineContext.tsx` | RoutineProvider, useRoutines hook |
| `src/components/screens/RoutinesScreen.tsx` | Main routines screen with list view |
| `src/components/screens/routines/RoutineCard.tsx` | Individual routine card in list |
| `src/components/screens/routines/RoutineDetailPanel.tsx` | Slide-in edit panel |
| `src/components/screens/routines/CreateRoutineDialog.tsx` | Manual creation modal |
| `src/components/screens/routines/DAGEditor.tsx` | React Flow visual editor |
| `src/components/screens/routines/DAGStepNode.tsx` | Custom React Flow node |
| `src/components/screens/routines/NodePropertiesPanel.tsx` | Node config sidebar |
| `src/components/chat/RunLogCard.tsx` | Inline run execution log card |
| `src/components/chat/RoutineProposalCard.tsx` | Inline routine proposal card |
| `src/agents/tools/routine-tools.ts` | run_routine + propose_routine agent tools |
| `src/engine/dag/compiler.ts` | Linear DAG compiler from plain-english steps |
| `src/scheduler/scheduler.ts` | RoutineScheduler with node-cron |
| `backend/routines/__init__.py` | Module init |
| `backend/routines/schemas.py` | Pydantic schemas for routines |
| `backend/routines/router.py` | /routines/* REST endpoints |
| `backend/tests/test_routines.py` | Backend test suite for routine CRUD |

## Files Modified

| File | Change |
|------|--------|
| `backend/models.py` | Add Routine SQLAlchemy model, update RunRecord.routine_id FK |
| `backend/main.py` | Import Routine model, mount `/routines` router |
| `src/types/chat.ts` | Add `engineRunId`, `routineProposal` fields to Message, add RoutineProposal interface |
| `src/types/ipc.ts` | Add SCHEDULER_SYNC channel, scheduler to CerebroAPI |
| `src/agents/types.ts` | Add `executionEngine`, `webContents` to ToolContext |
| `src/agents/tools/index.ts` | Register run_routine, propose_routine in TOOL_FACTORIES and DEFAULT_TOOLS |
| `src/components/chat/ChatMessage.tsx` | Render RunLogCard and RoutineProposalCard when fields present |
| `src/components/layout/AppLayout.tsx` | Route 'routines' screen to RoutinesScreen |
| `src/App.tsx` | Add RoutineProvider to provider hierarchy |
| `src/main.ts` | Initialize RoutineScheduler, register scheduler:sync IPC handler |
| `src/preload.ts` | Expose scheduler.sync() on CerebroAPI |

## Verification

### Phase 1 — Data Model + Backend API + Routines Screen:
1. Create a routine via `POST /routines` with name, steps, and trigger. Verify 201 response with all fields.
2. List routines via `GET /routines`. Verify the created routine appears.
3. Update routine trigger to `cron` via `PATCH /routines/{id}`. Verify updated response.
4. Toggle routine `is_enabled` from the RoutinesScreen card. Verify backend state updates.
5. Delete a routine. Verify it disappears from list.
6. Open the Routines screen. Verify it shows the routine list (not PlaceholderScreen).

### Phase 2 — RunLogCard + run_routine Tool:
7. Say "run my morning routine" in chat. Verify `run_routine` tool is called and a RunLogCard appears inline with live step progress.
8. Verify RunLogCard shows step status transitions: pending → running → completed.
9. Verify a RunRecord is created with `routine_id` set and `trigger: 'chat'`.

### Phase 3 — RoutineProposalCard + propose_routine Tool:
10. Say "I want a routine that prepares my day every morning." Verify Cerebro calls `propose_routine` and a RoutineProposalCard renders inline.
11. Click "Save Routine" on the proposal card. Verify the routine is created in the backend and appears in the Routines screen.
12. Verify the proposal card status updates to "saved."

### Phase 4 — Preview Execution:
13. Click "Preview" on a proposal card. Verify a RunLogCard appears with live execution logs.
14. Verify the RunRecord has `run_type: 'preview'`.
15. Verify the user can still click "Save Routine" after preview completes.

### Phase 5 — Cron Scheduler:
16. Create a routine with `trigger_type: 'cron'` and `cron_expression: '* * * * *'` (every minute). Verify the scheduler creates a cron job.
17. Wait for the cron to fire. Verify an engine run starts with `trigger: 'schedule'` and `routine_id` set.
18. Disable the routine. Call `scheduler.sync()`. Verify the cron job is removed.

### Phase 6 — Visual DAG Editor:
19. Open a routine's detail panel and click "Show Details." Verify the React Flow editor renders with the correct nodes and edges.
20. Add a new node to the graph. Verify the DAG JSON updates with the new step.
21. Connect two nodes. Verify `dependsOn` and `inputMappings` update correctly.
22. Save the edited DAG. Run the routine. Verify execution follows the modified graph.
