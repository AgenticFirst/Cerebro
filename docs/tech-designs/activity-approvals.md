# Activity + Approvals

## Problem Statement

Cerebro's Execution Engine can run multi-step DAGs — model calls, expert reasoning, data transforms — wired together with dependency graphs and error policies. It emits events, persists run records, and produces step-level outputs. But users cannot *see* any of this, and they cannot *intervene* in any of it.

There is no screen that shows what Cerebro has done. A routine that ran last Tuesday at 3am left behind run records and step records in SQLite, but the user has no surface to browse them, inspect what each step received and produced, or understand why a run failed. The Activity screen is a placeholder.

And there is no mechanism for human-in-the-loop control. The engine already supports `requiresApproval: true` on step definitions, and routines can declare `approval_gates` — but nothing happens when the executor encounters one. No pause, no notification, no approval UI. The Approvals screen is a placeholder. The `approval_requested`, `approval_granted`, and `approval_denied` event types are defined but never emitted.

This matters because the two most common failure modes of autonomous AI systems are (a) users don't know what happened, and (b) users can't stop what's about to happen. Activity gives visibility. Approvals give control. Together they close the loop between "AI does the work" and "human stays in charge."

**Scope:** This design covers the Activity screen (run history, drill-down, filters), the Approvals screen (pending list, approve/deny UI, history), the approval gate mechanism in the DAG executor (pause/resume/deny), the backend API additions, IPC wiring, and the sidebar badge. It builds entirely on the existing Execution Engine infrastructure — no new execution primitives, no changes to the action interface, no changes to the DAG compiler.

## Design Principles

1. **Reuse engine infrastructure.** The `run_records`, `step_records`, and `execution_events` tables already exist. The `ExecutionEvent` discriminated union already defines approval events. The `StepDefinition.requiresApproval` flag is already compiled from routine `approval_gates`. This design wires them together — it does not reinvent them.

2. **Approval is a DAG-level checkpoint, not a step-level interrupt.** When a step requires approval, the *entire run* pauses. No other steps execute until the approval is resolved. This keeps the model simple: a run is either running, paused, or done. Users review the run's current state, not a single step in isolation.

3. **One approval table, one source of truth.** A new `approval_requests` table records every approval request, its resolution, and who/when resolved it. StepRecords reference this via `approval_id`. Pending approvals are queryable with a single `WHERE resolved_at IS NULL`.

4. **IPC round-trip, not REST polling.** Approve/deny flows through IPC (renderer → main process → `DAGExecutor.resolveApproval()`), not REST. The main process holds the pending Promise — it must receive the resolution directly. The backend records the decision for persistence and auditability.

5. **Screens are read-heavy, write-light.** The Activity screen is pure read (list runs, drill into details). The Approvals screen is mostly read (list pending) with a single write action (approve or deny). Both query the backend REST API via the existing `window.cerebro.invoke()` bridge.

6. **Badge drives urgency.** The sidebar Approvals nav item shows a live count of pending approvals. Users see the count without navigating to the screen.

