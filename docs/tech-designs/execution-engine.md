# Execution Engine

## Problem Statement

AI assistants today stop at advice. You ask "prepare my day" and get a bulleted list of suggestions. You still have to open your calendar, check your todos, draft the plan yourself, and copy-paste it into the right place. The assistant answered your question, but it didn't *do the work*.

Real tasks are not single-turn conversations — they are **multi-step pipelines** that span tools. "Every weekday at 9am, pull my calendar, check my todo backlog, and draft a plan for the day" requires fetching data from two sources, merging and prioritizing it, generating a draft, and presenting it for review. "After each meeting, summarize notes, extract action items, and draft follow-ups" is a directed graph with parallel branches and an approval gate before anything gets sent. No mainstream assistant can express, execute, or observe workflows like these.

And when AI systems *do* attempt to act, they offer no visibility or control. There are no step-level logs showing what happened and why, no approval gates for sensitive actions like sending an email or editing a calendar event, no structured record of what each step received and produced, and no way to pause, resume, or retry a failed workflow. Users are asked to trust a black box — or not use it at all.

Cerebro's Execution Engine solves this by providing a local runtime where typed **Actions** (model calls, data transformers, expert reasoning, connectors, channels) compose into directed acyclic graphs that execute with real-time event streaming, human-in-the-loop approval gates, and persistent Run Records. It is the layer between *intent* ("prepare my day") and *outcome* (a drafted plan, reviewed and delivered) — and it is the foundation that Routines (roadmap #6), Activity & Approvals (#8), and Connectors (#9) build on.

**Scope:** This design covers the engine itself — the action interface, DAG executor, event system, and run records. Routine data models, creation UI, scheduling, and the Routines screen are a separate design built on top of this engine.

## Design Principles

1. **Engine wraps, does not replace, AgentRuntime.** Expert steps delegate to the existing pi-agent-core agent loop. The engine orchestrates around it. Simple chat (user → expert → response) remains on the existing path — no added indirection for no benefit.

2. **Actions are typed and composable.** Each action has a strict input/output schema. The output of one step can be wired as input to another. Actions are the atoms; DAGs are the molecules.

3. **Event-sourced execution.** Every state change — step started, output produced, approval requested, error occurred — is an event. Events are the source of truth. Run Records are derived from them.

4. **Pausable by design.** The engine supports approval gates as a first-class concept. When a step requires approval, execution suspends deterministically and resumes when the user decides.

5. **Parallel where possible, sequential where required.** The DAG executor runs independent branches concurrently. Dependencies are enforced via topological sort. Users don't manage concurrency — the graph structure implies it.

6. **Backend stays the service layer.** Model inference, persistence, and external integrations live in the Python backend. The engine in the main process orchestrates HTTP calls to backend endpoints but does not duplicate backend functionality.

7. **Incremental delivery.** V0 implements `model_call`, `transformer`, and `expert_step` actions — enough to build useful routines. Connector and channel actions get interface definitions only, with implementation deferred to roadmap sections 9 and 10.

## Architecture Overview

### Where the Engine Lives

The Execution Engine runs in the **Electron main process** (TypeScript), consistent with where `AgentRuntime` already runs. Three reasons:

1. **IPC is already wired.** The main process can push events to the renderer via `webContents.send()`, exactly as `AgentRuntime` does with `agent:event:{runId}`.
2. **pi-agent-core integration.** The `expert_step` action delegates to `AgentRuntime`, which already lives in the main process. No cross-process overhead.
3. **Backend stays stateless.** The Python backend serves HTTP endpoints — model inference, persistence, search. The engine orchestrates calls to these endpoints but does not embed orchestration state in the backend. This keeps the backend simple and testable.

