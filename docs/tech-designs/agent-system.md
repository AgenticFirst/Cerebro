# Agent System

## Problem Statement

AI assistants are single-personality chatbots. You get one model, one persona, one context window — and that persona is a generalist that's equally mediocre at everything. Ask it to coach your running and manage your budget in the same conversation, and you get generic advice with no domain depth, no specialized memory, and no ability to take actions.

Real expertise requires specialization. A running coach needs to track your training load, recall your injury history, and adjust plans based on your progress. A personal CFO needs to categorize transactions, monitor spending patterns, and flag budget overruns. These aren't different prompts — they're different *agents* with different models, different tools, different memory, and the ability to reason over multiple turns before responding.

Cerebro's Agent System turns Experts into autonomous agents. Each Expert gets its own execution loop (model call → tool use → reasoning → response), its own model selection (a fitness coach on GPT-4o, a research analyst on Claude Opus), and its own memory scope (facts and knowledge entries that belong to that expert alone). Multiple agents can run concurrently — start a research task in one conversation and chat with your fitness coach in another. The system is designed so that higher-level orchestration (Cerebro routing, team coordination) plugs in cleanly on top.

## Design Principles

1. **Backend stays the service layer** — The Python backend owns model inference, memory, persistence, and domain tools. The agent loop orchestrates calls to these services but doesn't duplicate them.
2. **One model truth** — Model configuration, credentials, and inference all route through the existing Python backend. No separate TypeScript model management.
3. **Don't reinvent the agent loop** — pi-agent-core provides a battle-tested agent loop with tool execution, event streaming, cancellation, and message steering. We use it as the foundation, not build from scratch.
4. **Incremental activation** — Each expert gains agent capabilities without breaking existing CRUD, display, and graph features. An expert with no model config still works — it inherits the global selection.
5. **Bounded autonomy** — Agents have explicit turn limits and token budgets. No unbounded loops.
6. **Non-blocking main process** — Agent loops in the Electron main process must never block the UI. All model calls are async HTTP to the Python backend.
7. **Scoped by default** — Every agent action (memory reads, knowledge writes, tool calls) is scoped to the expert that initiated it. No cross-expert leakage without explicit sharing.
8. **Concurrent by design** — Multiple agent runs can execute simultaneously. Each run is an independent `Agent` instance with its own state, abort controller, and event stream.

## Architecture Overview

### Why pi-agent-core