## Architecture Overview

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Renderer Process                         │
│                                                                 │
│  ┌────────────────┐  ┌──────────────────┐  ┌────────────────┐   │
│  │ ApprovalContext │  │  ActivityScreen  │  │ApprovalsScreen │   │
│  │  pendingCount   │  │  run timeline    │  │ pending list   │   │
│  │  approve/deny   │  │  filters/search  │  │ approve/deny   │   │
│  │  onEvent sub    │  │  drill-down      │  │ history        │   │
│  └───────┬────────┘  └────────┬─────────┘  └──────┬─────────┘   │
│          │                    │                    │             │
│          │  IPC invoke        │  REST via IPC      │  IPC        │
│          │  (approve/deny)    │  (GET /engine/*)   │  (approve)  │
│          ▼                    ▼                    ▼             │
│  Sidebar ──── badge count ◄── ApprovalContext                   │
└──────────┬───────────────────┬────────────────────┬─────────────┘
           │                   │                    │
           │ engine:approve    │ backend:request    │ engine:deny
           │ engine:deny       │                    │
           ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Main Process (Electron)                       │
│                                                                 │
│  ┌──────────────────────────────────────────────┐               │
│  │              ExecutionEngine                  │               │
│  │                                               │               │
│  │  pendingApprovals: Map<id, {resolve, stepId}> │               │
│  │                                               │               │
│  │  resolveApproval(id, approved, reason?)       │               │
│  │    → resolve Promise → executor continues     │               │
│  │    → persist decision to backend              │               │
│  │    → emit approval_granted / approval_denied  │               │
│  │                                               │               │
│  │  ┌─────────────────────────────┐              │               │
│  │  │       DAGExecutor           │              │               │
│  │  │                             │              │               │
│  │  │  executeStep() checks       │              │               │
│  │  │  requiresApproval           │              │               │
│  │  │  → waitForApproval()        │              │               │
│  │  │  → pauses entire run        │              │               │
│  │  │  → emits approval_requested │              │               │
│  │  └─────────────────────────────┘              │               │
│  └──────────────────────────────────────────────┘               │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP (REST)
┌──────────────────────────┴──────────────────────────────────────┐
│                   Python Backend (FastAPI)                       │
│                                                                 │
│  /engine/runs                   (existing — enhanced filters)   │
│  /engine/runs/{id}              (existing — includes steps)     │
│  /engine/runs/{id}/events       (existing — event replay)       │
│  /engine/runs/{id}/children     (existing — orchestration)      │
│  /engine/approvals              GET — list approval requests    │
│  /engine/approvals/{id}         GET — single approval detail    │
│  /engine/approvals/{id}/resolve PATCH — record decision         │
│                                                                 │
│  ┌─ SQLite ───────────────────────────────────────────────┐     │
│  │  run_records          (existing)                       │     │
│  │  step_records         (existing + approval columns)    │     │
│  │  execution_events     (existing)                       │     │
│  │  approval_requests    (NEW)                            │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow: Approval Request → Resolution

```
1. DAGExecutor.executeStep()
   │  step.requiresApproval === true
   │
   ▼
2. DAGExecutor.waitForApproval(step)
   │  generate approvalId
   │  emit approval_requested event → renderer
   │  persist ApprovalRequest to backend (status: pending)
   │  update RunRecord status → paused
   │  update StepRecord: approval_id, approval_status=pending
   │  return Promise (stored in engine.pendingApprovals)
   │
   ▼
3. Run is paused. No other steps execute.
   │  ApprovalContext receives event via engine:event:{runId}
   │  pendingCount increments → sidebar badge updates
   │
   ▼
4. User clicks Approve (or Deny) in ApprovalsScreen
   │  calls window.cerebro.engine.approve(approvalId)
   │  or   window.cerebro.engine.deny(approvalId, reason?)
   │
   ▼
5. IPC → main process → ExecutionEngine.resolveApproval()
   │  resolve stored Promise (true for approve, false for deny)
   │  emit approval_granted or approval_denied event
   │  persist decision to backend: resolved_at, decision, reason
   │  update StepRecord: approval_status → approved/denied
   │  update RunRecord status → running (or cancelled on deny)
   │
   ▼
6. DAGExecutor resumes (or throws StepDeniedError on deny)
   │  ApprovalContext decrements pendingCount → badge updates
```

## Data Models

### ApprovalRequest Table (New)

```python
# backend/models.py (addition)

class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="CASCADE"), index=True
    )
    step_id: Mapped[str] = mapped_column(String(32))
        # Matches StepDefinition.id from the DAG
    step_name: Mapped[str] = mapped_column(String(255))
    summary: Mapped[str] = mapped_column(Text)
        # Human-readable description: "Approve 'Send daily plan email'?"
    payload_json: Mapped[str | None] = mapped_column(Text, nullable=True)
        # Serialized step params for user review
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
        # "pending" | "approved" | "denied" | "expired"
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
        # Optional reason provided on deny
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
```

### StepRecord Additions

Two columns added to the existing `StepRecord` model:

```python
# backend/models.py (addition to StepRecord)

    approval_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("approval_requests.id", ondelete="SET NULL"), nullable=True
    )
    approval_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
        # "pending" | "approved" | "denied" | NULL (no approval needed)
```

### RunRecord Status Extension

The existing `status` field on `RunRecord` gains the `paused` value:

```
created → running → paused → running → completed
                  ↘                   ↗
                    → failed
                    → cancelled
```

No column change needed — `status` is already `String(20)`. The `paused` value is simply a new valid state alongside `created`, `running`, `completed`, `failed`, `cancelled`.

### Frontend Types

```typescript
// src/types/approvals.ts (new file)

export interface ApprovalRequest {
  id: string;
  runId: string;
  stepId: string;
  stepName: string;
  summary: string;
  payload?: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decisionReason?: string;
  requestedAt: string;   // ISO timestamp
  resolvedAt?: string;   // ISO timestamp
}

export interface RunSummary {
  id: string;
  routineId?: string;
  status: string;
  runType: string;
  trigger: string;
  totalSteps: number;
  completedSteps: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export interface StepSummary {
  id: string;
  stepId: string;
  stepName: string;
  actionType: string;
  status: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  approvalId?: string;
  approvalStatus?: string;
}
```

## Backend API

### Approval Endpoints

All approval endpoints live under `/engine/approvals` as a sub-router of the existing engine router.

```python
# backend/engine/router.py (additions)

# ── Approval CRUD ────────────────────────────────────────────────


@router.post("/approvals", response_model=ApprovalResponse, status_code=201)
def create_approval(body: ApprovalCreate, db=Depends(get_db)):
    """Create a new approval request (called by engine when step requires approval)."""
    approval = ApprovalRequest(
        id=body.id,
        run_id=body.run_id,
        step_id=body.step_id,
        step_name=body.step_name,
        summary=body.summary,
        payload_json=body.payload_json,
    )
    db.add(approval)
    db.commit()
    db.refresh(approval)
    return ApprovalResponse.model_validate(approval)


@router.get("/approvals", response_model=ApprovalListResponse)
def list_approvals(
    status: str | None = None,
    run_id: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    """List approval requests, optionally filtered by status or run_id."""
    q = db.query(ApprovalRequest)
    if status:
        q = q.filter(ApprovalRequest.status == status)
    if run_id:
        q = q.filter(ApprovalRequest.run_id == run_id)

    total = q.count()
    approvals = q.order_by(ApprovalRequest.requested_at.desc()).offset(offset).limit(limit).all()
    return ApprovalListResponse(
        approvals=[ApprovalResponse.model_validate(a) for a in approvals],
        total=total,
    )


@router.get("/approvals/pending/count")
def pending_approval_count(db=Depends(get_db)):
    """Fast count of pending approvals for sidebar badge."""
    count = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()
    return {"count": count}


@router.get("/approvals/{approval_id}", response_model=ApprovalResponse)
def get_approval(approval_id: str, db=Depends(get_db)):
    approval = db.get(ApprovalRequest, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    return ApprovalResponse.model_validate(approval)


@router.patch("/approvals/{approval_id}/resolve", response_model=ApprovalResponse)
def resolve_approval(approval_id: str, body: ApprovalResolve, db=Depends(get_db)):
    """Record the approval decision (called by main process after IPC resolution)."""
    approval = db.get(ApprovalRequest, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if approval.status != "pending":
        raise HTTPException(status_code=409, detail="Approval already resolved")

    approval.status = body.decision   # "approved" or "denied"
    approval.decision_reason = body.reason
    approval.resolved_at = _utcnow()

    # Also update the step record's approval_status (single transaction)
    step = (
        db.query(StepRecord)
        .filter(StepRecord.approval_id == approval_id)
        .first()
    )
    if step:
        step.approval_status = body.decision

    db.commit()
    db.refresh(approval)
    return ApprovalResponse.model_validate(approval)
```

### Approval Schemas

```python
# backend/engine/schemas.py (additions)

# ── Approval Request ─────────────────────────────────────────────


class ApprovalCreate(BaseModel):
    id: str
    run_id: str
    step_id: str
    step_name: str
    summary: str
    payload_json: str | None = None


class ApprovalResolve(BaseModel):
    decision: Literal["approved", "denied"]
    reason: str | None = None


class ApprovalResponse(BaseModel):
    id: str
    run_id: str
    step_id: str
    step_name: str
    summary: str
    payload_json: str | None
    status: str
    decision_reason: str | None
    requested_at: datetime
    resolved_at: datetime | None

    model_config = {"from_attributes": True}


class ApprovalListResponse(BaseModel):
    approvals: list[ApprovalResponse]
    total: int
```

### Enhanced Run Listing

The existing `GET /engine/runs` endpoint already supports `status`, `run_type`, `trigger`, `parent_run_id`, and `conversation_id` filters. No changes needed for Activity screen basic listing.

One addition: a `search` query parameter for filtering by routine name (joined from the `routines` table):

```python
# backend/engine/router.py (modification to list_runs)

@router.get("/runs", response_model=RunRecordListResponse)
def list_runs(
    routine_id: str | None = None,
    status: str | None = None,
    run_type: str | None = None,
    trigger: str | None = None,
    parent_run_id: str | None = None,
    conversation_id: str | None = None,
    has_approvals: bool | None = None,   # NEW — filter runs with pending approvals
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(RunRecord)
    # ... existing filters ...
    if has_approvals is not None:
        from models import ApprovalRequest
        if has_approvals:
            q = q.filter(
                RunRecord.id.in_(
                    db.query(ApprovalRequest.run_id)
                    .filter(ApprovalRequest.status == "pending")
                )
            )
    # ... rest unchanged ...
```

### Startup Recovery

When the app starts, any runs left in `paused` or `running` status from a previous session (process crash, force quit) are stale. The engine marks them as `failed` during initialization:

```python
# backend/engine/router.py (addition)

@router.post("/runs/recover-stale", status_code=200)
def recover_stale_runs(db=Depends(get_db)):
    """Mark stale paused/running runs as failed on app startup."""
    stale = (
        db.query(RunRecord)
        .filter(RunRecord.status.in_(["running", "paused"]))
        .all()
    )
    count = 0
    for run in stale:
        run.status = "failed"
        run.error = "App terminated while run was in progress"
        run.completed_at = _utcnow()
        count += 1

    # Also expire any pending approvals
    pending = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").all()
    for approval in pending:
        approval.status = "expired"
        approval.resolved_at = _utcnow()

    db.commit()
    return {"recovered_runs": count, "expired_approvals": len(pending)}
```

Called once from `src/main.ts` after the backend becomes healthy, before `ExecutionEngine` is instantiated.

## Engine Approval Gates

### waitForApproval() in DAGExecutor

The executor checks `step.requiresApproval` before running a step. If true, it delegates to a callback on the `ExecutorContext` that returns a Promise — the engine holds this Promise until the user decides.

```typescript
// src/engine/dag/executor.ts (modifications)

export interface ExecutorContext {
  runId: string;
  backendPort: number;
  signal: AbortSignal;
  resolveModel: () => Promise<ResolvedModel | null>;
  onStepUpdate?: (stepId: string, update: StepPersistenceUpdate) => void;
  // NEW — approval gate
  onApprovalRequired?: (step: StepDefinition) => Promise<boolean>;
}

// In executeStep(), before runStepOnce():

private async executeStep(step: StepDefinition): Promise<void> {
  // ── Approval gate ──────────────────────────────────────────
  if (step.requiresApproval && this.ctx.onApprovalRequired) {
    const approved = await this.ctx.onApprovalRequired(step);
    if (!approved) {
      // User denied — mark step as failed with denial
      this.stepStates.set(step.id, { status: 'failed', error: 'Approval denied' });
      this.emitter.emit({
        type: 'step_failed',
        runId: this.ctx.runId,
        stepId: step.id,
        error: 'Approval denied by user',
        timestamp: new Date().toISOString(),
      });
      this.ctx.onStepUpdate?.(step.id, {
        status: 'failed',
        error: 'Approval denied by user',
        completed_at: new Date().toISOString(),
      });
      throw new StepDeniedError(step.id);
    }
  }

  // ── Existing retry/execute logic (unchanged) ───────────────
  const maxAttempts = step.onError === 'retry' ? (step.maxRetries ?? 1) + 1 : 1;
  // ...
}
```

A new `StepDeniedError` (extends `StepFailedError`) signals that a denial caused the abort, so the engine can set the run status to `cancelled` rather than `failed`:

```typescript
// src/engine/dag/executor.ts (addition)

export class StepDeniedError extends StepFailedError {
  constructor(stepId: string) {
    super(stepId, 'Approval denied by user');
    this.name = 'StepDeniedError';
  }
}
```

### Wave-Level Blocking

The current executor processes steps in parallel waves using Kahn's algorithm. When a step in a wave requires approval, the entire wave (and all subsequent waves) blocks until the approval is resolved. This happens naturally because `waitForApproval` returns a Promise that doesn't resolve until the user decides — `Promise.allSettled` on the wave waits for all steps including the paused one.

In practice, only one step per wave should require approval. If multiple steps in the same wave require approval (unusual but valid), they all pause simultaneously and the user resolves each one. The wave continues only when all are resolved.

### resolveApproval() on ExecutionEngine

The engine holds a map of pending approval Promises and resolves them when the user decides:

```typescript
// src/engine/engine.ts (additions)

interface PendingApproval {
  resolve: (approved: boolean) => void;
  stepId: string;
  runId: string;
}

export class ExecutionEngine {
  // ... existing fields ...
  private pendingApprovals = new Map<string, PendingApproval>();

  async startRun(webContents: WebContents, request: EngineRunRequest): Promise<string> {
    // ... existing setup ...

    // Approval gate callback
    const onApprovalRequired = async (step: StepDefinition): Promise<boolean> => {
      const approvalId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

      // Persist approval request to backend
      this.backendRequest('POST', '/engine/approvals', {
        id: approvalId,
        run_id: runId,
        step_id: step.id,
        step_name: step.name,
        summary: `Approve "${step.name}"?`,
        payload_json: JSON.stringify(step.params),
      }).catch(console.error);

      // Update step record with approval info
      const stepRecordId = stepRecordIdMap.get(step.id);
      if (stepRecordId) {
        this.backendRequest('PATCH', `/engine/runs/${runId}/steps/${stepRecordId}`, {
          approval_id: approvalId,
          approval_status: 'pending',
        }).catch(console.error);
      }

      // Update run status to paused
      this.backendRequest('PATCH', `/engine/runs/${runId}`, {
        status: 'paused',
      }).catch(console.error);

      // Emit approval_requested event to renderer
      emitter.emit({
        type: 'approval_requested',
        runId,
        stepId: step.id,
        approvalId,
        summary: `Approve "${step.name}"?`,
        payload: step.params,
        timestamp: new Date().toISOString(),
      });

      // Wait for user decision
      return new Promise<boolean>((resolve) => {
        this.pendingApprovals.set(approvalId, { resolve, stepId: step.id, runId });
      });
    };

    // Create executor with approval callback
    const executor = new DAGExecutor(
      request.dag,
      registry,
      scratchpad,
      emitter,
      {
        runId,
        backendPort: this.backendPort,
        signal: abortController.signal,
        resolveModel: () => resolveModel(null, this.backendPort),
        onStepUpdate,
        onApprovalRequired,   // NEW
      },
    );

    // ... rest of execution unchanged, except catch block ...
  }

  /**
   * Resolve a pending approval. Called by IPC handler.
   * Returns false if the approvalId was not found (already resolved or expired).
   */
  resolveApproval(
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;

    this.pendingApprovals.delete(approvalId);

    // Persist decision to backend
    this.backendRequest('PATCH', `/engine/approvals/${approvalId}/resolve`, {
      decision: approved ? 'approved' : 'denied',
      reason: reason ?? null,
    }).catch(console.error);

    // Update run status back to running (or cancelled)
    this.backendRequest('PATCH', `/engine/runs/${pending.runId}`, {
      status: approved ? 'running' : 'cancelled',
    }).catch(console.error);

    // Emit event
    const emitter = this.getEmitterForRun(pending.runId);
    if (emitter) {
      if (approved) {
        emitter.emit({
          type: 'approval_granted',
          runId: pending.runId,
          stepId: pending.stepId,
          approvalId,
          timestamp: new Date().toISOString(),
        });
      } else {
        emitter.emit({
          type: 'approval_denied',
          runId: pending.runId,
          stepId: pending.stepId,
          approvalId,
          reason,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Resolve the Promise — executor resumes or throws StepDeniedError
    pending.resolve(approved);
    return true;
  }

  /** Cancel a running or paused DAG execution. */
  cancelRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;

    // Also deny any pending approvals for this run
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.runId === runId) {
        this.pendingApprovals.delete(approvalId);
        pending.resolve(false);
        this.backendRequest('PATCH', `/engine/approvals/${approvalId}/resolve`, {
          decision: 'denied',
          reason: 'Run was cancelled',
        }).catch(console.error);
      }
    }

    run.abortController.abort();
    this.activeRuns.delete(runId);
    return true;
  }

  // ... existing methods ...
}
```

The engine needs to expose the `RunEventEmitter` per active run so `resolveApproval` can emit events. Currently, the emitter is a local variable inside `startRun()` — promote it to a field on `ActiveEngineRun`:

```typescript
// src/engine/engine.ts (modification to ActiveEngineRun)

interface ActiveEngineRun {
  runId: string;
  abortController: AbortController;
  startedAt: number;
  routineId?: string;
  emitter: RunEventEmitter;   // NEW — was a local variable in startRun(), promoted for approval event emission
}

private getEmitterForRun(runId: string): RunEventEmitter | null {
  return this.activeRuns.get(runId)?.emitter ?? null;
}
```

### Run Status Transitions

```
                                ┌──────────┐
                       created  │          │
                    ┌───────────► running  ◄───────────┐
                    │           │          │            │
                    │           └────┬─────┘            │
                    │                │                  │
                    │         requiresApproval          │ approved
                    │                │                  │
                    │           ┌────▼─────┐            │
                    │           │          │            │
                    │           │  paused  ├────────────┘
                    │           │          │
                    │           └────┬─────┘
                    │                │ denied
                    │                ▼
              ┌─────┴─────┐   ┌──────────┐    ┌───────────┐
              │ completed │   │cancelled │    │  failed   │
              └───────────┘   └──────────┘    └───────────┘
```

## IPC Changes

### New IPC Channels

```typescript
// src/types/ipc.ts (additions to IPC_CHANNELS)

  // Approval gates
  ENGINE_APPROVE: 'engine:approve',
  ENGINE_DENY: 'engine:deny',
```

### EngineAPI Additions

```typescript
// src/types/ipc.ts (additions to EngineAPI)

export interface EngineAPI {
  run(request: EngineRunRequest): Promise<string>;
  cancel(runId: string): Promise<boolean>;
  activeRuns(): Promise<EngineActiveRunInfo[]>;
  getEvents(runId: string): Promise<ExecutionEvent[]>;
  onEvent(runId: string, callback: (event: ExecutionEvent) => void): () => void;
  // NEW — approval gates
  approve(approvalId: string): Promise<boolean>;
  deny(approvalId: string, reason?: string): Promise<boolean>;
  // NEW — wildcard event subscription (for ApprovalContext badge)
  onAnyEvent(callback: (event: ExecutionEvent) => void): () => void;
}
```

### IPC Handlers (main.ts)

```typescript
// src/main.ts (additions to registerIpcHandlers)

  // --- Approval Gates ---

  ipcMain.handle(IPC_CHANNELS.ENGINE_APPROVE, async (_event, approvalId: string) => {
    if (!executionEngine) return false;
    return executionEngine.resolveApproval(approvalId, true);
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_DENY, async (_event, approvalId: string, reason?: string) => {
    if (!executionEngine) return false;
    return executionEngine.resolveApproval(approvalId, false, reason);
  });
```

### Preload Bridge

```typescript
// src/preload.ts (additions to engine object)

  engine: {
    // ... existing methods ...
    approve: (approvalId: string) =>
      ipcRenderer.invoke('engine:approve', approvalId),
    deny: (approvalId: string, reason?: string) =>
      ipcRenderer.invoke('engine:deny', approvalId, reason),
  },
```

### Startup Recovery Call

```typescript
// src/main.ts (addition, after backend becomes healthy, before engine init)

async function initializeEngineInfra(): Promise<void> {
  // Recover any stale runs from previous session
  await makeBackendRequest({
    method: 'POST',
    path: '/engine/runs/recover-stale',
  });

  // ... existing engine/scheduler initialization ...
}
```

## Frontend: ApprovalContext

A new React context provides live approval state to any component (sidebar badge, approvals screen, inline notifications).

```typescript
// src/context/ApprovalContext.tsx

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { ApprovalRequest } from '../types/approvals';
import type { ExecutionEvent } from '../engine/events/types';

interface ApprovalContextValue {
  /** Number of pending approvals (for sidebar badge). */
  pendingCount: number;
  /** Full list of pending approvals. */
  pendingApprovals: ApprovalRequest[];
  /** Refresh pending approvals from backend. */
  refresh: () => Promise<void>;
  /** Approve a pending request. */
  approve: (approvalId: string) => Promise<boolean>;
  /** Deny a pending request with optional reason. */
  deny: (approvalId: string, reason?: string) => Promise<boolean>;
}

const ApprovalContext = createContext<ApprovalContextValue | null>(null);

export function useApprovals(): ApprovalContextValue {
  const ctx = useContext(ApprovalContext);
  if (!ctx) throw new Error('useApprovals must be used within ApprovalProvider');
  return ctx;
}

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);

  const refresh = useCallback(async () => {
    const res = await window.cerebro.invoke<{ approvals: ApprovalRequest[]; total: number }>({
      method: 'GET',
      path: '/engine/approvals?status=pending&limit=100',
    });
    if (res.ok) {
      setPendingApprovals(res.data.approvals);
    }
  }, []);

  const approve = useCallback(async (approvalId: string) => {
    const result = await window.cerebro.engine.approve(approvalId);
    if (result) await refresh();
    return result;
  }, [refresh]);

  const deny = useCallback(async (approvalId: string, reason?: string) => {
    const result = await window.cerebro.engine.deny(approvalId, reason);
    if (result) await refresh();
    return result;
  }, [refresh]);

  // Initial fetch on mount
  useEffect(() => { refresh(); }, [refresh]);

  // Listen for approval events on any active engine run to trigger refresh.
  // The engine emits approval_requested when a new gate is hit and
  // approval_granted/denied when resolved. Both change pendingCount.
  useEffect(() => {
    const handler = (_event: unknown, engineEvent: ExecutionEvent) => {
      if (
        engineEvent.type === 'approval_requested' ||
        engineEvent.type === 'approval_granted' ||
        engineEvent.type === 'approval_denied'
      ) {
        refresh();
      }
    };

    // Subscribe to a wildcard engine event channel
    // (Implementation note: this requires a small addition to preload —
    //  an onAnyEngineEvent listener that forwards all engine events
    //  regardless of runId. See IPC Changes section.)
    const unsub = window.cerebro.engine.onAnyEvent?.(handler) ?? (() => {});
    return unsub;
  }, [refresh]);

  return (
    <ApprovalContext.Provider
      value={{
        pendingCount: pendingApprovals.length,
        pendingApprovals,
        refresh,
        approve,
        deny,
      }}
    >
      {children}
    </ApprovalContext.Provider>
  );
}
```

### Wildcard Engine Event Subscription

The current `engine.onEvent(runId, callback)` requires knowing the `runId` upfront. The ApprovalContext needs to listen for approval events from *any* run. A new `onAnyEvent` method broadcasts all engine events:

```typescript
// src/types/ipc.ts (addition to EngineAPI)

  onAnyEvent(callback: (event: ExecutionEvent) => void): () => void;