### System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Renderer Process                        │
│                                                             │
│  ChatContext ─────── RoutineContext (future, roadmap #6)     │
│       │                     │                               │
│       │               ┌─────┴──────┐                        │
│  [existing]           │  engine:   │                        │
│  agent chat           │  event:*   │                        │
│                       │  IPC sub   │                        │
│                       └────────────┘                        │
│  RunEventStream (live logs)     ActivityScreen (run records) │
│  ApprovalInline (approve/deny)                              │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC  (engine:run, engine:cancel,
                        │       engine:approve, engine:deny,
                        │       engine:event:{runId})
┌───────────────────────┴─────────────────────────────────────┐
│                  Main Process (Electron)                     │
│                                                             │
│   ┌─────────────────────────────────────────┐               │
│   │           ExecutionEngine               │               │
│   │                                         │               │
│   │  ┌──────────────┐  ┌────────────────┐   │               │
│   │  │ ActionRegistry│  │ RunScratchpad  │   │               │
│   │  └──────┬───────┘  └────────────────┘   │               │
│   │         │                               │               │
│   │  ┌──────┴──────────────────┐            │               │
│   │  │      DAGExecutor        │            │               │
│   │  │  (Kahn's algorithm,     │            │               │
│   │  │   parallel branches,    │            │               │
│   │  │   approval gates)       │            │               │
│   │  └──────┬──────────────────┘            │               │
│   │         │                               │               │
│   │    ┌────┴────┬──────────┬───────────┐   │               │
│   │    │         │          │           │   │               │
│   │  model_   trans-    expert_     connector│               │
│   │  call     former    step        (stub)  │               │
│   │  (HTTP)   (local)   (delegates)  channel│               │
│   │                      │          (stub)  │               │
│   └──────────────────────┼──────────────────┘               │
│                          │                                  │
│                 AgentRuntime (existing, unchanged)           │
│                 (pi-agent-core agent loops)                  │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP  (SSE streaming, REST)
┌───────────────────────┴─────────────────────────────────────┐
│                 Python Backend (FastAPI)                     │
│                                                             │
│  /cloud/chat    /models/chat    /memory/*                   │
│  /engine/runs   /engine/runs/{id}/steps                     │
│  /engine/runs/{id}/events                                   │
│                                                             │
│  ┌─ SQLite ─────────────────────────────────┐               │
│  │  run_records    step_records             │               │
│  │  execution_events                        │               │
│  │  agent_runs (existing)                   │               │
│  └──────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### Relationship to Existing Systems

| System | Relationship |
|--------|-------------|
| **AgentRuntime** | Engine delegates `expert_step` actions to it. Runtime is unmodified. |
| **ChatContext** | Unchanged for simple chat. Engine adds a parallel execution path for routines. |
| **RendererAgentEvent** | Engine defines its own `ExecutionEvent` types. For `expert_step` actions, agent events are forwarded as nested action-level events. |
| **Memory system** | Engine calls `POST /memory/context` when executing `expert_step` actions (via AgentRuntime). The run scratchpad is separate from persistent memory. |
| **IPC bridge** | New `engine:*` channels added alongside existing `agent:*` channels. Same pattern, different namespace. |
| **agent_runs table** | Coexists with new `run_records`. Different granularity — `agent_runs` tracks one expert loop, `run_records` tracks one DAG execution with many steps. |

### Execution Flow

```
Routine execution requested (from Chat, Schedule, or Webhook)
       │
       ▼
ExecutionEngine.startRun(request)
       │
       ├──► Validate DAG (cycle detection, action types exist)
       ├──► Create RunRecord via POST /engine/runs
       ├──► Initialize RunScratchpad
       ├──► Emit: run_started
       │
       ▼
DAGExecutor.execute(dag)
       │
       ├──► Build in-degree map from step dependencies
       ├──► Collect steps with in-degree 0 → "ready" set
       │
       ▼
  ┌──► While ready set is non-empty:
  │    │
  │    ├──► For each ready step:
  │    │    │
  │    │    ├──► Check requiresApproval?
  │    │    │    ├──► Yes: emit approval_requested, pause, await user decision
  │    │    │    │         ├──► Approved: continue
  │    │    │    │         └──► Denied: cancel run
  │    │    │    └──► No: continue
  │    │    │
  │    │    ├──► Resolve inputs (from DAG edge mappings + scratchpad)
  │    │    ├──► Emit: step_started
  │    │    ├──► Execute action (model_call / transformer / expert_step)
  │    │    │    │
  │    │    │    ├──► model_call: POST /cloud/chat or /models/chat
  │    │    │    ├──► transformer: run locally in main process
  │    │    │    └──► expert_step: AgentRuntime.startRun()
  │    │    │
  │    │    ├──► On success: record output, emit step_completed
  │    │    └──► On failure: apply error policy (fail/skip/retry)
  │    │
  │    ├──► Execute parallel steps via Promise.allSettled()
  │    ├──► Decrement in-degrees of successors
  │    └──► Move newly-ready steps to ready set
  │
  └──► All steps processed
       │
       ▼
Finalize run
       ├──► Update RunRecord via PATCH /engine/runs/{id}
       ├──► Batch-persist events via POST /engine/runs/{id}/events
       ├──► Clear scratchpad
       └──► Emit: run_completed (or run_failed)
```

## Action System

### Action Interface

Every action type implements a common interface. Actions are pure functions: given inputs and context, produce outputs. Side effects (LLM calls, HTTP requests) happen through the context.

```typescript
// src/engine/actions/types.ts

interface ActionDefinition {
  type: string;                   // "model_call" | "transformer" | "expert_step" | "connector" | "channel"
  name: string;                   // Human-readable display name
  description: string;            // What this action does
  inputSchema: JSONSchema;        // JSON Schema for params validation
  outputSchema: JSONSchema;       // JSON Schema for output data
  execute: (input: ActionInput) => Promise<ActionOutput>;
}

interface ActionInput {
  params: Record<string, unknown>;    // Static configuration from the step definition
  wiredInputs: Record<string, unknown>; // Outputs from upstream steps, mapped via DAG edges
  scratchpad: RunScratchpad;          // Ephemeral run working memory (read/write)
  context: ActionContext;             // Runtime context
}

interface ActionOutput {
  data: Record<string, unknown>;  // Output data available to downstream steps
  summary: string;                // Human-readable one-liner for Run Record display
}

interface ActionContext {
  runId: string;
  stepId: string;
  backendPort: number;
  signal: AbortSignal;                                    // For cancellation
  log: (message: string) => void;                         // Emit a log line event
  emitEvent: (event: ExecutionEvent) => void;             // Emit arbitrary event
  resolveModel: () => Promise<ResolvedModel | null>;      // Resolve current model
}
```

### Action Registry

A simple map from action type string to its definition. Populated at engine initialization.

```typescript
// src/engine/actions/registry.ts

class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  register(action: ActionDefinition): void {
    if (this.actions.has(action.type)) {
      throw new Error(`Action type "${action.type}" already registered`);
    }
    this.actions.set(action.type, action);
  }

  get(type: string): ActionDefinition | undefined {
    return this.actions.get(type);
  }

  has(type: string): boolean {
    return this.actions.has(type);
  }

  list(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }
}
```

### Built-in Action Types (V0)

#### model_call

Makes a single LLM call via the existing backend streaming endpoints. Unlike `expert_step`, this is a one-shot call with no multi-turn agent loop or tool access. Useful for summarization, formatting, analysis, and other stateless LLM tasks within a routine.

```typescript
// src/engine/actions/model-call.ts

// Input params
interface ModelCallParams {
  prompt: string;              // The user message / instruction
  systemPrompt?: string;       // Optional system prompt override
  model?: ResolvedModel;       // Optional model override (defaults to global)
  temperature?: number;        // Default: 0.7
  maxTokens?: number;          // Default: 4096
}

// Output data
interface ModelCallOutput {
  response: string;            // Model's response text
  tokenCount?: number;         // Usage stats if available
}
```

Implementation: Resolves the model (override or global), builds a minimal message array (`[{role: "system", content: systemPrompt}, {role: "user", content: prompt}]`), makes an HTTP POST to `/cloud/chat` or `/models/chat` with `stream: true`, and collects the full SSE stream into a response string. Streams `step_log` events as chunks arrive so the renderer can show incremental progress.

#### transformer

Pure data transformation. Runs entirely in the main process with no HTTP calls or LLM invocation. Operations cover common data wiring patterns that routines need between LLM steps.

```typescript
// src/engine/actions/transformer.ts

type TransformOperation = 'format' | 'extract' | 'filter' | 'merge' | 'template';

interface TransformerParams {
  operation: TransformOperation;
  // Operation-specific:
  template?: string;            // For 'format': "Hello {{name}}, your meeting is at {{time}}"
  path?: string;                // For 'extract': dot-path like "data.events[0].title"
  predicate?: string;           // For 'filter': simple comparison, e.g. "score > 0.5" (see safety note below)
  mergeStrategy?: 'shallow' | 'deep'; // For 'merge': how to combine objects
}

interface TransformerOutput {
  result: unknown;              // The transformed data
}
```

Supported operations:

| Operation | Input | What it does | Example |
|-----------|-------|-------------|---------|
| `format` | `{data: Record<string, unknown>}` | Interpolate `{{key}}` placeholders in template string | `"Hello {{name}}"` + `{name: "Alex"}` → `"Hello Alex"` |
| `extract` | `{data: unknown}` | Extract a value by dot-path | `"events[0].title"` from nested JSON |
| `filter` | `{items: unknown[]}` | Filter array by safe predicate | Keep items where `score > 0.5` |
| `merge` | `{sources: Record<string, unknown>[]}` | Merge multiple objects into one | Combine calendar + todos into unified context |
| `template` | `{data: Record<string, unknown>}` | Multi-line template with `{{#each}}`, `{{#if}}` via Mustache | Render a markdown report from structured data |

**Safety: filter predicates.** The `filter` operation does **not** use `eval()`, `new Function()`, or any JavaScript code execution. Predicates are parsed by a safe expression evaluator (e.g., `expr-eval`) that supports only field access, comparison operators (`>`, `<`, `>=`, `<=`, `==`, `!=`), boolean logic (`&&`, `||`, `!`), and literal values. No function calls, no property assignment, no arbitrary code. This is critical because routine definitions may come from third-party marketplace packs.

**Template engine.** The `format` operation uses simple `{{key}}` interpolation (custom, no library). The `template` operation uses [Mustache.js](https://github.com/janl/mustache.js) for logic-less templates — it supports `{{#each}}` and `{{#if}}` but cannot execute arbitrary code, making it safe for user-authored and marketplace routines.

#### expert_step

Delegates to the existing `AgentRuntime` for full multi-turn agent execution. This is how routines invoke Expert intelligence — the agent can reason, call tools (search, memory, etc.), and produce a thoughtful response.

```typescript
// src/engine/actions/expert-step.ts

interface ExpertStepParams {
  prompt: string;                  // Instruction for the expert
  expertId?: string;               // Which expert (null = use global/Cerebro)
  additionalContext?: string;      // Extra context prepended to the prompt
  maxTurns?: number;               // Override expert's default max turns
  toolAccess?: string[];           // Override tool list
}

interface ExpertStepOutput {
  response: string;                // Expert's final response text
  toolsUsed: string[];             // Which tools the agent called
  turns: number;                   // How many agent turns occurred
  agentRunId: string;              // Reference to the agent_run record
}
```

Implementation: Creates a temporary `AgentRunRequest` and calls `agentRuntime.startRun()`. Model resolution follows existing `AgentRuntime` behavior: the expert's `model_config` takes precedence, falling back to the global selected model. Subscribes to the agent's events and forwards them as nested `ExecutionEvent` types:

| Agent Event | Forwarded As |
|-------------|-------------|
| `text_delta` | `action_text_delta` |
| `tool_start` | `action_tool_start` |
| `tool_end` | `action_tool_end` |
| `done` | Step completes; `response` extracted from `messageContent` |
| `error` | Step fails with error |

This means the renderer can show the expert's full reasoning process (thinking, tool calls, text generation) inside the step's live log view — identical to how it renders in chat today.

#### connector (interface only)

Reads from and writes to external services (Google Calendar, Gmail, Notion, etc.). Implementation deferred to roadmap Section 9.

```typescript
// src/engine/actions/connector.ts

interface ConnectorParams {
  service: string;           // "google_calendar" | "gmail" | "notion" | ...
  operation: string;         // "list_events" | "send_email" | "query_database" | ...
  payload: Record<string, unknown>;  // Operation-specific parameters
}

interface ConnectorOutput {
  data: unknown;             // Service response
  statusCode: number;
}
```

V0 stub: Returns an error message "Connector '{service}' is not yet available. Connector support is coming in a future update."

#### channel (interface only)

Sends and receives messages via messaging channels (Telegram, WhatsApp, Email, etc.). Implementation deferred to roadmap Section 10.

```typescript
// src/engine/actions/channel.ts

interface ChannelParams {
  channel: string;           // "telegram" | "whatsapp" | "email" | ...
  operation: 'send' | 'receive';
  recipients?: string[];
  message: string;
}

interface ChannelOutput {
  delivered: boolean;
  messageId?: string;
}
```

V0 stub: Returns an error message "Channel '{channel}' is not yet available."

## DAG Executor

### Graph Model

A routine compiles into a DAG of steps. The engine receives this DAG and executes it.

```typescript
// src/engine/dag/types.ts

interface StepDefinition {
  id: string;                          // Unique within the DAG
  name: string;                        // Human-readable label ("Fetch calendar events")
  actionType: string;                  // References ActionRegistry ("model_call", "transformer", etc.)
  params: Record<string, unknown>;     // Action-specific configuration (passed as ActionInput.params)
  dependsOn: string[];                 // Step IDs that must complete before this step
  inputMappings: InputMapping[];       // Wires upstream outputs into this step's inputs
  requiresApproval: boolean;           // Whether to pause for user approval before executing
  onError: 'fail' | 'skip' | 'retry'; // Error handling policy
  maxRetries?: number;                 // Only used when onError is 'retry' (default: 1)
  timeoutMs?: number;                  // Max execution time per step (default: 300000 = 5 min)
}

interface InputMapping {
  sourceStepId: string;      // Which upstream step's output
  sourceField: string;       // Dot-path into the source step's output.data
  targetField: string;       // Key name in this step's wiredInputs
}

interface DAGDefinition {
  steps: StepDefinition[];
  // Edges are implicit in dependsOn arrays and inputMappings.
  // This is simpler than a separate edges list and prevents
  // edge/dependency mismatches.
}
```

### Why `dependsOn` Instead of Explicit Edges

In many DAG frameworks, edges are a separate array. We encode dependencies directly on each step via `dependsOn` and `inputMappings` because:

1. **Single source of truth.** An `inputMapping` from step A to step B implies A must complete before B. Making users also declare this in a separate edges array is redundant and error-prone.
2. **Simpler validation.** Cycle detection runs on `dependsOn` alone — no reconciliation with an edges list.
3. **JSON is cleaner.** Routine authors (and Cerebro's routine compiler) define each step as a self-contained object.

### Topological Execution (Kahn's Algorithm)

The DAG executor uses Kahn's algorithm — a standard BFS-based topological sort that naturally identifies which steps can run in parallel.

```typescript
// src/engine/dag/executor.ts

class DAGExecutor {
  private stepOutputs = new Map<string, Record<string, unknown>>();
  private abortController: AbortController;
  private pendingApprovals = new Map<string, {
    resolve: (approved: boolean) => void;
    stepId: string;
  }>();

  constructor(
    private dag: DAGDefinition,
    private registry: ActionRegistry,
    private scratchpad: RunScratchpad,
    private context: RunContext,
  ) {
    this.abortController = new AbortController();
  }

  async execute(): Promise<void> {
    // 1. Validate
    this.validate();

    // 2. Build in-degree map
    const inDegree = new Map<string, number>();
    const successors = new Map<string, string[]>();
    for (const step of this.dag.steps) {
      inDegree.set(step.id, step.dependsOn.length);
      for (const dep of step.dependsOn) {
        const succ = successors.get(dep) ?? [];
        succ.push(step.id);
        successors.set(dep, succ);
      }
    }

    // 3. Collect initial ready set (in-degree 0)
    const ready: string[] = [];
    for (const step of this.dag.steps) {
      if (inDegree.get(step.id) === 0) ready.push(step.id);
    }

    let executedCount = 0;

    // 4. Process waves
    while (ready.length > 0) {
      if (this.abortController.signal.aborted) break;

      const wave = [...ready];
      ready.length = 0;

      // Execute all ready steps in parallel
      const results = await Promise.allSettled(
        wave.map(stepId => this.executeStep(stepId))
      );

      // Process results
      for (let i = 0; i < results.length; i++) {
        const stepId = wave[i];
        const result = results[i];
        executedCount++;

        if (result.status === 'fulfilled') {
          // Decrement in-degrees of successors
          for (const succId of successors.get(stepId) ?? []) {
            const newDegree = (inDegree.get(succId) ?? 1) - 1;
            inDegree.set(succId, newDegree);
            if (newDegree === 0) ready.push(succId);
          }
        } else {
          // Step failed — handled inside executeStep based on onError policy
          // If onError was 'fail', the abortController is already aborted
        }
      }
    }
  }
}
```

### Parallel Branch Execution

Independent branches execute concurrently by design. Consider this DAG:

```
       ┌───► B (fetch calendar) ────┐
A ─────┤                            ├───► D (draft plan)
       └───► C (fetch todos)   ─────┘
```

- **Wave 1:** A runs alone (in-degree 0).
- **Wave 2:** B and C both reach in-degree 0 after A completes. They execute in parallel via `Promise.allSettled([executeStep('B'), executeStep('C')])`.
- **Wave 3:** D reaches in-degree 0 after both B and C complete. D's `inputMappings` wire B's and C's outputs into its inputs.

No explicit parallelism configuration needed — the graph structure determines it.

### Run Scratchpad

```typescript
// src/engine/scratchpad.ts

class RunScratchpad {
  private data = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  entries(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }

  clear(): void {
    this.data.clear();
  }
}
```

The scratchpad serves a different purpose than DAG edge wiring:

- **DAG edges** (via `inputMappings`) wire specific output fields from one step to input fields of another. This is the primary data flow mechanism.
- **Scratchpad** is shared mutable state that any step can read or write. Useful for accumulating results across branches, storing intermediate notes, or passing data between non-adjacent steps without adding explicit edges.

**Concurrency note:** The scratchpad is safe for concurrent reads and independent writes to different keys (JavaScript's single-threaded event loop guarantees atomic `Map` operations). Steps in the same parallel wave should not read-then-write the same key — that pattern requires `inputMappings` instead. The scratchpad is intended for cross-wave accumulation and ad-hoc data sharing, not intra-wave coordination.

Per the PRD (Section 10.1), the scratchpad is ephemeral — cleared after the run ends. It is not included in the Run Record. Step outputs (which are persisted) should contain any data that needs to survive beyond the run.

### Error Propagation

Each step declares an `onError` policy:

| Policy | Behavior |
|--------|----------|
| `fail` (default) | Abort the entire run. Cancel in-progress parallel steps. Mark remaining steps as `skipped`. Run status → `failed`. |
| `skip` | Mark this step as `skipped`. Downstream steps that depend on this step's output receive `null` for the missing inputs and must handle it gracefully. |
| `retry` | Retry up to `maxRetries` times (default: 1). If all retries fail, apply `fail` behavior. |

**Step timeouts:** Each step has an optional `timeoutMs` (default: 300,000ms = 5 minutes). The `DAGExecutor` wraps each `executeStep()` in a `Promise.race` against a timeout. If the timeout fires, the step's `AbortSignal` is triggered and the step fails with a timeout error, subject to its `onError` policy. This prevents a slow backend, unresponsive model, or infinite agent tool-call loop from hanging the entire run.

When a step fails with `onError: 'fail'`:
1. `this.abortController.abort()` — signals all in-progress parallel steps to cancel
2. Remaining steps in the DAG are marked as `skipped`
3. Run status transitions to `failed` with the error and `failedStepId` recorded

### Pause/Resume (Approval Gates)

When a step has `requiresApproval: true`, the executor pauses before executing it:

```typescript
private async executeStep(stepId: string): Promise<void> {
  const step = this.stepMap.get(stepId)!;

  // Check approval gate
  if (step.requiresApproval) {
    const approved = await this.waitForApproval(step);
    if (!approved) {
      // User denied — cancel the run
      this.abortController.abort();
      throw new StepDeniedError(stepId);
    }
  }

  // Execute the action...
}

private async waitForApproval(step: StepDefinition): Promise<boolean> {
  const approvalId = generateId();

  // 1. Persist approval request
  await this.createApproval(approvalId, step);

  // 2. Emit event to renderer
  this.context.emitEvent({
    type: 'approval_requested',
    runId: this.context.runId,
    stepId: step.id,
    approvalId,
    summary: `Approve "${step.name}"?`,
    payload: step.params,
    timestamp: new Date().toISOString(),
  });

  // 3. Wait for user decision
  return new Promise((resolve) => {
    this.pendingApprovals.set(approvalId, { resolve, stepId: step.id });
  });
}

// Called by IPC handler when user approves/denies
resolveApproval(approvalId: string, approved: boolean): void {
  const pending = this.pendingApprovals.get(approvalId);
  if (pending) {
    this.pendingApprovals.delete(approvalId);
    pending.resolve(approved);
  }
}
```

The run status transitions to `paused` while awaiting approval. No other steps execute during the pause (even if they have no dependency on the paused step). This is intentional — approval gates are checkpoints where the user reviews the current state of the run before it proceeds.

**Approval state persistence.** Approval decisions are recorded on the `step_records` table via `approval_id` and `approval_status` columns. In V0, approvals are resolved entirely through IPC (renderer → main process → `DAGExecutor.resolveApproval()`). The Approvals screen (roadmap #8) will add dedicated REST endpoints (`GET /engine/approvals` for listing pending approvals, `PATCH /engine/approvals/{id}` for approve/deny) so the Approvals UI can query and act on pending gates independently of the run's IPC event stream. Those endpoints are defined in that design, not here.

## Execution Events

### Event Types

Events are the backbone of observability. They stream to the renderer in real-time and are persisted for replay in the Activity drill-down.

```typescript
// src/engine/events/types.ts

type ExecutionEvent =
  // ── Run lifecycle ──────────────────────────────────────────
  | { type: 'run_started'; runId: string; totalSteps: number; timestamp: string }
  | { type: 'run_completed'; runId: string; durationMs: number; timestamp: string }
  | { type: 'run_failed'; runId: string; error: string; failedStepId: string; timestamp: string }
  | { type: 'run_cancelled'; runId: string; reason?: string; timestamp: string }

  // ── Step lifecycle ─────────────────────────────────────────
  | { type: 'step_queued'; runId: string; stepId: string; stepName: string; timestamp: string }
  | { type: 'step_started'; runId: string; stepId: string; stepName: string;
      actionType: string; timestamp: string }
  | { type: 'step_log'; runId: string; stepId: string; message: string; timestamp: string }
  | { type: 'step_completed'; runId: string; stepId: string; summary: string;
      durationMs: number; timestamp: string }
  | { type: 'step_failed'; runId: string; stepId: string; error: string; timestamp: string }
  | { type: 'step_skipped'; runId: string; stepId: string; reason: string; timestamp: string }

  // ── Action detail (for expert_step, surfaces agent reasoning) ──
  | { type: 'action_text_delta'; runId: string; stepId: string; delta: string }
  | { type: 'action_tool_start'; runId: string; stepId: string;
      toolName: string; args: Record<string, unknown> }
  | { type: 'action_tool_end'; runId: string; stepId: string;
      toolName: string; result: string; isError: boolean }

  // ── Approval gates ─────────────────────────────────────────
  | { type: 'approval_requested'; runId: string; stepId: string; approvalId: string;
      summary: string; payload: unknown; timestamp: string }
  | { type: 'approval_granted'; runId: string; stepId: string;
      approvalId: string; timestamp: string }
  | { type: 'approval_denied'; runId: string; stepId: string;
      approvalId: string; reason?: string; timestamp: string };
```

### Event Delivery

Events are delivered to the renderer via IPC, following the same pattern as `RendererAgentEvent`:

```typescript
// In ExecutionEngine:
this.webContents.send(
  IPC_CHANNELS.engineEvent(runId),
  event
);

// In renderer (via preload):
window.cerebro.engine.onEvent(runId, (event: ExecutionEvent) => {
  // Update run progress, step status, live logs
});
```

### Event Persistence

Events are buffered in memory during the run and batch-written to the backend at run completion:

```typescript
// In ExecutionEngine.finalizeRun():
await fetch(`http://127.0.0.1:${port}/engine/runs/${runId}/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ events: this.eventBuffer }),
});
```

In addition to the final batch, the engine persists step records to the backend after each step completes (one `PATCH /engine/runs/{id}/steps` call per step with status, output, duration). This means the Activity screen can show partial progress for crashed or interrupted runs. If a routine sent an email in step 3 and the app crashed in step 5, the record of the email being sent survives. The full event stream (including token-level `action_text_delta` events) is still batch-written at run completion — per-step persistence covers the coarse-grained step records, not the fine-grained event log.

**Known limitation (V0):** If the app crashes mid-run, step records for completed steps are preserved, but the fine-grained event log for the current run is lost. The run will show as `running` in the database with no `completed_at`. A future improvement could add a startup recovery pass that marks orphaned `running` records as `failed`.

The Activity drill-down (roadmap #8) replays persisted events to reconstruct the full run timeline. For crashed runs, it falls back to displaying step records only.

## Run Lifecycle

### State Machine

```
                  ┌──────────┐
                  │ created  │
                  └────┬─────┘
                       │ engine.start()
                       ▼
             ┌────► running ◄────┐
             │     ┌───┴───┐    │
             │     │       │    │
             │     ▼       ▼    │
          resume  step   step   │
             │   passes  needs  │
             │     │   approval │
             │     ▼     │      │
             │   next    ▼      │
             │   step  paused ──┤ approved
             │     │     │      │
             │     ▼     ▼      │
             │  (loop) denied   │
             │           │      │
             │           ▼      │
             │      cancelled   │
             │                  │
             │   all steps ok   │
             │        │         │
             │        ▼         │
             │    completed     │
             │                  │
             │   step fails     │
             │     (onError:    │
             │      fail)       │
             └──── failed ◄─────┘
                                    (retry → back to running)
```

**States:**

| State | Meaning |
|-------|---------|
| `created` | Run record exists but execution hasn't started |
| `running` | DAG executor is actively processing steps |
| `paused` | Waiting for user approval on a step |
| `completed` | All steps finished successfully |
| `failed` | A step failed with `onError: 'fail'` and no retries remain |
| `cancelled` | User cancelled the run, or denied an approval |

### Cancellation

The renderer can cancel a running or paused run via `engine:cancel` IPC:

1. `abortController.abort()` — all in-progress action HTTP requests receive the abort signal
2. For any in-progress `expert_step`, `agentRuntime.cancelRun(agentRunId)` is called
3. Pending approval Promises are resolved with `false`
4. Run status → `cancelled`
5. `run_cancelled` event emitted

### Engine Top-Level Class

```typescript
// src/engine/engine.ts

class ExecutionEngine {
  private activeRuns = new Map<string, ActiveEngineRun>();
  private registry: ActionRegistry;
  private backendPort: number;

  constructor(backendPort: number, private agentRuntime: AgentRuntime) {
    this.backendPort = backendPort;
    this.registry = new ActionRegistry();
    this.registerBuiltinActions();
  }

  async startRun(
    webContents: WebContents,
    request: EngineRunRequest,
  ): Promise<string> {
    const runId = generateId();
    const scratchpad = new RunScratchpad();

    // 1. Validate DAG
    validateDAG(request.dag, this.registry);

    // 2. Create backend record
    await this.createRunRecord(runId, request);

    // 3. Create executor
    const executor = new DAGExecutor(
      request.dag,
      this.registry,
      scratchpad,
      { runId, backendPort: this.backendPort, webContents, agentRuntime: this.agentRuntime },
    );

    // 4. Track
    this.activeRuns.set(runId, { runId, executor, request, startedAt: new Date() });

    // 5. Execute (non-blocking)
    executor.execute()
      .then(() => this.finalizeRun(runId, 'completed'))
      .catch((err) => this.finalizeRun(runId, 'failed', err));

    return runId;
  }

  cancelRun(runId: string): boolean { ... }
  resolveApproval(approvalId: string, approved: boolean): boolean { ... }
  getActiveRuns(): EngineActiveRunInfo[] { ... }
}
```

## Data Models

### RunRecord Table

```python
# backend/models.py (addition)

class RunRecord(Base):
    __tablename__ = "run_records"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    routine_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
        # NULL for ad-hoc / preview runs. FK added when Routines ship (roadmap #6).
    expert_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )
    conversation_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(20), index=True)
        # "created" | "running" | "paused" | "completed" | "failed" | "cancelled"
    run_type: Mapped[str] = mapped_column(String(20), default="routine")
        # "routine" | "preview" | "ad_hoc"
    trigger: Mapped[str] = mapped_column(String(20), default="manual")
        # "manual" | "scheduled" | "webhook" | "chat"
        # How chat triggers engine runs (matching user intent to saved routines,
        # compiling DAGs from proposals) is defined in the Routines tech design
        # (roadmap #6). This design provides the trigger field for that integration.
    dag_json: Mapped[str] = mapped_column(Text)
        # Snapshot of the DAGDefinition at execution time (for replay and debugging)
    total_steps: Mapped[int] = mapped_column(Integer, default=0)
    completed_steps: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    failed_step_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
```

### StepRecord Table

```python
class StepRecord(Base):
    __tablename__ = "step_records"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="CASCADE"), index=True
    )
    step_id: Mapped[str] = mapped_column(String(32))
        # Matches StepDefinition.id from the DAG
    step_name: Mapped[str] = mapped_column(String(255))
    action_type: Mapped[str] = mapped_column(String(50))
    status: Mapped[str] = mapped_column(String(20))
        # "pending" | "running" | "completed" | "failed" | "skipped"
    input_json: Mapped[str | None] = mapped_column(Text, nullable=True)
        # Serialized resolved inputs for debugging
    output_json: Mapped[str | None] = mapped_column(Text, nullable=True)
        # Serialized ActionOutput.data
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
        # ActionOutput.summary (human-readable one-liner)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    approval_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approval_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
        # "pending" | "approved" | "denied" | NULL (no approval needed)
    order_index: Mapped[int] = mapped_column(Integer)
        # Assigned sequentially based on when each step starts execution (not DAG
        # position), so the Activity drill-down shows the actual execution timeline.
```

### ExecutionEventRecord Table

```python
class ExecutionEventRecord(Base):
    __tablename__ = "execution_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    run_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("run_records.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
        # Monotonically increasing within a run, for replay ordering
    event_type: Mapped[str] = mapped_column(String(50), index=True)
    step_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payload_json: Mapped[str] = mapped_column(Text)
        # Full event serialized as JSON
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)
```

### Coexistence with `agent_runs`

`run_records` and `agent_runs` serve different purposes and coexist:

| Table | Tracks | Created by |
|-------|--------|-----------|
| `agent_runs` | A single expert agent loop (turns, tokens, tools used) | `AgentRuntime.startRun()` |
| `run_records` | A full DAG execution (steps, approvals, scratchpad) | `ExecutionEngine.startRun()` |

An `expert_step` action in a routine creates **both** — a `step_record` that references the `agent_run.id` in its output. Simple chat creates only an `agent_run` (no `run_record`).

The Activity screen (roadmap #8) queries `run_records` for routine-level history. For expert step drill-down, it can follow the `agentRunId` reference to show agent-level detail.

### Frontend Types

```typescript
// src/types/engine.ts

export type RunStatus = 'created' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type RunType = 'routine' | 'preview' | 'ad_hoc';
export type RunTrigger = 'manual' | 'scheduled' | 'webhook' | 'chat';

export interface RunRecord {
  id: string;
  routineId: string | null;
  expertId: string | null;
  conversationId: string | null;
  status: RunStatus;
  runType: RunType;
  trigger: RunTrigger;
  totalSteps: number;
  completedSteps: number;
  error: string | null;
  failedStepId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface StepRecord {
  id: string;
  runId: string;
  stepId: string;
  stepName: string;
  actionType: string;
  status: StepStatus;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  approvalStatus: 'pending' | 'approved' | 'denied' | null;
  orderIndex: number;
}

export interface EngineRunRequest {
  dag: DAGDefinition;
  routineId?: string;
  expertId?: string;
  conversationId?: string;
  runType?: RunType;
  trigger?: RunTrigger;
}

export interface EngineActiveRunInfo {
  runId: string;
  routineId: string | null;
  expertId: string | null;
  status: RunStatus;
  totalSteps: number;
  completedSteps: number;
  startedAt: string;
}
```

## Backend Implementation

### Module Structure

```
backend/engine/
    __init__.py
    schemas.py          # Pydantic request/response models
    router.py           # FastAPI router mounted at /engine
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/engine/runs` | Create a run record |
| `GET` | `/engine/runs` | List runs (filter by routine_id, status, run_type, trigger) |
| `GET` | `/engine/runs/{id}` | Get run with all step records |
| `PATCH` | `/engine/runs/{id}` | Update run (status, completed_steps, error, completed_at, duration_ms) |
| `DELETE` | `/engine/runs/{id}` | Delete run (cascades step records and events) |
| `POST` | `/engine/runs/{id}/steps` | Batch create/update step records |
| `GET` | `/engine/runs/{id}/steps` | List step records ordered by order_index |
| `POST` | `/engine/runs/{id}/events` | Batch persist execution events |
| `GET` | `/engine/runs/{id}/events` | List events ordered by seq (for replay) |

### Pydantic Schemas

```python
# backend/engine/schemas.py

class RunRecordCreate(BaseModel):
    id: str
    routine_id: str | None = None
    expert_id: str | None = None
    conversation_id: str | None = None
    run_type: str = "routine"
    trigger: str = "manual"
    dag_json: str
    total_steps: int = 0

class RunRecordUpdate(BaseModel):
    status: str | None = None
    completed_steps: int | None = None
    error: str | None = None
    failed_step_id: str | None = None
    completed_at: str | None = None
    duration_ms: int | None = None

class RunRecordResponse(BaseModel):
    id: str
    routine_id: str | None
    expert_id: str | None
    conversation_id: str | None
    status: str
    run_type: str
    trigger: str
    total_steps: int
    completed_steps: int
    error: str | None
    failed_step_id: str | None
    started_at: str
    completed_at: str | None
    duration_ms: int | None
    steps: list["StepRecordResponse"] = []

class StepRecordCreate(BaseModel):
    id: str
    step_id: str
    step_name: str
    action_type: str
    status: str = "pending"
    order_index: int

class StepRecordUpdate(BaseModel):
    status: str | None = None
    input_json: str | None = None
    output_json: str | None = None
    summary: str | None = None
    error: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    duration_ms: int | None = None
    approval_id: str | None = None
    approval_status: str | None = None

class StepRecordResponse(BaseModel):
    id: str
    run_id: str
    step_id: str
    step_name: str
    action_type: str
    status: str
    summary: str | None
    error: str | None
    started_at: str | None
    completed_at: str | None
    duration_ms: int | None
    approval_status: str | None
    order_index: int

class EventCreate(BaseModel):
    seq: int
    event_type: str
    step_id: str | None = None
    payload_json: str           # Full event serialized as JSON string
    timestamp: str

class EventBatchCreate(BaseModel):
    events: list[EventCreate]

class EventRecordResponse(BaseModel):
    id: str
    run_id: str
    seq: int
    event_type: str
    step_id: str | None
    payload_json: str
    timestamp: str
```

## IPC Channels

New channels added to `src/types/ipc.ts`:

```typescript
// Additions to IPC_CHANNELS
ENGINE_RUN: 'engine:run',
ENGINE_CANCEL: 'engine:cancel',
ENGINE_APPROVE: 'engine:approve',
ENGINE_DENY: 'engine:deny',
ENGINE_ACTIVE_RUNS: 'engine:active-runs',
engineEvent: (runId: string) => `engine:event:${runId}`,
```

New `EngineAPI` interface on `window.cerebro`:

```typescript
interface EngineAPI {
  run(request: EngineRunRequest): Promise<string>;              // Returns runId
  cancel(runId: string): Promise<boolean>;
  approve(approvalId: string): Promise<boolean>;
  deny(approvalId: string, reason?: string): Promise<boolean>;
  activeRuns(): Promise<EngineActiveRunInfo[]>;
  onEvent(runId: string, callback: (event: ExecutionEvent) => void): () => void;
}
```

The `CerebroAPI` interface gains an `engine` property:

```typescript
export interface CerebroAPI {
  invoke<T>(request: BackendRequest): Promise<BackendResponse<T>>;
  getStatus(): Promise<string>;
  startStream(request: BackendRequest): Promise<string>;
  cancelStream(streamId: string): Promise<void>;
  onStream(streamId: string, callback: (event: unknown) => void): () => void;
  credentials: CredentialAPI;
  models: ModelAPI;
  agent: AgentAPI;
  engine: EngineAPI;  // NEW
}
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Engine location | Electron main process (TypeScript) | Consistent with AgentRuntime. IPC to renderer already wired. Python backend stays stateless service layer. |
| Simple chat path | Unchanged — still calls AgentRuntime directly | Adding engine indirection to every chat message adds latency for zero benefit. Engine is for multi-step DAG execution. |
| DAG representation | `dependsOn` arrays on steps (no separate edges list) | Single source of truth. Simpler validation. Cleaner JSON for routine compilation. |
| Topological sort | Kahn's algorithm with parallel waves | Standard, well-understood BFS approach. `Promise.allSettled()` for natural parallelism at each wave. |
| Run scratchpad | In-memory `Map`, cleared after run | PRD mandates ephemeral working memory. No persistence overhead. |
| Approval gates | Promise + resolver pattern in DAGExecutor | Natural async/await fit. Executor awaits a Promise; IPC handler calls the resolver. |
| Event persistence | Batch-write at run completion (V0) | Simpler than real-time streaming to backend. Acceptable for V0; optimize later if needed. |
| `run_records` vs `agent_runs` | Separate tables, coexist | Different granularities. `agent_runs` = one expert loop. `run_records` = one DAG execution with N steps. `expert_step` creates both. |
| V0 action types | `model_call`, `transformer`, `expert_step` | Core primitives for useful routines. `connector`/`channel` need external service integration (roadmap #9/#10). |
| Error policy | Per-step `fail`/`skip`/`retry` | Gives routine authors control. `fail` is safe default. `skip` enables resilient pipelines. `retry` handles transient failures. |
| `expert_step` agent events | Forwarded as nested `action_text_delta`, `action_tool_start`, `action_tool_end` | Full observability: the Activity drill-down shows the expert's reasoning within each step. |
| Transformer operations | `format`, `extract`, `filter`, `merge`, `template` | Cover common data wiring needs between LLM steps. Pure functions, no external calls, testable. |

## Implementation Phases

### Phase 1: Action Infrastructure

**Roadmap tasks:** Action interface (connectors, channels, transformers, model calls) + Model-call and transformer action types.

- Create `src/engine/` module structure
- Define `ActionDefinition`, `ActionInput`, `ActionOutput`, `ActionContext` interfaces in `src/engine/actions/types.ts`
- Implement `ActionRegistry` in `src/engine/actions/registry.ts`
- Implement `model_call` action in `src/engine/actions/model-call.ts` — wraps backend streaming into collected response
- Implement `transformer` action in `src/engine/actions/transformer.ts` — all 5 operations
- Define connector and channel interfaces with stub implementations
- Unit tests for registry, transformer operations, and model_call (with mock backend)

**Deliverable:** Actions can be instantiated and executed individually outside the DAG.

### Phase 2: DAG Executor + Event Streaming

**Roadmap tasks:** DAG executor with topological ordering and event streaming + Event streaming system (main process → renderer).

- Define `DAGDefinition`, `StepDefinition`, `InputMapping` types in `src/engine/dag/types.ts`
- Implement DAG validator in `src/engine/dag/validator.ts` — cycle detection, action type existence, input mapping validity
- Implement `DAGExecutor` with Kahn's algorithm in `src/engine/dag/executor.ts` — topological sort, parallel waves, input resolution, error propagation
- Implement `RunScratchpad` in `src/engine/scratchpad.ts`
- Define `ExecutionEvent` discriminated union in `src/engine/events/types.ts`
- Implement event emitter with in-memory buffer in `src/engine/events/emitter.ts`
- Add `engine:*` IPC channel constants to `src/types/ipc.ts`
- Add `EngineAPI` to preload bridge in `src/preload.ts`
- Register `engine:run`, `engine:cancel`, `engine:active-runs` IPC handlers in `src/main.ts`
- Implement `ExecutionEngine` top-level class in `src/engine/engine.ts`

**Deliverable:** A DAG of `model_call` and `transformer` steps can execute with events streaming to the renderer. No persistence yet.

### Phase 3: expert_step Action

**Roadmap task:** Continuation of action interface — bridges engine to existing AgentRuntime.

- Implement `expert_step` action in `src/engine/actions/expert-step.ts`
- Translate `RendererAgentEvent` → `ExecutionEvent` (action_text_delta, action_tool_start, action_tool_end)
- Handle agent run completion, failure, and cancellation within the DAG executor
- Wire `expert_step` output (final message, tools used, run metadata) to downstream steps

**Deliverable:** A DAG step can invoke a full expert agent loop with tools and pass results downstream.

### Phase 4: Run Record Persistence

**Roadmap task:** Run Record persistence and state management.

- Add `RunRecord`, `StepRecord`, `ExecutionEventRecord` models to `backend/models.py`
- Create `backend/engine/` module with `schemas.py` and `router.py`
- Mount `/engine` router in `backend/main.py`
- Add `src/types/engine.ts` with frontend types
- Integrate persistence into `ExecutionEngine`: create run record at start, update step records during execution, batch-persist events and finalize run at completion
- Add `engine:active-runs` IPC handler returning live run status

**Deliverable:** Every engine run produces a queryable Run Record with step details and persisted events.

### Phase 5: Approval Gates

**Roadmap task:** Part of Action interface + Event streaming (approval is a cross-cutting concern).

- Implement `waitForApproval()` in `DAGExecutor` with Promise + resolver pattern
- Add `engine:approve` and `engine:deny` IPC handlers in `src/main.ts`
- Add approval fields to `StepRecord` (approval_id, approval_status)
- Add `approval_requested`, `approval_granted`, `approval_denied` event types
- Implement run state transition to `paused` during approval wait, `cancelled` on denial
- Persist approval decisions in step records

**Deliverable:** Steps with `requiresApproval: true` pause execution, stream approval events, and resume or stop based on user decision.

## Files Created

| File | Purpose |
|------|---------|
| `src/engine/actions/types.ts` | ActionDefinition, ActionInput, ActionOutput, ActionContext interfaces |
| `src/engine/actions/registry.ts` | ActionRegistry class |
| `src/engine/actions/model-call.ts` | model_call action implementation |
| `src/engine/actions/transformer.ts` | transformer action with 5 operations |
| `src/engine/actions/expert-step.ts` | expert_step action (delegates to AgentRuntime) |
| `src/engine/actions/connector.ts` | connector action interface + stub |
| `src/engine/actions/channel.ts` | channel action interface + stub |
| `src/engine/dag/types.ts` | DAGDefinition, StepDefinition, InputMapping types |
| `src/engine/dag/executor.ts` | DAGExecutor with Kahn's algorithm and parallel waves |
| `src/engine/dag/validator.ts` | DAG validation (cycles, schema checks, action types) |
| `src/engine/events/types.ts` | ExecutionEvent discriminated union |
| `src/engine/events/emitter.ts` | Event emission, buffering, and IPC delivery |
| `src/engine/scratchpad.ts` | RunScratchpad class |
| `src/engine/engine.ts` | ExecutionEngine top-level orchestrator |
| `src/engine/index.ts` | Module barrel export |
| `src/types/engine.ts` | Frontend types (RunRecord, StepRecord, EngineRunRequest, etc.) |
| `backend/engine/__init__.py` | Module init |
| `backend/engine/schemas.py` | Pydantic models for runs, steps, events |
| `backend/engine/router.py` | /engine/* REST endpoints |

## Files Modified

| File | Change |
|------|--------|
| `backend/models.py` | Add RunRecord, StepRecord, ExecutionEventRecord SQLAlchemy models |
| `backend/main.py` | Import engine models, mount `/engine` router |
| `src/main.ts` | Instantiate ExecutionEngine (passing AgentRuntime + backendPort), register `engine:*` IPC handlers |
| `src/preload.ts` | Add `engine` property to CerebroAPI contextBridge exposure |
| `src/types/ipc.ts` | Add ENGINE_* channel constants, EngineAPI interface, update CerebroAPI |
| `src/types/global.d.ts` | Update Window.cerebro type to include engine |

## Verification

**Phase 1 — Action Infrastructure:**
1. Execute a `model_call` action with a simple prompt. Verify it returns response text from the backend.
2. Execute a `transformer` with `format` operation (`"Hello {{name}}"` + `{name: "Alex"}`). Verify output is `"Hello Alex"`.
3. Execute a `transformer` with `extract` operation. Verify it pulls the correct nested value.
4. Verify `ActionRegistry.register()` rejects duplicate type registrations.

**Phase 2 — DAG Executor:**
5. Define a 3-step linear DAG (A → B → C) where B uses A's output. Execute. Verify steps run in order and B receives A's output via `inputMappings`.
6. Define a diamond DAG (A → B, A → C, B+C → D). Verify B and C execute in parallel and D waits for both.
7. Introduce a cycle (A → B → A). Verify the validator rejects it before execution.
8. Set step B's `onError` to `skip`, make it fail. Verify C executes and the run completes.
9. Set step B's `onError` to `retry` with `maxRetries: 2`, make it fail twice then succeed. Verify the run completes.
10. Verify `ExecutionEvent` objects stream to the renderer in real-time during execution.

**Phase 3 — expert_step:**
11. Create a DAG with an `expert_step` that prompts an expert. Verify the agent runs, uses tools, and returns a response.
12. Wire the `expert_step` output (`response` field) as input to a downstream `transformer` step. Verify the transformer receives the expert's text.
13. Verify `action_text_delta`, `action_tool_start`, and `action_tool_end` events stream to the renderer during the expert step.

**Phase 4 — Run Records:**
14. Execute a DAG. Query `GET /engine/runs`. Verify a `run_record` exists with correct status, timestamps, and step counts.
15. Query `GET /engine/runs/{id}/steps`. Verify `step_records` have correct execution order, inputs, outputs, and durations.
16. Query `GET /engine/runs/{id}/events`. Verify events are persisted with correct seq ordering and can reconstruct the full run timeline.

**Phase 5 — Approval Gates:**
17. Execute a DAG where step B has `requiresApproval: true`. Verify execution pauses at B, `approval_requested` event is emitted, and run status is `paused`.
18. Call `engine:approve`. Verify execution resumes, B executes, and the run completes.
19. Execute the same DAG but call `engine:deny`. Verify run transitions to `cancelled` and `approval_denied` event is emitted.