[pi-agent-core](https://www.npmjs.com/package/@mariozechner/pi-agent-core) (`@mariozechner/pi-agent-core`) is the agent SDK from the [pi-mono](https://github.com/badlogic/pi-mono) toolkit. It provides the core agent loop — the cycle of calling a model, parsing tool calls, executing tools, feeding results back, and repeating until the model produces a final response.

| What it gives us | What we'd have to build without it |
|------------------|------------------------------------|
| Agent loop with multi-turn tool execution | Custom async generator with turn tracking |
| `AgentTool<TSchema>` with TypeBox validation | Custom tool definition format + argument validation |
| Event subscription (`agent_start`, `turn_start`, `message_update`, `tool_execution_*`, etc.) | Custom event emitter and event type definitions |
| `abort()` with signal propagation to streamFn and tools | Manual AbortController threading |
| Message steering (`steer()`, `followUp()`) for mid-run injection | Custom message queue system |
| `convertToLlm` / `transformContext` hooks for message pipeline | Custom message transformation |
| State management (`agent.state.messages`, `setModel()`, `setTools()`) | Custom state tracking per run |

The key integration point is **`streamFn`** — the pluggable function that calls the LLM. pi-agent-core defaults to `streamSimple` from `@mariozechner/pi-ai` which calls provider APIs directly. We replace it with a custom `streamFn` that routes through our Python backend's existing SSE endpoints, preserving the single source of truth for credentials and model configuration.

**Dependency:** `@mariozechner/pi-agent-core` (which depends on `@mariozechner/pi-ai` for types and `@sinclair/typebox` for tool parameter schemas).

### Why the Agent Loop Lives in the Main Process

The agent loop runs in the **Electron main process** (TypeScript), not the Python backend. Three reasons:

1. **Native fit.** pi-agent-core is TypeScript — it runs natively in the main process. The main process already manages IPC to the renderer, credentials via OS keychain, the Python backend lifecycle, and filesystem access.

2. **Pluggable streamFn.** pi-agent-core's `streamFn` callback is exactly the seam we need. We implement it as an HTTP call to the Python backend's `/cloud/chat` or `/models/chat` endpoints. The agent loop orchestrates; the backend does inference.

3. **Python backend stays focused.** The backend is a stateless service layer — inference, memory, persistence. Adding an agent loop to the backend would require it to manage long-lived sessions, callback URLs to the renderer, and coordination with the main process for UI updates. That's complexity for no gain.

### System Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Renderer Process                       │
│                                                           │
│  ChatContext ──► ExpertContext ──► MemoryContext            │
│       │              │                                    │
│  MessageList    ExpertTray (manual expert selection)       │
│  ChatInput      ExpertModelSelector                       │
│  ToolCallCard   ExpertMemoryTab                           │
└──────────────────────┬───────────────────────────────────┘
                       │ IPC (agent:run, agent:event, agent:cancel)
                       │
┌──────────────────────┼───────────────────────────────────┐
│               Main Process (Electron)                     │
│                      │                                    │
│              ┌───────┴────────┐                           │
│              │  AgentRuntime  │  ◄── Manages concurrent   │
│              │                │      pi-agent-core Agent  │
│              │                │      instances via Map     │
│              └───────┬────────┘                           │
│                      │                                    │
│         ┌────────────┼────────────┐                       │
│         │            │            │                       │
│   ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐                 │
│   │pi-agent   │ │pi-agent│ │pi-agent   │  (concurrent)   │
│   │Agent      │ │Agent   │ │Agent      │                 │
│   │Expert 1   │ │Expert 2│ │Expert 1   │                 │
│   │           │ │        │ │(new conv) │                 │
│   │streamFn ──┼─┼──►backendStreamFn (shared)             │
│   │tools:     │ │tools:  │ │tools:     │                 │
│   │ recall_*  │ │recall_*│ │ recall_*  │                 │
│   │ save_*    │ │save_*  │ │ save_*    │                 │
│   └─────┬─────┘ └───┬───┘ └─────┬─────┘                 │
│         │            │            │                       │
│         └────────────┼────────────┘                       │
│                      │ HTTP (SSE streaming)               │
│                      │                                    │
└──────────────────────┼───────────────────────────────────┘
                       │
┌──────────────────────┼───────────────────────────────────┐
│              Python Backend (FastAPI)                      │
│                      │                                    │
│    ┌─────────────────┼─────────────────┐                  │
│    │                 │                 │                   │
│  /cloud/chat    /models/chat    /memory/*                  │
│  /cloud/verify  /models/status  /experts/*                 │
│                                 /agent-runs/*              │
│                                 /conversations/*           │
│                                                           │
│              SQLite (all persistence)                      │
└───────────────────────────────────────────────────────────┘
```

### Data Flow for Agent-Powered Chat

When a user sends a message, the flow changes from direct model call to agent-mediated processing. The user selects an expert explicitly via the ExpertTray — or sends a message with no expert selected, which uses the default agent (global model, personal memory scope, no domain tools).

```
User sends message (with optional expert selection)
       │
       v
  Renderer: ChatContext.sendMessage()
       │
       v
  IPC: agent:run { conversationId, content, expertId? }
       │
       v
  Main Process: AgentRuntime.startRun()
       │
       ├──► Resolve agent config:
       │      - expertId provided? Fetch expert, use its model + tools + scope
       │      - No expert? Use global model, personal scope, system tools only
       │
       ├──► Create pi-agent-core Agent instance:
       │      new Agent({
       │        systemPrompt,        // from POST /memory/context
       │        model,               // resolved model identifier
       │        tools,               // AgentTool[] from expert's tool_access
       │        streamFn: backendStreamFn,  // routes to Python backend
       │      })
       │
       ├──► Subscribe to agent events → forward to renderer via IPC
       │
       ├──► agent.prompt(userMessage)
       │      │
       │      ├──► streamFn calls POST /cloud/chat or /models/chat (SSE)
       │      │      ──► message_update events → renderer shows streaming tokens
       │      │
       │      ├──► Model returns tool_calls?
       │      │      YES ──► pi-agent-core executes tools (scoped to expert)
       │      │              ──► tool_execution_* events → renderer shows tool cards
       │      │              ──► Results fed back to model automatically
       │      │              ──► Loop continues
       │      │      NO  ──► agent_end — final response
       │      │
       │      └──► Loop ends (final response or max turns)
       │
       ├──► Persist messages (user + assistant + tool calls)
       │      POST /conversations/{id}/messages
       │
       ├──► Trigger memory extraction (scoped to expert)
       │      POST /memory/extract (fire-and-forget)
       │
       └──► IPC: agent:event { type: 'done' }

  Note: Multiple runs execute concurrently. Each run is an independent
  Agent instance with its own state. Run B starting does not affect Run A.
```

### Concurrency Model

The `AgentRuntime` supports multiple simultaneous agent runs. This is essential for the planned user experience:

- **User switches conversations.** Start a long-running expert task in one conversation, switch to another, chat with a different expert. Both runs execute concurrently.
- **Background processing.** An expert doing multi-turn research doesn't block the user from interacting with other experts.
- **Same expert, different conversations.** Two separate conversations with the Fitness Coach run as independent `Agent` instances — no shared mutable state.

Each run is identified by a unique `runId` and tracked in a `Map`. The renderer subscribes to events for a specific `runId`, so events from concurrent runs don't interfere. Each `Agent` instance has its own message history, tool set, and abort controller.

**Limits:** The runtime caps concurrent runs at a configurable maximum (default 5) to prevent resource exhaustion. If the limit is reached, new runs queue until a slot opens.

## Expert Agent Design

### pi-agent-core Integration

Each expert run creates a fresh pi-agent-core `Agent` instance configured with the expert's system prompt, resolved model, and scoped tools. The `Agent` handles the full agent loop — we configure it and subscribe to its events.

```typescript
// src-main/agents/create-agent.ts

import { Agent } from '@mariozechner/pi-agent-core';
import { backendStreamFn } from './stream-fn';
import { createMemoryTools, createSystemTools } from './tools';

interface ExpertAgentConfig {
  expertId: string | null;
  systemPrompt: string;
  model: ResolvedModel;
  toolAccess: string[];
  maxTurns: number;
  scope: { type: 'personal' | 'expert'; id?: string };
  conversationId: string;
  backendPort: number;
}

function createExpertAgent(config: ExpertAgentConfig): Agent {
  // Build tool set based on expert's tool_access field
  const toolContext = {
    expertId: config.expertId,
    conversationId: config.conversationId,
    scope: config.scope,
    backendPort: config.backendPort,
  };

  const tools = [
    ...createMemoryTools(toolContext),
    ...createSystemTools(toolContext),
  ];

  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model: config.model.modelId,
      tools,
      thinkingLevel: 'off',
    },
    streamFn: backendStreamFn(config.model, config.backendPort),
  });
}
```

### Agent Lifecycle

**Creation:** When a run starts, the runtime:
1. Fetches the expert record from `GET /experts/{id}` (if expert selected)
2. Resolves the model (expert config → global fallback)
3. Fetches the system prompt from `POST /memory/context` with appropriate scope
4. Creates a pi-agent-core `Agent` with the expert's configuration
5. Subscribes to agent events and forwards them to the renderer

**Execution:** The runtime calls `agent.prompt(userMessage)`, which enters pi-agent-core's loop:
1. Calls `streamFn` → our custom implementation streams from the Python backend
2. If the model returns tool calls → pi-agent-core validates arguments via TypeBox schemas, calls each tool's `execute()`, and feeds results back to the model
3. Repeats until the model produces a response with no tool calls
4. `agent_end` event fires with the final messages

**Cleanup:** When a run ends (success, failure, or cancellation):
1. Persists the final messages to the conversation via `POST /conversations/{id}/messages`
2. Logs the run to the `agent_runs` table via `POST /agent-runs`
3. Triggers memory extraction via `POST /memory/extract` with expert scope
4. Sends `agent:event { type: 'done' }` to the renderer
5. Removes the run from the active runs map (freeing the concurrency slot)

### Custom StreamFn (Backend as Model Proxy)

The critical integration piece. pi-agent-core expects a `streamFn` that takes a model identifier and a message context and returns an `AssistantMessageEventStream`. Our implementation makes HTTP requests to the Python backend's existing SSE endpoints instead of calling provider APIs directly.

```typescript
// src-main/agents/stream-fn.ts

import type { StreamFunction } from '@mariozechner/pi-agent-core';
import http from 'node:http';

function backendStreamFn(
  resolvedModel: ResolvedModel,
  backendPort: number,
): StreamFunction {
  return (model, context, options) => {
    const streamPath = resolvedModel.source === 'cloud'
      ? '/cloud/chat'
      : '/models/chat';

    const body: Record<string, unknown> = {
      messages: context.messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map(b => b.text).join(''),
      })),
      stream: true,
    };

    if (resolvedModel.source === 'cloud') {
      body.provider = resolvedModel.provider;
      body.model = resolvedModel.modelId;
    }

    if (context.tools?.length) {
      body.tools = context.tools.map(toProviderToolFormat);
    }

    // Returns an AssistantMessageEventStream that pi-agent-core consumes
    return streamFromBackend(backendPort, streamPath, body, options?.signal);
  };
}
```

The `streamFromBackend` function opens an HTTP connection to the Python backend, parses the SSE stream (`data: {ChatStreamEvent}\n\n`), and translates events into pi-agent-core's `AssistantMessageEvent` format (text deltas, tool call deltas, usage info).

**Why not use `streamSimple` from pi-ai directly?**

1. **Single credential source.** API keys are pushed to the Python backend at startup and updated via `POST /credentials`. Using pi-ai's `streamSimple` would require duplicating credential management in TypeScript.
2. **Existing streaming infrastructure.** The SSE parsing, error handling, and provider normalization in `cloud_providers/adapters.py` already work. The agent loop reuses the same endpoints the chat UI uses today.
3. **Backend can evolve independently.** Adding a new provider means adding a Python adapter. The agent loop doesn't change.

### Tool System

Tools use pi-agent-core's `AgentTool<TSchema>` format with TypeBox schemas for type-safe parameter validation. Each tool defines its schema and an `execute` function that receives validated arguments.

```typescript
// src-main/agents/tools/memory-tools.ts

import { Type } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';

interface ToolContext {
  expertId: string | null;
  conversationId: string;
  scope: { type: 'personal' | 'expert'; id?: string };
  backendPort: number;
}

const recallFactsParams = Type.Object({
  query: Type.String({ description: 'What to search for' }),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 10)' })),
});

function createRecallFactsTool(ctx: ToolContext): AgentTool<typeof recallFactsParams> {
  return {
    name: 'recall_facts',
    label: 'Recall Facts',
    description: 'Search your memory for facts about the user relevant to a query. Returns learned facts sorted by relevance.',
    parameters: recallFactsParams,
    execute: async (toolCallId, params, signal) => {
      const scope = ctx.scope.type;
      const scopeParam = ctx.scope.id ? `&scope_id=${ctx.scope.id}` : '';
      const response = await backendRequest(
        ctx.backendPort,
        'GET',
        `/memory/items?scope=${scope}${scopeParam}&search=${encodeURIComponent(params.query)}&limit=${params.limit ?? 10}`,
        signal,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(response.items) }],
      };
    },
  };
}

const saveFactParams = Type.Object({
  content: Type.String({ description: 'The fact to remember. Use third person ("User prefers...").' }),
});

function createSaveFactTool(ctx: ToolContext): AgentTool<typeof saveFactParams> {
  return {
    name: 'save_fact',
    label: 'Save Fact',
    description: 'Save a new learned fact about the user. Only save durable truths, not transient information.',
    parameters: saveFactParams,
    execute: async (toolCallId, params, signal) => {
      const response = await backendRequest(
        ctx.backendPort,
        'POST',
        '/memory/items',
        signal,
        {
          scope: ctx.scope.type,
          scope_id: ctx.scope.id ?? null,
          content: params.content,
          source_conversation_id: ctx.conversationId,
        },
      );
      return {
        content: [{ type: 'text', text: `Saved: "${params.content}"` }],
      };
    },
  };
}

const saveEntryParams = Type.Object({
  entry_type: Type.String({ description: 'Category (e.g., "run_log", "expense", "check_in")' }),
  occurred_at: Type.Optional(Type.String({ description: 'ISO datetime of when this happened' })),
  summary: Type.String({ description: 'Human-readable one-liner' }),
  data: Type.Record(Type.String(), Type.Unknown(), { description: 'Structured data for this entry' }),
});

function createSaveEntryTool(ctx: ToolContext): AgentTool<typeof saveEntryParams> {
  return {
    name: 'save_entry',
    label: 'Save Entry',
    description: 'Save a structured knowledge entry (event, activity, record). Include all measurable details.',
    parameters: saveEntryParams,
    execute: async (toolCallId, params, signal) => {
      const response = await backendRequest(
        ctx.backendPort,
        'POST',
        '/memory/knowledge',
        signal,
        {
          scope: ctx.scope.type,
          scope_id: ctx.scope.id ?? null,
          entry_type: params.entry_type,
          occurred_at: params.occurred_at ?? new Date().toISOString(),
          summary: params.summary,
          content: JSON.stringify(params.data),
          source: 'chat',
          source_conversation_id: ctx.conversationId,
        },
      );
      return {
        content: [{ type: 'text', text: `Saved: "${params.summary}"` }],
      };
    },
  };
}

const recallKnowledgeParams = Type.Object({
  query: Type.String({ description: 'What to search for' }),
  entry_type: Type.Optional(Type.String({ description: 'Filter by type (e.g., "run_log", "expense")' })),
  limit: Type.Optional(Type.Number({ description: 'Max results (default 15)' })),
});

function createRecallKnowledgeTool(ctx: ToolContext): AgentTool<typeof recallKnowledgeParams> {
  return {
    name: 'recall_knowledge',
    label: 'Recall Knowledge',
    description: 'Search knowledge entries (structured records like run logs, expenses, check-ins) relevant to a query. Returns entries sorted by relevance and recency.',
    parameters: recallKnowledgeParams,
    execute: async (toolCallId, params, signal) => {
      const scope = ctx.scope.type;
      const scopeParam = ctx.scope.id ? `&scope_id=${ctx.scope.id}` : '';
      const typeParam = params.entry_type ? `&entry_type=${params.entry_type}` : '';
      const response = await backendRequest(
        ctx.backendPort,
        'GET',
        `/memory/knowledge?scope=${scope}${scopeParam}${typeParam}&search=${encodeURIComponent(params.query)}&limit=${params.limit ?? 15}`,
        signal,
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(response.entries) }],
      };
    },
  };
}
```

**Tool categories:**

| Category | Tools | Executor |
|----------|-------|----------|
| **Memory** | `recall_facts`, `recall_knowledge`, `save_fact`, `save_entry` | HTTP to backend `/memory/*` |
| **System** | `get_current_time`, `get_user_profile` | Local (main process) |

> **Future extension:** When Cerebro routing ships, routing tools (`route_to_expert`, `respond_directly`) and team tools (`delegate_to_member`, `fan_out`) register into the same tool set via pi-agent-core's `setTools()`. The tool system is inherently extensible — adding a tool means creating an `AgentTool<TSchema>` and including it in the array.

### Session Management

The `AgentRuntime` manages concurrent pi-agent-core `Agent` instances, forwarding their events to the renderer:

```typescript
// src-main/agents/runtime.ts

import { Agent } from '@mariozechner/pi-agent-core';

interface ActiveRun {
  agent: Agent;
  runId: string;
  expertId: string | null;
  conversationId: string;
  unsubscribe: () => void;   // agent.subscribe() cleanup
  startedAt: Date;
}

class AgentRuntime {
  private activeRuns = new Map<string, ActiveRun>();
  private maxConcurrentRuns = 5;

  async startRun(
    webContents: Electron.WebContents,
    conversationId: string,
    content: string,
    expertId?: string,
  ): Promise<string> {
    if (this.activeRuns.size >= this.maxConcurrentRuns) {
      throw new Error('Maximum concurrent agent runs reached');
    }

    const runId = crypto.randomUUID().replace(/-/g, '');

    // 1. Resolve agent config
    const config = await this.resolveConfig(expertId);

    // 2. Create pi-agent-core Agent
    const agent = createExpertAgent({
      expertId: expertId ?? null,
      systemPrompt: config.systemPrompt,
      model: config.model,
      toolAccess: config.toolAccess,
      maxTurns: config.maxTurns,
      scope: expertId
        ? { type: 'expert', id: expertId }
        : { type: 'personal' },
      conversationId,
      backendPort: backendPort!,
    });

    // 3. Subscribe to pi-agent-core events, forward to renderer
    const unsubscribe = agent.subscribe((event) => {
      webContents.send(`agent:event:${runId}`, translateEvent(event));
    });

    this.activeRuns.set(runId, {
      agent, runId, expertId: expertId ?? null,
      conversationId, unsubscribe, startedAt: new Date(),
    });

    // 4. Run the agent (non-blocking)
    agent.prompt(content)
      .then(() => this.finalizeRun(runId, 'completed'))
      .catch((err) => this.finalizeRun(runId, 'failed', err))
      .finally(() => {
        webContents.send(`agent:event:${runId}`, { type: 'done' });
      });

    return runId;
  }

  cancelRun(runId: string): boolean {
    const entry = this.activeRuns.get(runId);
    if (!entry) return false;
    entry.agent.abort();
    return true;
  }

  private async finalizeRun(
    runId: string,
    status: 'completed' | 'failed',
    error?: Error,
  ): Promise<void> {
    const entry = this.activeRuns.get(runId);
    if (!entry) return;

    // Persist messages from agent.state.messages
    await this.persistMessages(entry);

    // Log agent run
    await this.logRun(entry, status, error);

    // Trigger memory extraction
    await this.triggerExtraction(entry);

    // Cleanup
    entry.unsubscribe();
    this.activeRuns.delete(runId);
  }

  getActiveRuns(): Array<{ runId: string; expertId: string | null; conversationId: string }> {
    return Array.from(this.activeRuns.values()).map(e => ({
      runId: e.runId,
      expertId: e.expertId,
      conversationId: e.conversationId,
    }));
  }
}
```

### Event Translation

pi-agent-core emits structured events via `agent.subscribe()`. We translate them into a simpler format for the renderer IPC channel:

```typescript
// src-main/agents/events.ts

function translateEvent(event: AgentEvent): RendererAgentEvent {
  switch (event.type) {
    case 'turn_start':
      return { type: 'turn_start', turn: event.turnNumber };

    case 'message_update':
      if (event.assistantMessageEvent.type === 'text_delta') {
        return { type: 'token', content: event.assistantMessageEvent.delta };
      }
      return null; // Skip non-text events

    case 'tool_execution_start':
      return {
        type: 'tool_start',
        toolName: event.toolName,
        args: event.args,
      };

    case 'tool_execution_end':
      return {
        type: 'tool_result',
        toolName: event.toolName,
        status: event.isError ? 'error' : 'success',
      };

    case 'agent_end':
      return { type: 'final_response', messages: event.newMessages };

    default:
      return null; // Not all events need forwarding
  }
}
```

## Per-Expert Model Selection

### Data Model Changes

New `model_config` column on the `experts` table:

```python
# backend/models.py — Expert model addition

class Expert(Base):
    # ... existing columns ...
    model_config_json: Mapped[str | None] = mapped_column(
        "model_config", Text, nullable=True
    )
    # JSON: {
    #   "source": "cloud",
    #   "provider": "anthropic",
    #   "model_id": "claude-sonnet-4-20250514",
    #   "display_name": "Claude Sonnet"
    # }
    # NULL = inherit global selection
```

**Schema changes:**

```python
# backend/experts/schemas.py — additions

class ExpertModelConfig(BaseModel):
    source: Literal["local", "cloud"]
    provider: Literal["anthropic", "openai", "google"] | None = None
    model_id: str
    display_name: str

class ExpertCreate(BaseModel):
    # ... existing fields ...
    model_config_data: ExpertModelConfig | None = None

class ExpertResponse(BaseModel):
    # ... existing fields ...
    model_config_data: ExpertModelConfig | None = None
```

### Fallback Hierarchy

When resolving which model an agent uses:

```
Expert.model_config (per-expert override)
       │
       └── NULL? ──► Global selectedModel (from ProviderContext)
                         │
                         └── NULL? ──► No model available (error)
```

```typescript
// src-main/agents/model-resolver.ts

interface ResolvedModel {
  source: 'local' | 'cloud';
  provider?: 'anthropic' | 'openai' | 'google';
  modelId: string;
  displayName: string;
}

function resolveModel(
  expert: Expert | null,
  globalModel: SelectedModel | null,
): ResolvedModel | null {
  // 1. Expert-specific override
  if (expert?.modelConfigData) {
    const mc = expert.modelConfigData;
    return {
      source: mc.source,
      provider: mc.provider,
      modelId: mc.modelId,
      displayName: mc.displayName,
    };
  }

  // 2. Global selection
  if (globalModel) {
    return {
      source: globalModel.source,
      provider: globalModel.provider,
      modelId: globalModel.modelId,
      displayName: globalModel.displayName,
    };
  }

  // 3. No model
  return null;
}
```

### UI: ExpertModelSelector

A model selector component appears in the expert detail panel, letting users assign a specific model to an expert or leave it on "Use global default."

```
Expert Detail Panel
===================================================

  [Avatar]  Fitness Coach
  Domain: Health & Fitness
  "Your personal running coach..."

  Model
  ┌─────────────────────────────────────────┐
  │  ○ Use global default (Claude Sonnet)   │
  │  ● Override for this expert             │
  │     ┌─────────────────────────────┐     │
  │     │ GPT-4o                    ▾ │     │
  │     └─────────────────────────────┘     │
  └─────────────────────────────────────────┘

  Memory                             [View →]
  System Prompt                      [Edit →]
  Tools                              [Configure →]
```

The selector only shows models that have valid credentials configured. The dropdown reuses the model list from `ProviderContext.enabledModels`.

## Per-Expert Memory

### Memory Scoping (Using Existing Infrastructure)

The memory system already supports scoping via `scope` + `scope_id` fields on both `memory_items` and `knowledge_entries` tables. Expert-scoped memory requires zero schema migration — only behavioral changes.

| Scope | scope_id | What's stored | When used |
|-------|----------|---------------|-----------|
| `personal` | `NULL` | User-wide facts and entries | Default agent (no expert selected) |
| `expert` | Expert ID | Domain-specific facts and entries | Expert agent runs |
| `team` | Team ID | Shared context across team members | Future: team orchestration |

**Context files** use the `memory:context:expert:{id}` key pattern (already designed in the memory system):

```python
# Key examples
"memory:context:profile"           # Global — always injected
"memory:context:style"             # Global — always injected
"memory:context:expert:a1b2c3"     # Expert-specific — injected when this expert runs
```

### System Prompt Assembly Changes

`recall.py` needs two changes for expert-scoped agents:

1. **Inject the expert's `system_prompt` field** as the base prompt instead of the generic Cerebro personality when running in expert scope.
2. **Include both personal and expert-scoped memory** — an expert should know who the user is (personal profile + style) AND have its own domain knowledge.

```python
# backend/memory/recall.py — modified assemble_system_prompt

async def assemble_system_prompt(
    recent_messages: list[dict] | None,
    scope: str,
    scope_id: str | None,
    db: Session,
) -> MemoryContextResponse:
    sections: list[str] = []
    context_files_used: list[str] = []

    # 1. Base prompt — expert's system_prompt or Cerebro default
    if scope == "expert" and scope_id:
        expert = db.get(Expert, scope_id)
        if expert and expert.system_prompt:
            sections.append(expert.system_prompt)
        else:
            sections.append(BASE_SYSTEM_PROMPT)
    else:
        sections.append(BASE_SYSTEM_PROMPT)

    # 2-6. Profile, Style, Expert context file, Learned facts, Knowledge entries
    # ... (unchanged — already scope-aware) ...
```

This means a Fitness Coach agent gets:
1. Its own system prompt ("You are a running coach who...")
2. The user's profile and style (personal context files)
3. Its own expert context file (training plan, injury history)
4. Its own learned facts (`scope="expert"`, `scope_id=coachId`)
5. Its own knowledge entries (run logs, check-ins)

## Integration with Existing Systems

### Chat Flow Changes

**Before (current):**
```
User → ChatContext.sendMessage → POST /memory/context → POST /cloud/chat → stream to UI
```

**After (agent-powered):**
```
User → ChatContext.sendMessage → IPC agent:run → AgentRuntime → pi-agent-core Agent → stream to UI
```

The renderer no longer calls the model endpoints directly. Instead, it sends an `agent:run` IPC message to the main process, and the `AgentRuntime` creates a pi-agent-core `Agent` instance that handles model calls, tool execution, and event streaming.

**IPC protocol for agent runs:**

```typescript
// Renderer → Main
ipcMain.handle('agent:run', async (event, request: AgentRunRequest) => {
  // Returns runId immediately — the run executes asynchronously
  return runtime.startRun(
    event.sender,
    request.conversationId,
    request.content,
    request.expertId,
  );
});

ipcMain.handle('agent:cancel', async (event, runId: string) => {
  return runtime.cancelRun(runId);  // calls agent.abort()
});

ipcMain.handle('agent:active-runs', async () => {
  return runtime.getActiveRuns();
});

// Main → Renderer (translated pi-agent-core events)
// Channel: `agent:event:${runId}`
type RendererAgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'token'; content: string }
  | { type: 'tool_start'; toolName: string; args: unknown }
  | { type: 'tool_result'; toolName: string; status: 'success' | 'error' }
  | { type: 'final_response'; messages: AgentMessage[] }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'done' };
```

**ChatContext changes:**

```typescript
// src/context/ChatContext.tsx — modified sendMessage

async function sendMessage(content: string) {
  // ... create conversation, add user message (unchanged) ...

  // Get the selected expert (from ExpertTray or null for default)
  const expertId = activeExpertId;

  // Start agent run via IPC
  const runId = await window.cerebro.agentRun({
    conversationId,
    content,
    expertId,
  });

  // Listen for agent events on this run's channel
  const cleanup = window.cerebro.onAgentEvent(runId, (event: RendererAgentEvent) => {
    switch (event.type) {
      case 'token':
        appendToMessage(conversationId, assistantMsgId, event.content);
        break;
      case 'tool_start':
        addToolCall(assistantMsgId, event.toolName, event.args);
        break;
      case 'tool_result':
        updateToolCallStatus(assistantMsgId, event.toolName, event.status);
        break;
      case 'final_response':
        finalizeMessage(conversationId, assistantMsgId);
        break;
      case 'error':
        showError(conversationId, assistantMsgId, event.message);
        break;
      case 'done':
        setIsStreaming(false);
        cleanup();
        break;
    }
  });
}
```

### Expert Management UI Changes

The Experts screen gains new capabilities in each expert's detail panel:

```
Expert Detail Panel (expanded view)
═══════════════════════════════════════════
  [Avatar]  Fitness Coach          [Edit]

  Domain: Health & Fitness
  "Your personal running coach and training planner."

  ┌─ Model ─────────────────────────────┐
  │  ○ Use global (Claude Sonnet)       │
  │  ● Override: GPT-4o                 │
  └─────────────────────────────────────┘

  ┌─ Memory ────────────────────────────┐
  │  Context file: 1 file               │
  │  Learned facts: 24 items            │
  │  Knowledge entries: 89 entries      │
  │                          [View all] │
  └─────────────────────────────────────┘

  ┌─ Recent Runs ───────────────────────┐
  │  Mar 1 — 3 turns, 1,240 tokens      │
  │  Feb 28 — 5 turns, 2,100 tokens     │
  │                        [View all →] │
  └─────────────────────────────────────┘

  System Prompt                  [Edit →]
  Tools: recall_facts, save_entry, ...
```

### Frontend Component Changes

**New components:**

| Component | Location | Purpose |
|-----------|----------|---------|
| `ExpertTray` | `src/components/chat/ExpertTray.tsx` | Horizontal expert pills above ChatInput for manual expert selection |
| `ExpertModelSelector` | `src/components/experts/ExpertModelSelector.tsx` | Per-expert model override selector |
| `ExpertMemoryTab` | `src/components/experts/ExpertMemoryTab.tsx` | Memory viewer scoped to an expert |
| `AgentRunCard` | `src/components/chat/AgentRunCard.tsx` | Inline display of agent run metadata (turns, tools used) |

**ExpertTray interaction:**
- Shows enabled experts as pills in the chat input area
- Clicking a pill selects that expert as the active agent for the next message
- Selected pill is highlighted with the neural cyan accent
- Deselecting returns to default agent behavior (global model, personal scope)
- Selection persists per conversation (remembered when switching back)

## Data Model Changes

### Expert Table Additions

```python
# backend/models.py — Expert model additions

class Expert(Base):
    __tablename__ = "experts"

    # ... all existing columns ...

    # NEW: Per-expert model configuration
    model_config_json: Mapped[str | None] = mapped_column(
        "model_config", Text, nullable=True
    )
    # JSON: {"source": "cloud", "provider": "anthropic", "model_id": "...", "display_name": "..."}
    # NULL = inherit global selection

    # NEW: Max turns for agent loop
    max_turns: Mapped[int] = mapped_column(Integer, default=10)

    # NEW: Token budget per run
    token_budget: Mapped[int] = mapped_column(Integer, default=25000)
```

### New `agent_runs` Table

Tracks every agent execution for the Activity screen and debugging:

```python
# backend/models.py — new model

class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    expert_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"),
        nullable=True, index=True
    )
    conversation_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(20))
        # "running" | "completed" | "failed" | "cancelled"
    turns: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    tools_used: Mapped[str | None] = mapped_column(Text, nullable=True)
        # JSON list of tool names used during the run
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
```

### Message Table Addition

```python
# backend/models.py — Message model addition

class Message(Base):
    __tablename__ = "messages"

    # ... existing columns ...

    # NEW: Which expert produced this message (NULL = default agent)
    expert_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("experts.id", ondelete="SET NULL"), nullable=True
    )

    # NEW: Agent run that produced this message
    agent_run_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True
    )
```

## API Changes

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agent-runs` | Create an agent run record |
| `GET` | `/agent-runs` | List runs (filterable by expert_id, conversation_id, status) |
| `GET` | `/agent-runs/{id}` | Get run details |
| `PATCH` | `/agent-runs/{id}` | Update run status/results |

### Modified Endpoints

| Method | Path | Change |
|--------|------|--------|
| `POST` | `/conversations/{id}/messages` | Accept optional `expert_id` and `agent_run_id` fields |
| `GET` | `/experts/{id}` | Returns new `model_config`, `max_turns`, `token_budget` fields |
| `PATCH` | `/experts/{id}` | Accepts new fields for update |
| `POST` | `/cloud/chat` | Accept optional `tools` parameter for function calling |
| `POST` | `/memory/context` | Uses expert's `system_prompt` when `scope="expert"` |
| `POST` | `/memory/extract` | Expert-scoped extraction stores with `scope="expert"` |

### New IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `agent:run` | Renderer → Main | Start an agent run |
| `agent:cancel` | Renderer → Main | Cancel an active run (calls `agent.abort()`) |
| `agent:active-runs` | Renderer → Main | Get list of active runs |
| `agent:event:{runId}` | Main → Renderer | Translated pi-agent-core events |

## Safety & Guardrails

### Max Turns Limit

Every agent has a `maxTurns` limit (default 10, configurable per expert via the Expert model). pi-agent-core's loop naturally terminates when the model stops requesting tools, but we enforce an upper bound by aborting the agent if it exceeds the turn limit.

### Token Budgets

Each agent has a `tokenBudget` (default 25,000). Tracked via pi-agent-core's `message_end` events which include usage data. When the budget is exhausted, we call `agent.abort()` and return the accumulated response.

### Concurrent Run Limit

The `AgentRuntime` enforces a maximum number of concurrent runs (default 5) to prevent resource exhaustion — each run holds an `Agent` instance with message history, an open HTTP connection to the backend, and tool execution state.

### Main Process Non-Blocking Guarantees

The agent loop is async and all I/O (model calls, tool execution) is non-blocking:

1. **Model calls** are HTTP requests to the Python backend via the custom `streamFn` — async with `AbortSignal`.
2. **Tool execution** is async — each tool's `execute()` receives a signal for cancellation.
3. **pi-agent-core's loop** is promise-based (`agent.prompt()` returns a `Promise`) — it doesn't block the event loop.
4. **Cancellation** is propagated via `agent.abort()`, which triggers the internal `AbortController` signal through to `streamFn` and all tool `execute()` calls.

The Python backend handles the compute-heavy work (inference, embedding computation) in its own process, so the Electron main process stays responsive even with multiple concurrent runs.

### Future: Delegation Guardrails

When Cerebro routing ships, additional guardrails will be needed:
- **Delegation depth limit** — prevents infinite delegation chains (A → B → C → ...)
- **Circular delegation prevention** — tracks the delegation chain, rejects cycles
- **Cross-agent token budget** — parent run's budget covers child delegations

These are out of scope for this design but the `AgentRun` model is ready for them.

## Implementation Phases

### Phase 1: Agent Infrastructure

**Goal:** Establish the pi-agent-core agent loop in the main process, validate the full pipeline from IPC through custom streamFn to Python backend and back to renderer.

**Tasks:**
- Install `@mariozechner/pi-agent-core` and `@sinclair/typebox`
- Create `src-main/agents/` module (stream-fn, create-agent, runtime, events, model-resolver)
- Implement `backendStreamFn` that translates between pi-agent-core's `AssistantMessageEventStream` and the Python backend's `ChatStreamEvent` SSE format
- Implement `AgentRuntime` wrapping pi-agent-core `Agent` instances with concurrency control
- Implement event translation (pi-agent-core events → renderer IPC events)
- Add `agent:run`, `agent:cancel`, `agent:event` IPC handlers in `main.ts`
- Modify `ChatContext.tsx` to use `agent:run` IPC instead of direct streaming
- Add `AgentRun` model to `backend/models.py`
- Add `/agent-runs` CRUD endpoints to backend

**Deliverable:** Chat works exactly as before but routed through pi-agent-core. No user-visible change except the internal plumbing. The agent runs a single turn (no tools yet). Multiple runs can execute concurrently.

### Phase 2: Agent Tools

**Goal:** Add tool support, starting with memory and knowledge tools.

**Tasks:**
- Implement memory tools as `AgentTool<TSchema>` (`recall_facts`, `recall_knowledge`, `save_fact`, `save_entry`)
- Implement system tools (`get_current_time`, `get_user_profile`)
- Expand tool call rendering in `ChatMessage` (existing `ToolCallCard`)
- Modify cloud chat endpoint to accept `tools` parameter and pass to provider adapters
- Handle tool_use responses in cloud provider adapters (Anthropic, OpenAI, Google)
- Verify multi-turn loop works end-to-end (pi-agent-core handles the loop, we just need the streamFn to support tool call responses)

**Deliverable:** In chat, the agent can use tools. Ask "what facts do you know about me?" and the agent calls `recall_facts` and responds with results. Ask "remember that I prefer morning meetings" and it calls `save_fact`.

### Phase 3: Expert Agents

**Goal:** Transform Expert records into runnable agents with per-expert models and memory.

**Tasks:**
- Add `model_config`, `max_turns`, `token_budget` columns to Expert table
- Update expert schemas and CRUD endpoints
- Implement `resolveModel()` with fallback hierarchy
- Modify `recall.py` to inject expert `system_prompt` as base prompt
- Create `ExpertModelSelector` component
- Create `ExpertMemoryTab` component
- Add `expert_id` and `agent_run_id` to Message model
- Implement expert-scoped memory extraction (`scope="expert"`, `scope_id=expertId`)

**Deliverable:** Users can assign a specific model to an expert and chat with it. The expert uses its own system prompt and has its own memory scope. Different experts can use different models.

### Phase 4: Expert Selector + Polish

**Goal:** Ship the expert selection UI and built-in starter experts.

**Tasks:**
- Build `ExpertTray` component (expert pills above ChatInput)
- Wire expert selection into `ChatContext` (pass `expertId` to `agent:run`)
- Create `AgentRunCard` component for inline run metadata display
- Add run history to expert detail panel
- Create built-in starter experts (Executive Assistant, Fitness Coach) with system prompts, tool access, and context file templates
- Performance tuning: connection pooling for backend HTTP calls, event batching
- Error recovery: retry logic for transient failures, graceful degradation when model unavailable
- Complete end-to-end tests

**Deliverable:** Users select experts from the ExpertTray, chat with specialized agents, and see tool usage inline. Built-in experts work out of the box.

## Files Created / Modified

### Files Created

| File | Purpose |
|------|---------|
| `src-main/agents/create-agent.ts` | Factory: creates pi-agent-core Agent per expert config |
| `src-main/agents/stream-fn.ts` | Custom streamFn routing to Python backend SSE endpoints |
| `src-main/agents/runtime.ts` | AgentRuntime (manages concurrent Agent instances) |
| `src-main/agents/events.ts` | Translates pi-agent-core events to renderer IPC format |
| `src-main/agents/model-resolver.ts` | Model resolution with fallback hierarchy |
| `src-main/agents/tools/memory-tools.ts` | Memory AgentTools (recall_facts, recall_knowledge, save_fact, save_entry) |
| `src-main/agents/tools/system-tools.ts` | System AgentTools (get_current_time, get_user_profile) |
| `backend/agent_runs/` | Agent runs module (schemas, router) |
| `src/components/chat/ExpertTray.tsx` | Expert selection pills above ChatInput |
| `src/components/chat/AgentRunCard.tsx` | Inline agent run metadata display |
| `src/components/experts/ExpertModelSelector.tsx` | Per-expert model selector |
| `src/components/experts/ExpertMemoryTab.tsx` | Expert-scoped memory viewer |

### Files Modified

| File | Change |
|------|--------|
| `package.json` | Add `@mariozechner/pi-agent-core`, `@sinclair/typebox` |
| `backend/models.py` | Add `model_config`, `max_turns`, `token_budget` to Expert; add `expert_id`, `agent_run_id` to Message; add `AgentRun` model |
| `backend/main.py` | Import AgentRun model, mount `/agent-runs` router |
| `backend/experts/schemas.py` | Add `ExpertModelConfig`, update `ExpertCreate`/`ExpertUpdate`/`ExpertResponse` |
| `backend/experts/router.py` | Handle `model_config` serialization (add to `_JSON_FIELDS`) |
| `backend/memory/recall.py` | Inject expert `system_prompt` as base prompt when expert-scoped |
| `backend/cloud_providers/schemas.py` | Add optional `tools` field to `CloudChatRequest` |
| `backend/cloud_providers/router.py` | Pass tools to adapter when present |
| `backend/cloud_providers/adapters.py` | Handle tool_use responses in streaming (Anthropic, OpenAI, Google adapters) |
| `src/main.ts` | Register agent IPC handlers, instantiate AgentRuntime |
| `src/context/ChatContext.tsx` | Route messages through `agent:run` IPC, handle agent events |
| `src/types/ipc.ts` | Add agent IPC channel constants and types |
| `src/types/chat.ts` | Add `expertId` and `agentRunId` to Message type |
| `src/types/experts.ts` | Add `modelConfigData`, `maxTurns`, `tokenBudget` to Expert type |
| `src/components/chat/ChatInput.tsx` | Integrate ExpertTray |
| `src/components/chat/ChatMessage.tsx` | Render AgentRunCard |

## Verification

### Phase 1 — Agent Infrastructure
1. Send a message in chat. Verify it routes through the pi-agent-core agent loop and returns a response identical to the current direct-streaming behavior.
2. Cancel a streaming response via `agent.abort()`. Verify the UI shows the partial response.
3. Check `agent_runs` table — verify a run record was created with correct status, turns (1), and token count.
4. Open two conversations. Send a message in each. Verify both agent runs execute concurrently — the second message doesn't wait for the first to finish.

### Phase 2 — Agent Tools
5. Ask "what do you know about me?" — verify the agent calls `recall_facts` and the tool call card appears in the chat.
6. Say "remember that I prefer TypeScript over JavaScript" — verify `save_fact` is called and the fact appears in Settings > Memory > Learned Facts with `scope="personal"`.
7. Verify multi-turn: agent calls a tool, gets results, incorporates them into a natural response (2+ turns in a single run, handled automatically by pi-agent-core's loop).

### Phase 3 — Expert Agents
8. Create a "Fitness Coach" expert with a system prompt. Assign it Claude Sonnet via the ExpertModelSelector. Chat with it — verify it uses Claude Sonnet (not the global model) and responds in character.
9. Chat with the Fitness Coach: "I ran 5K in 28 minutes today." Check Knowledge Entries — verify the entry has `scope="expert"` and the coach's ID as `scope_id`.
10. Change the coach's model to GPT-4o. Send another message — verify the response comes from GPT-4o.
11. Remove the model override (set to "Use global"). Verify the coach falls back to the global model.
12. Run two different expert agents concurrently in separate conversations. Verify their memory scopes don't leak — facts saved by Expert A don't appear in Expert B's recall.

### Phase 4 — Expert Selector + Polish
13. Verify the ExpertTray shows enabled experts as pills. Click one — verify the next message is handled by that expert.
14. Deselect the expert — verify the next message uses the default agent (global model, personal scope).
15. Install built-in Fitness Coach. Verify it has a system prompt, tools configured, and a context file template.
16. Run a 5-turn agent conversation. Check the AgentRunCard displays correct turn count and token usage.
17. Disconnect all models. Send a message — verify graceful degradation (error message, no crash).