// src/types/ipc.ts (addition to IPC_CHANNELS)

  ENGINE_ANY_EVENT: 'engine:any-event',
```

In the main process, every `RunEventEmitter.emit()` also forwards to the `ENGINE_ANY_EVENT` channel:

```typescript
// src/engine/events/emitter.ts (modification)

emit(event: ExecutionEvent): void {
  // ... existing per-run channel emit ...
  // Also broadcast to wildcard channel for approval context
  if (!this.webContents.isDestroyed()) {
    this.webContents.send('engine:any-event', event);
  }
}
```

In the preload:

```typescript
// src/preload.ts (addition to engine)

  onAnyEvent: (callback: (event: ExecutionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, engineEvent: ExecutionEvent) =>
      callback(engineEvent);
    ipcRenderer.on('engine:any-event', handler);
    return () => ipcRenderer.removeListener('engine:any-event', handler);
  },
```

### Provider Placement in App.tsx

```typescript
// src/App.tsx (addition)
// ApprovalProvider wraps after RoutineProvider, before ChatProvider:

<ProviderProvider>
  <ModelProvider>
    <MemoryProvider>
      <ExpertProvider>
        <RoutineProvider>
          <ApprovalProvider>       {/* NEW */}
            <ChatProvider>
              <AppLayout />
            </ChatProvider>
          </ApprovalProvider>
        </RoutineProvider>
      </ExpertProvider>
    </MemoryProvider>
  </ModelProvider>
</ProviderProvider>
```

## Frontend: ActivityScreen

The Activity screen replaces the current `PlaceholderScreen` for the `activity` route. It shows a timeline of all runs with filters, and supports drilling into individual run details.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Activity                                    [Filter chips]  │
│  ─────────────────────────────────────────────────────────── │
│                                                              │
│  ┌─ Run Timeline ──────────────────────────────────────────┐ │
│  │                                                         │ │
│  │  ● Morning Prep Routine          completed   2m 14s     │ │
│  │    Today, 9:00 AM · 4/4 steps · manual                  │ │
│  │                                                         │ │
│  │  ● Research Pipeline             failed      1m 02s     │ │
│  │    Today, 8:30 AM · 2/5 steps · scheduled               │ │
│  │                                                         │ │
│  │  ● Email Draft Routine           paused      —          │ │
│  │    Yesterday, 4:15 PM · 3/6 steps · chat                │ │
│  │    ⚡ Awaiting approval: "Send follow-up email"         │ │
│  │                                                         │ │
│  │  ● Weekly Summary                completed   5m 33s     │ │
│  │    Mar 1, 2:00 PM · 3/3 steps · cron                    │ │
│  │                                                         │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ─── Load more ───                                           │
└──────────────────────────────────────────────────────────────┘
```

### Filter Chips

Horizontal row of toggle chips:

| Filter    | Values                                               | Default |
|-----------|------------------------------------------------------|---------|
| Status    | All, Running, Paused, Completed, Failed, Cancelled   | All     |
| Type      | All, Routine, Preview, Ad-Hoc, Orchestration         | All     |
| Trigger   | All, Manual, Scheduled, Chat, Webhook                | All     |

Filters map directly to the existing `GET /engine/runs` query parameters.

### Run Detail Panel

Clicking a run in the timeline opens a slide-over detail panel (right side, similar to expert detail in ExpertsScreen):

```
┌─────────────────────────────────────────────┐
│  ← Back                                     │
│                                              │
│  Morning Prep Routine                        │
│  completed · 2m 14s · manual                 │
│  Started: Today, 9:00:12 AM                  │
│  Finished: Today, 9:02:26 AM                 │
│                                              │
│  ── Steps ─────────────────────────────────  │
│                                              │
│  1. ✅ Pull calendar events          12s     │
│     "Found 4 events for today"               │
│                                              │
│  2. ✅ Check todo backlog            8s      │
│     "12 items, 3 high priority"              │
│                                              │
│  3. ✅ Generate daily plan           1m 40s  │
│     "Drafted plan with 6 blocks"             │
│                                              │
│  4. ✅ Send plan to Slack            14s     │
│     "Posted to #daily-plans"                 │
│                                              │
│  ── Events ────────────────────────────────  │
│                                              │
│  09:00:12  run_started (4 steps)             │
│  09:00:12  step_started: Pull calendar       │
│  09:00:24  step_completed: Pull calendar     │
│  09:00:24  step_started: Check todo          │
│  ...                                         │
│                                              │
│  ── Child Runs ────────────────────────────  │
│  (for orchestration runs with parent_run_id) │
│                                              │
│  └ Expert delegation: Research Agent  ✅     │
│  └ Expert delegation: Writer Agent    ✅     │
└─────────────────────────────────────────────┘
```

### Implementation

```typescript
// src/components/screens/ActivityScreen.tsx

import { useState, useEffect, useCallback } from 'react';
import type { RunSummary, StepSummary } from '../../types/approvals';

interface Filters {
  status: string | null;
  runType: string | null;
  trigger: string | null;
}

export default function ActivityScreen() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<Filters>({ status: null, runType: null, trigger: null });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  const fetchRuns = useCallback(async () => {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.runType) params.set('run_type', filters.runType);
    if (filters.trigger) params.set('trigger', filters.trigger);
    params.set('offset', String(offset));
    params.set('limit', '50');

    const res = await window.cerebro.invoke<{ runs: RunSummary[]; total: number }>({
      method: 'GET',
      path: `/engine/runs?${params}`,
    });
    if (res.ok) {
      setRuns((prev) => (offset === 0 ? res.data.runs : [...prev, ...res.data.runs]));
      setTotal(res.data.total);
    }
  }, [filters, offset]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // ... render: filter chips, run list, detail panel ...
}
```

The `RunDetailPanel` sub-component fetches `GET /engine/runs/{id}` (which includes steps) and `GET /engine/runs/{id}/events` for the event log. For orchestration runs, it also fetches `GET /engine/runs/{id}/children`.

## Frontend: ApprovalsScreen

The Approvals screen replaces the current `PlaceholderScreen` for the `approvals` route. It has two tabs: **Pending** (actionable) and **History** (resolved).

### Layout: Pending Tab

```
┌──────────────────────────────────────────────────────────────┐
│  Approvals                          [Pending]  [History]     │
│  ─────────────────────────────────────────────────────────── │
│                                                              │
│  ┌─ Pending Approvals ─────────────────────────────────────┐ │
│  │                                                         │ │
│  │  ┌────────────────────────────────────────────────────┐  │ │
│  │  │  ⚡ Send follow-up email                          │  │ │
│  │  │  Email Draft Routine · Step 5 of 6                │  │ │
│  │  │  Requested 3 minutes ago                          │  │ │
│  │  │                                                   │  │ │
│  │  │  Parameters:                                      │  │ │
│  │  │    to: "team@example.com"                         │  │ │
│  │  │    subject: "Meeting follow-up"                   │  │ │
│  │  │    body: "Hi team, ..."                           │  │ │
│  │  │                                                   │  │ │
│  │  │  [Deny]                              [Approve ✓]  │  │ │
│  │  └────────────────────────────────────────────────────┘  │ │
│  │                                                         │ │
│  │  ┌────────────────────────────────────────────────────┐  │ │
│  │  │  ⚡ Update calendar event                         │  │ │
│  │  │  Morning Prep · Step 4 of 4                       │  │ │
│  │  │  Requested 12 minutes ago                         │  │ │
│  │  │                                                   │  │ │
│  │  │  [Deny]                              [Approve ✓]  │  │ │
│  │  └────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Deny Flow

Clicking "Deny" opens a small inline form with an optional reason text input and a confirm button. This mirrors the pattern used in other parts of Cerebro (e.g., conversation delete is inline, not a modal).

### Layout: History Tab

A chronological list of resolved approvals showing the decision, reason, and timestamps. Uses the same card layout but without action buttons, and with a status badge (Approved/Denied/Expired) replacing them.

### Implementation

```typescript
// src/components/screens/ApprovalsScreen.tsx

import { useState, useEffect, useCallback } from 'react';
import { useApprovals } from '../../context/ApprovalContext';
import type { ApprovalRequest } from '../../types/approvals';

type Tab = 'pending' | 'history';

export default function ApprovalsScreen() {
  const { pendingApprovals, approve, deny } = useApprovals();
  const [activeTab, setActiveTab] = useState<Tab>('pending');
  const [history, setHistory] = useState<ApprovalRequest[]>([]);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState('');

  const handleApprove = async (id: string) => {
    await approve(id);
  };

  const handleDeny = async (id: string) => {
    await deny(id, denyReason || undefined);
    setDenyingId(null);
    setDenyReason('');
  };

  // Fetch resolved approvals when History tab is selected (local to this screen,
  // not in ApprovalContext — only the pending list needs to be globally available)
  const fetchHistory = useCallback(async () => {
    const res = await window.cerebro.invoke<{ approvals: ApprovalRequest[]; total: number }>({
      method: 'GET',
      path: '/engine/approvals?limit=100',  // all statuses — backend returns desc by requested_at
    });
    if (res.ok) {
      setHistory(res.data.approvals.filter((a) => a.status !== 'pending'));
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
  }, [activeTab, fetchHistory]);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Tab bar */}
      {/* Pending or History list */}
      {/* ApprovalCard components */}
    </div>
  );
}
```

## Frontend: Sidebar Badge

The Approvals nav item in the sidebar shows a dynamic badge with the count of pending approvals. The badge is already supported by the `NavItem.badge` property — it just needs to be wired to `ApprovalContext.pendingCount`.

### Wiring

The `Sidebar` component currently defines `NAV_OVERSIGHT` as a static array. To inject the badge count, the array is computed dynamically:

```typescript
// src/components/layout/Sidebar.tsx (modification)

import { useApprovals } from '../../context/ApprovalContext';

// Inside Sidebar component:
const { pendingCount } = useApprovals();

const navOversight = useMemo<NavItem[]>(() => [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck, badge: pendingCount },
], [pendingCount]);

// Replace NAV_OVERSIGHT usage with navOversight
```

The badge renders as a small pill with the count (e.g., "2") in the accent color, using the existing badge styles: `ml-auto text-[10px] font-semibold bg-accent/15 text-accent px-1.5 py-0.5 rounded-full tabular-nums`.

When `pendingCount` is 0, no badge is rendered (the existing `item.badge != null && item.badge > 0` guard handles this).

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Separate `approval_requests` table vs. inline on `step_records` | Separate table | Approvals have their own lifecycle (pending → resolved), their own query patterns (list all pending across runs), and may eventually have metadata (resolved_by, policy reference). Inlining on steps would require scanning all step records to find pending approvals. |
| Run pauses entirely on approval vs. only the approving step blocks | Entire run pauses | Approval gates are checkpoints. If step 3 of 5 needs approval, the user should see the complete state before deciding. Running steps 4-5 while 3 is paused creates confusing partial state. The execution-engine tech design explicitly chose this behavior. |
| IPC for approve/deny vs. REST API | IPC → main process | The pending Promise lives in the main process (`ExecutionEngine.pendingApprovals` map). Only the main process can resolve it. REST could be layered on top for external integrations (mobile app, web dashboard), but for V0, IPC is the only path. |
| Deny cancels the run vs. skip the step | Deny cancels the run | Denying a step means the user does not want this action to proceed. Since downstream steps likely depend on it, the safest default is to cancel. A future enhancement could add a "skip" option for non-critical gates. |
| Startup recovery marks stale runs as failed | Yes | If the app crashes while a run is paused, the approval Promise is lost. The run cannot resume. Marking it `failed` with a clear error message is honest and prevents ghost runs from cluttering the Activity screen. Pending approvals are expired. |
| Activity screen uses REST polling vs. real-time updates | REST polling on mount + manual refresh | Runs are relatively infrequent (not thousands per second). The activity timeline is a historical view. Real-time updates for active runs are handled by the existing `engine:event` IPC subscription in the run detail panel. |
| Wildcard engine event channel for ApprovalContext | Yes, `engine:any-event` | The context needs to know when *any* run hits an approval gate, not just a specific run. Without this, it would need to subscribe to every active runId individually (race-prone). A single wildcard channel is simpler and mirrors the `agent:event` pattern. |

## Implementation Phases

### Phase 1: Data Model + Backend API

**Roadmap task:** Approval gates in execution engine (data layer).

- Add `ApprovalRequest` model to `backend/models.py`
- Add `approval_id` and `approval_status` columns to `StepRecord`
- Add approval schemas to `backend/engine/schemas.py`
- Add approval CRUD endpoints to `backend/engine/router.py`
- Add `POST /engine/runs/recover-stale` endpoint
- Add `has_approvals` filter to `GET /engine/runs`
- Import new model in `backend/main.py` for `create_all()`

**Deliverable:** Backend API ready for approval persistence and querying.

### Phase 2: Engine Approval Gates

**Roadmap task:** Approval gates in execution engine (execution layer).

- Add `onApprovalRequired` callback to `ExecutorContext` in `src/engine/dag/executor.ts`
- Add approval gate check in `executeStep()` before `runStepOnce()`
- Add `StepDeniedError` class
- Add `pendingApprovals` map and `resolveApproval()` method to `src/engine/engine.ts`
- Wire `onApprovalRequired` callback in `startRun()` to create approval requests, emit events, and return Promise
- Update `cancelRun()` to deny pending approvals
- Store emitter on `ActiveEngineRun` for event emission during resolution

**Deliverable:** Routines with `approval_gates` pause when reaching flagged steps and resume/cancel on user decision (via direct `resolveApproval()` call).

### Phase 3: IPC + Preload Wiring

**Roadmap task:** Approve/deny flow with run continuation or stop.

- Add `ENGINE_APPROVE`, `ENGINE_DENY`, `ENGINE_ANY_EVENT` to `IPC_CHANNELS` in `src/types/ipc.ts`
- Add `approve()`, `deny()`, `onAnyEvent()` to `EngineAPI` interface
- Add IPC handlers in `src/main.ts` for approve/deny channels
- Add preload bridge methods in `src/preload.ts`
- Add wildcard event broadcasting in `RunEventEmitter.emit()`
- Add startup recovery call in `src/main.ts` initialization sequence
- Add `src/types/approvals.ts` with frontend type definitions

**Deliverable:** Full round-trip: renderer calls `window.cerebro.engine.approve(id)` → main process resolves Promise → executor resumes → events flow back to renderer.

### Phase 4: ApprovalContext + Sidebar Badge

**Roadmap task:** Approval badge in nav (visible only when pending).

- Create `src/context/ApprovalContext.tsx`
- Add `ApprovalProvider` to `App.tsx` provider stack
- Modify `Sidebar.tsx` to consume `useApprovals()` and inject `pendingCount` badge on Approvals nav item
- Wire wildcard engine event listener for live badge updates

**Deliverable:** Sidebar shows live pending approval count. Badge appears/disappears as approvals are created/resolved.

### Phase 5: ApprovalsScreen

**Roadmap task:** Approvals screen (pending items, approve/deny).

- Create `src/components/screens/ApprovalsScreen.tsx` with Pending/History tabs
- Create `ApprovalCard` sub-component with approve/deny buttons
- Add inline deny reason form
- Fetch history from `GET /engine/approvals`
- Wire approve/deny actions to `ApprovalContext`
- Update `AppLayout.tsx` to route `approvals` screen to `ApprovalsScreen`

**Deliverable:** Fully functional Approvals screen with pending list, approve/deny flow, and history view.

### Phase 6: ActivityScreen

**Roadmap task:** Activity screen (run timeline with filters) + Run drill-down view.

- Create `src/components/screens/ActivityScreen.tsx` with filter chips and run list
- Create `RunDetailPanel` sub-component with step timeline, event log, and child run navigation
- Fetch runs from `GET /engine/runs` with filter query parameters
- Fetch run details from `GET /engine/runs/{id}` (includes steps)
- Fetch events from `GET /engine/runs/{id}/events`
- Fetch child runs from `GET /engine/runs/{id}/children`
- Handle "load more" pagination
- Update `AppLayout.tsx` to route `activity` screen to `ActivityScreen`
- Highlight paused runs with approval indicator linking to ApprovalsScreen

**Deliverable:** Fully functional Activity screen with run history, filters, and drill-down view.

## Files Created / Modified

### New Files

| File | Purpose |
|------|---------|
| `src/types/approvals.ts` | Frontend types for approvals, run summaries, step summaries |
| `src/context/ApprovalContext.tsx` | React context: pending count, approve/deny, event subscription |
| `src/components/screens/ActivityScreen.tsx` | Run timeline with filters and drill-down |
| `src/components/screens/ApprovalsScreen.tsx` | Pending approvals list with approve/deny, history tab |

### Modified Files

| File | Changes |
|------|---------|
| `backend/models.py` | Add `ApprovalRequest` model; add `approval_id`, `approval_status` columns to `StepRecord` |
| `backend/engine/schemas.py` | Add `ApprovalCreate`, `ApprovalResolve`, `ApprovalResponse`, `ApprovalListResponse`; add approval fields to `StepRecordCreate`/`Update`/`Response` |
| `backend/engine/router.py` | Add approval CRUD endpoints, `recover-stale` endpoint, `has_approvals` filter |
| `backend/main.py` | Import `ApprovalRequest` for `create_all()` |
| `src/engine/engine.ts` | Add `pendingApprovals` map, `resolveApproval()` method, approval callback in `startRun()`, emitter on `ActiveEngineRun`, update `cancelRun()` |
| `src/engine/dag/executor.ts` | Add `onApprovalRequired` to `ExecutorContext`, approval gate check in `executeStep()`, `StepDeniedError` class |
| `src/engine/events/emitter.ts` | Broadcast to `engine:any-event` channel on every emit |
| `src/types/ipc.ts` | Add `ENGINE_APPROVE`, `ENGINE_DENY`, `ENGINE_ANY_EVENT` channels; add `approve()`, `deny()`, `onAnyEvent()` to `EngineAPI` |
| `src/main.ts` | Add IPC handlers for approve/deny; add startup recovery call |
| `src/preload.ts` | Add `approve()`, `deny()`, `onAnyEvent()` to engine bridge |
| `src/components/layout/Sidebar.tsx` | Consume `useApprovals()` for dynamic badge on Approvals nav item |
| `src/components/layout/AppLayout.tsx` | Route `activity` to `ActivityScreen`, `approvals` to `ApprovalsScreen` |
| `src/App.tsx` | Add `ApprovalProvider` to provider stack |

## Verification

1. **Approval gate pauses run:** Create a routine with `approval_gates: ["Step 3"]`. Run it. Verify the run status transitions to `paused` when Step 3 is reached. Verify no subsequent steps execute.

2. **Approve resumes run:** While paused, click Approve in the Approvals screen. Verify the run resumes, Step 3 executes, and subsequent steps follow. Verify run completes normally.

3. **Deny cancels run:** While paused, click Deny with a reason. Verify the run transitions to `cancelled`. Verify the reason is persisted in the `approval_requests` table. Verify subsequent steps do not execute.

4. **Sidebar badge updates:** Trigger an approval gate. Verify the Approvals nav item shows a badge with "1". Approve it. Verify the badge disappears. Trigger two approval gates (different runs). Verify badge shows "2".

5. **Startup recovery:** Start a run, pause it at an approval gate, force-quit the app. Relaunch. Verify the run is marked `failed` with "App terminated while run was in progress". Verify the pending approval is marked `expired`.

6. **Cancel with pending approval:** Start a run that hits an approval gate. Cancel the run (via engine cancel, not deny). Verify the approval is marked `denied` with reason "Run was cancelled". Verify run status is `cancelled`.

7. **Activity screen filters:** Create runs of different types and statuses. Verify each filter chip correctly narrows the run list. Verify "Load more" pagination works.

8. **Activity drill-down:** Click a completed run. Verify the detail panel shows all steps with summaries, durations, and status indicators. Verify the event log shows chronological events. For an orchestration run, verify child runs are listed and navigable.

9. **Approvals history:** Approve and deny several requests. Switch to the History tab. Verify all resolved approvals appear with correct status, reason, and timestamps.

10. **Concurrent approval gates:** Create a DAG where two steps in the same wave both require approval. Verify both approval requests appear. Approve both. Verify the wave completes and subsequent waves run.

11. **Approval events persisted:** After approving a step, check `GET /engine/runs/{id}/events`. Verify `approval_requested` and `approval_granted` events are in the event log with correct timestamps and approvalId references.

12. **No approval needed:** Run a routine with no `approval_gates`. Verify it completes without pausing. Verify no `approval_requests` records are created. Verify the Approvals badge does not change.
