# Claude Code CLI - Integration

## Problem Statement

Cerebro's intelligence comes from whatever model the user points it at. A cloud API key gives access to frontier models. A downloaded GGUF gives offline capability. Both work, but both require the user to manage configuration, and both run through Cerebro's custom agent loop — a loop that's good, but not as battle-tested as the agent that powers millions of Claude Code sessions every day.

Claude Code is Anthropic's official CLI agent. It ships with the best system prompts Anthropic has tested, a sophisticated multi-turn tool loop with file editing, bash execution, code search, and web search built in, plus session management, cost controls, and a streaming protocol designed for real-time UI rendering. It runs on the user's machine. It already has authentication. It already works.

If Cerebro can detect Claude Code and hand it the wheel, users get a dramatic intelligence upgrade for free — no API key configuration, no model selection, no setup friction. The user installs Claude Code once, and Cerebro automatically becomes powered by the most capable coding agent available.

No multi-agent framework does this today. OpenAI's Agents SDK is locked to OpenAI's API. LangGraph and CrewAI require explicit model configuration. AutoGen assumes cloud endpoints. Google ADK routes through Gemini. None of them can detect a locally-installed agent runtime and transparently adopt it as the primary brain while preserving their own domain-specific capabilities (memory, experts, team orchestration).

Claude Code Integration makes Cerebro the first desktop AI assistant that automatically discovers and leverages a professional-grade agent runtime when available, falls back gracefully when it isn't, and lets the user switch between modes with a single click.

## Design Principles

1. **Zero-configuration adoption.** If Claude Code is installed, Cerebro detects it at startup and makes it the default. No API key entry, no model selection, no onboarding wizard. The user opens Cerebro and it just works better. If Claude Code isn't installed, nothing changes — the existing cloud/local flow continues without modification.

2. **Additive, not replacement.** Claude Code replaces the agent loop, not the product. Cerebro's memory system, expert knowledge, conversation persistence, and UI all continue to function. Expert knowledge is injected into Claude Code's context so domain-specific intelligence is preserved. The substitution happens at the execution layer, not the application layer.

3. **The system prompt is the bridge.** Cerebro's experts, memory tiers, and domain knowledge enter Claude Code through `--append-system-prompt`. This is additive — Claude Code's own system prompt (which Anthropic continuously improves) stays intact. Cerebro's context sits alongside it. No prompt replacement, no conflict, no maintenance burden when Claude Code updates.

4. **Subprocess isolation.** Claude Code runs as a child process per conversation turn, not as a long-lived service. Each invocation gets clean state. Crashes don't affect Cerebro. Hangs get killed after timeout. The process boundary is the reliability boundary.

5. **Same events, different engine.** Claude Code's streaming NDJSON output is translated into the same `RendererAgentEvent` format that Cerebro's pi-agent-core loop emits. The renderer, ChatContext, message persistence, and tool call cards work identically regardless of which engine produced the events. Zero UI code changes for the streaming path.

6. **Expert knowledge injection over active delegation.** In traditional mode, Cerebro routes to experts via tool calls. In Claude Code mode, expert knowledge is injected directly into the context — system prompts, context files, domain facts — and Claude Code answers using the appropriate expert's persona. This is faster (no sub-agent overhead), more coherent (single conversation thread), and leverages Claude Code's superior intelligence for synthesis. Active delegation via MCP is a Phase 2 enhancement.

## Architecture Overview

```
User sends message
       |
       v
ChatContext.sendMessage() ──> IPC ──> AgentRuntime.startRun()
       |
       v
resolveModel() — 4-tier fallback:
  1. Expert's model_config override
  2. Global selected_model (persisted in settings)
  3. Claude Code (auto-detected, auto-default)    ← NEW
  4. Currently loaded local model

       |
       v
┌──────────────────────────────┬───────────────────────────────┐
│ source: 'claude-code'         │ source: 'local' | 'cloud'      │
├──────────────────────────────┼───────────────────────────────┤
│                              │                               │
│  Assemble system prompt      │  Assemble system prompt       │
│  (is_claude_code=true)       │  (standard assembly)          │
│  → Expert knowledge injected │  → Expert catalog + routing   │
│  → Memory tiers included     │  → Memory tiers included      │
│                              │                               │
│  Spawn child process:        │  createExpertAgent()          │
│  claude -p <prompt>          │  pi-agent-core Agent          │
│    --output-format stream-json│  streamFn → backend SSE      │
│    --append-system-prompt ... │                               │
│    --allowedTools Read,...    │                               │
│    --max-turns 15            │                               │
│                              │                               │
│  ClaudeCodeRunner parses     │  Agent event subscription     │
│  NDJSON → RendererAgentEvent │  → RendererAgentEvent         │
│                              │                               │
└──────────────┬───────────────┴───────────────┬───────────────┘
               │                               │
               v                               v
          Same event pipeline: IPC → ChatContext → MessageList → UI
```

### Routing Decision: Claude Code vs Traditional

The model resolver runs a deterministic fallback chain. Claude Code is step 3 — it wins only when no explicit model has been selected by the user or by an expert's configuration. Users who prefer a specific cloud model can select it once and Claude Code gracefully steps aside.

```
resolveModel(expertModelConfig, backendPort)
  │
  ├─ 1. expertModelConfig is set?
  │     YES → return { source, provider, modelId }     (expert override wins)
  │
  ├─ 2. selected_model setting exists?
  │     YES, source='claude-code' → verify still installed → return or fall through
  │     YES, source='local'|'cloud' → return            (user's explicit choice wins)
  │
  ├─ 3. Claude Code detected on system?
  │     YES → return { source: 'claude-code' }          (auto-default)
  │
  └─ 4. Local model loaded?
        YES → return { source: 'local' }                (last resort)
        NO  → return null → error modal
```

## Knowledge Injection

This is the central design challenge. Cerebro's intelligence layer has two modes that seem incompatible:

- **Traditional mode**: LLM sees expert catalog → decides to delegate → calls `delegate_to_expert` → sub-agent runs with expert's system prompt → result flows back. The routing intelligence lives in the tool loop.

- **Claude Code mode**: Claude Code runs its own tool loop with its own tools (Read, Edit, Bash). It cannot call `delegate_to_expert` because that tool exists in Cerebro's agent system, not in Claude Code's.

The solution is to eliminate the need for active delegation by giving Claude Code all the knowledge it would need to answer as any expert.

### What Gets Injected

When `is_claude_code=True`, the system prompt assembly in `backend/memory/recall.py` changes from routing guidance to knowledge injection:

```
Standard Mode System Prompt:           Claude Code Mode System Prompt:
┌────────────────────────────┐         ┌────────────────────────────┐
│ Identity & Role            │         │ Identity & Role            │
│ ─────────────────────────  │         │ ─────────────────────────  │
│ Expert Catalog             │         │ Expert Catalog             │
│   (names, domains, IDs)    │         │   (names, domains, IDs)    │
│ ─────────────────────────  │         │ ─────────────────────────  │
│ Routing Guidance           │         │ Expert System Prompts      │  ← NEW
│   "delegate using          │         │   (full prompts for top    │
│    delegate_to_expert"     │         │    relevant experts)       │
│ ─────────────────────────  │         │ ─────────────────────────  │
│ Orchestration Guidance     │         │ Expert Context Files       │  ← NEW
│   delegation rules,        │         │   (user-authored domain    │
│   depth limits, etc.       │         │    knowledge per expert)   │
│ ─────────────────────────  │         │ ─────────────────────────  │
│ Memory Tiers               │         │ Persona Guidance           │  ← NEW
│   profile, style, facts,   │         │   "adopt the appropriate   │
│   knowledge entries        │         │    expert's persona"       │
│                            │         │ ─────────────────────────  │
│                            │         │ Memory Tiers               │
│                            │         │   profile, style, facts,   │
│                            │         │   knowledge entries        │
└────────────────────────────┘         └────────────────────────────┘
```

### Why This Works

Claude Code is a frontier-class model (Claude Opus or Sonnet). It can:

1. **Recognize domains.** Given expert descriptions, it identifies which expert's knowledge applies to the user's question — the same capability that lets it route in traditional mode, but used for persona adoption instead of tool calls.

2. **Follow complex system prompts.** Expert system prompts are instructions. Claude Code follows instructions better than any model that would typically run as a delegated expert (often a smaller model or the same cloud model with more overhead).

3. **Synthesize across domains.** When a question spans multiple experts ("How should my fitness plan account for my dietary restrictions?"), Claude Code has both experts' knowledge simultaneously. Traditional delegation would require a team orchestration with sequential context chaining. Knowledge injection handles cross-domain questions natively.

4. **Use its own tools.** After absorbing expert knowledge, Claude Code can enhance answers with real-time web search, read files the user references, or execute code. No delegated expert has these capabilities unless explicitly configured.

### Context Budget Management

Injecting all expert prompts could exhaust context. The assembly function manages this:

- **Expert relevance scoring**: Simple keyword overlap between the user's message and each expert's domain + description. Only the top 5 most relevant expert prompts are included.
- **Truncation**: Expert system prompts are capped at 2000 characters each. Context files at 1500 characters.
- **Total budget**: Expert knowledge injection is capped at 15,000 characters total — roughly 4K tokens, well within Claude's context window even with extensive memory tiers.
- **Graceful overflow**: If the budget is exceeded, experts are included in order of relevance score until the budget is reached. Remaining experts appear only in the catalog (name + description, no full prompt).

## Detection and Auto-Configuration

### Detection Service

Claude Code detection runs in the Electron main process at startup. The detector is a two-step process:

```
Step 1: which claude              → path or not found
Step 2: claude --version          → version string or error
```

Results are cached for the session lifetime and exposed to the renderer via IPC. Re-detection is available for edge cases (user installs Claude Code while Cerebro is running).

```typescript
// src/claude-code/detector.ts

export interface ClaudeCodeInfo {
  status: 'unknown' | 'detecting' | 'available' | 'unavailable' | 'error';
  version?: string;   // e.g. "2.1.63"
  path?: string;      // e.g. "/usr/local/bin/claude"
  error?: string;
}
```

**Important platform detail**: On macOS, Electron apps don't inherit the user's shell PATH by default. The detector resolves this by checking common installation paths (`/usr/local/bin/claude`, `~/.nvm/*/bin/claude`, `~/.npm-global/bin/claude`) in addition to `which`.

### Auto-Selection Logic

On startup, after detection completes:

1. If Claude Code is `available` AND no `selected_model` exists in settings → auto-set to Claude Code.
2. If Claude Code is `available` AND `selected_model` is already set to a cloud/local model → respect the user's choice.
3. If `selected_model` is `claude-code` but detection says `unavailable` → clear selection, fall through to next available model.

This ensures zero-touch adoption for new users while respecting existing preferences.

## Stream Adaptation

Claude Code's `-p` flag with `--output-format stream-json` emits NDJSON (one JSON object per line) with several message types. The `ClaudeCodeRunner` class translates these into Cerebro's `RendererAgentEvent` format.

### Message Type Mapping

```
Claude Code NDJSON                    Cerebro RendererAgentEvent
─────────────────────                 ─────────────────────────
{ type: "system" }                    (no-op, session init)

{ type: "stream_event",
  event: {
    type: "message_start"            { type: "turn_start", turn: N }
  }
}

{ type: "stream_event",
  event: {
    type: "content_block_delta",
    delta: {
      type: "text_delta",            { type: "text_delta", delta: "..." }
      text: "..."
    }
  }
}

{ type: "stream_event",
  event: {
    type: "content_block_start",
    content_block: {
      type: "tool_use",              { type: "tool_start",
      id: "...",                       toolCallId: "...",
      name: "Read"                     toolName: "Read",
    }                                  args: {} }
  }
}

{ type: "assistant",                 { type: "tool_end",
  message: {                           toolCallId: "...",
    content: [                         toolName: "Read",
      { type: "tool_result",           result: "...",
        content: "..." }               isError: false }
    ]
  }
}

{ type: "result",                    { type: "done",
  result: "...",                       runId: "...",
  session_id: "..." }                  messageContent: "..." }
```

### Process Lifecycle

Each message-response cycle spawns one Claude Code process:

```
AgentRuntime.startClaudeCodeRun()
  │
  ├─ Verify cached ClaudeCodeInfo.status === 'available'
  │
  ├─ Assemble system prompt (POST /memory/context with is_claude_code=true)
  │
  ├─ Build prompt string (user message + recent conversation context)
  │
  ├─ Spawn: claude -p <prompt>
  │    --output-format stream-json
  │    --verbose
  │    --append-system-prompt <cerebro_context>
  │    --allowedTools Read,Edit,Write,Bash,Grep,Glob,WebSearch,WebFetch
  │    --max-turns 15
  │    --no-session-persistence
  │    env: { ...process.env, CLAUDECODE: (deleted) }
  │    cwd: os.homedir()
  │
  ├─ ClaudeCodeRunner parses stdout line by line
  │    → Emits RendererAgentEvent for each relevant message
  │    → Accumulates text for final message content
  │
  ├─ On process exit(0): emit 'done' event
  ├─ On process exit(N): emit 'error' event
  └─ On abort(): SIGTERM → 3s → SIGKILL
```

**Critical environment detail**: Claude Code detects nested sessions via the `CLAUDECODE` environment variable. Since Cerebro's Electron main process may have this variable set if Claude Code was used to develop Cerebro itself, the child process environment must explicitly delete `CLAUDECODE` and `CLAUDE_CODE_ENTRY_POINT` to prevent the "nested session" error.

## UI Integration

### Model Selector

The `ModelSelector` dropdown adds a new top section when Claude Code is detected:

```
┌──────────────────────────────────┐
│  AGENT                           │
│  ● Claude Code            v2.1  │  ← violet dot, version badge
│ ─────────────────────────────── │
│  CLOUD MODELS                    │
│  ● Claude Sonnet 4.5        ✓  │
│  ● GPT-4.1                     │
│  ● Gemini 2.5 Pro              │
│ ─────────────────────────────── │
│  LOCAL MODELS                    │
│  ● Gemma 3 4B                   │
│ ─────────────────────────────── │
│  ⚙ Manage models                │
└──────────────────────────────────┘
```

The "Agent" label distinguishes Claude Code from raw models — it's not just a model, it's a complete agent runtime with tools. The violet dot (`bg-violet-400`) provides a distinct visual identity separate from provider brand colors (amber for Anthropic, emerald for OpenAI, blue for Google).

When Claude Code is the active selection, the pill in the chat input shows:

```
● Claude Code ▾
```

When Claude Code is not installed, the section doesn't appear. No "install" prompts in the model selector — that guidance lives in the Integrations screen.

### Integrations Screen

A new `ClaudeCodeCard` component appears at the top of the Models section in the Integrations screen, above the cloud provider cards:

```
┌─────────────────────────────────────────────────────────┐
│  ⬡  Claude Code                          ● Detected    │
│     Full agent with file editing,                       │
│     bash, search, and more                              │
│ ─────────────────────────────────────────────────────── │
│  Version: 2.1.63                                        │
│  Path: /usr/local/bin/claude                            │
│                                                         │
│  Claude Code provides a complete agentic loop with      │
│  powerful built-in tools. When selected, Cerebro        │
│  injects your expert knowledge and memory into Claude   │
│  Code's context for domain-aware responses.             │
│                                                         │
│  [ Select as default ]                                  │
└─────────────────────────────────────────────────────────┘
```

When Claude Code is not installed:

```
┌─────────────────────────────────────────────────────────┐
│  ⬡  Claude Code                      ○ Not installed   │
│     Full agent with file editing,                       │
│     bash, search, and more                              │
│ ─────────────────────────────────────────────────────── │
│  Install Claude Code to unlock the most powerful        │
│  agent experience. No API key needed.                   │
│                                                         │
│  Install Claude Code →                                  │
└─────────────────────────────────────────────────────────┘
```

### Tool Call Cards

Claude Code's tools appear in the chat as tool call cards using the existing `ToolCallCard` component. New entries in the `TOOL_ICONS` map:

| Tool | Icon | Description shown |
|------|------|-------------------|
| Read | FileText | Reading file content |
| Edit | Pencil | Editing file |
| Write | FilePlus | Creating file |
| Bash | Terminal | Running command |
| Grep | Search | Searching code |
| Glob | FolderSearch | Finding files |
| WebSearch | Globe | Searching the web |
| WebFetch | Globe | Fetching page content |
| LSP | Code | Code intelligence |

## Data Flow: Complete Example

**Scenario**: User has a "Fitness Coach" expert with a custom system prompt about workout programming. User sends "What should my workout look like this week?" with Claude Code as the active brain.

```
1. ChatContext.sendMessage("What should my workout look like this week?")
       │
2.     │──> IPC ──> AgentRuntime.startRun(request)
       │
3. resolveModel() → { source: 'claude-code', modelId: 'claude-code' }
       │
4. POST /memory/context {
     messages: [{ role: 'user', content: '...' }],
     scope: 'personal',
     is_claude_code: true,        ← triggers knowledge injection
     model_tier: 'large'
   }
       │
5. Backend assembles enriched system prompt:
   ┌─────────────────────────────────────────────────────┐
   │ ## Your Identity                                    │
   │ You are Cerebro, a personal AI assistant...         │
   │                                                     │
   │ ## Available Experts                                │
   │ - Fitness Coach [ID: abc] (domain: fitness):        │
   │   Personalized workout and nutrition planning       │
   │                                                     │
   │ ## Expert Knowledge: Fitness Coach                  │  ← injected
   │ You are a certified fitness coach specializing      │
   │ in progressive overload and periodization...        │
   │ [user's context file: current split is PPL,         │
   │  bench 185lbs, squat 275lbs, deadlift 315lbs]     │
   │                                                     │
   │ ## Guidance                                         │
   │ When a question matches an expert's domain,         │
   │ adopt their persona and use their knowledge         │
   │ to answer directly.                                 │
   │                                                     │
   │ ## Your Profile                                     │
   │ Name: Alex, 28, intermediate lifter...              │
   │                                                     │
   │ ## Learned Facts                                    │
   │ - Prefers morning workouts (6am)                    │
   │ - Has a minor rotator cuff issue (left shoulder)    │
   │ - Currently in a caloric surplus (bulking phase)    │
   └─────────────────────────────────────────────────────┘
       │
6. startClaudeCodeRun() spawns:
   claude -p "Previous conversation:\n...\n\nCurrent message: What should my workout look like this week?"
     --append-system-prompt <enriched_prompt_above>
     --output-format stream-json
     --verbose
     --allowedTools Read,Edit,Write,Bash,Grep,Glob,WebSearch,WebFetch
     --max-turns 15
     --no-session-persistence
       │
7. Claude Code processes the message:
   - Sees Fitness Coach knowledge in context
   - Adopts fitness coaching persona
   - Considers user's stats, preferences, and shoulder issue
   - Optionally uses WebSearch for latest periodization research
   - Streams response token by token
       │
8. ClaudeCodeRunner translates NDJSON stream:
   stream_event (text_delta) ──> { type: 'text_delta', delta: "Based on your..." }
   stream_event (text_delta) ──> { type: 'text_delta', delta: "current PPL split..." }
   ...
   result ──> { type: 'done', runId: '...', messageContent: '...' }
       │
9. ChatContext receives events via IPC:
   - Appends text deltas to assistant message
   - On done: persists message to database
   - Triggers memory extraction (async)
       │
10. User sees a personalized workout plan that accounts for their
    stats, preferences, shoulder issue, and current training phase.
```

**What's different from traditional mode**: In traditional mode, steps 4-6 would be: assemble standard prompt → create pi-agent-core Agent → LLM calls `delegate_to_expert("abc", ...)` → new sub-run starts → Fitness Coach expert responds → result bubbles back → Cerebro presents it. That's two agent runs, two system prompts, two inference cycles. With Claude Code, it's one process, one inference cycle, and the response is more coherent because the model has direct access to all the context.

## Type System Changes

### Provider Types

```typescript
// src/types/providers.ts

export type ModelSource = 'local' | 'cloud' | 'claude-code';

export type ClaudeCodeStatus = 'unknown' | 'detecting' | 'available' | 'unavailable' | 'error';

export interface ClaudeCodeInfo {
  status: ClaudeCodeStatus;
  version?: string;
  path?: string;
  error?: string;
}
```

### Agent Types

```typescript
// src/agents/types.ts

export interface ResolvedModel {
  source: 'local' | 'cloud' | 'claude-code';
  provider?: string;
  modelId: string;
  displayName: string;
}
```

### IPC Types

```typescript
// src/types/ipc.ts — additions

// In IPC_CHANNELS:
CLAUDE_CODE_DETECT: 'claude-code:detect',
CLAUDE_CODE_STATUS: 'claude-code:status',

// New API interface:
export interface ClaudeCodeAPI {
  detect(): Promise<ClaudeCodeInfo>;
  getStatus(): Promise<ClaudeCodeInfo>;
}

// Added to CerebroAPI:
export interface CerebroAPI {
  // ... existing ...
  claudeCode: ClaudeCodeAPI;
}
```

## Fallback and Error Handling

| Scenario | Behavior |
|----------|----------|
| Claude Code not installed | ModelSelector omits the "Agent" section. ClaudeCodeCard shows install link. Existing cloud/local flow unchanged. |
| Claude Code installed but user prefers cloud model | User selects cloud model once. Selection persists. Claude Code available but not active. |
| Claude Code selected but uninstalled between sessions | Startup detection finds `unavailable`. Selection cleared. Falls through to next available model (cloud or local). |
| Claude Code process crashes mid-response | Non-zero exit code → `error` event emitted → error shown inline in chat. User can retry or switch models. |
| Claude Code process hangs | `--max-turns 15` provides built-in cap. Cancel button calls `abort()` → SIGTERM → 3s → SIGKILL. |
| Claude Code auth expired | Process exits with auth error → error event includes the message. User re-authenticates via `claude` CLI directly. |
| Network offline (Claude Code needs API) | Process exits with connection error → error shown. User can switch to local model for offline use. |

## Phase 2: MCP Bridge (Future)

Knowledge injection handles the majority of expert-domain questions. But some workflows genuinely require active delegation — complex multi-step tasks where different experts need to run independently with their own tool configurations, or team orchestration patterns (sequential pipelines, parallel fan-out) that can't be replicated by persona adoption.

Phase 2 introduces an MCP (Model Context Protocol) bridge that exposes Cerebro's domain tools as MCP tools accessible to Claude Code:

```
claude -p <prompt>
  --mcp-config /tmp/cerebro-mcp-{session}.json
  --append-system-prompt <context>
```

The MCP config points to a stdio-based MCP server that wraps Cerebro's backend API:

```json
{
  "cerebro": {
    "command": "node",
    "args": ["/path/to/cerebro-mcp-bridge.js"],
    "env": {
      "CEREBRO_BACKEND_PORT": "12345",
      "CEREBRO_CONVERSATION_ID": "conv_abc123"
    }
  }
}
```

The MCP server exposes:

| MCP Tool | Maps To | Description |
|----------|---------|-------------|
| `cerebro_list_experts` | `GET /experts` | Query the expert catalog |
| `cerebro_delegate_to_expert` | `AgentRuntime.startRun()` | Run a sub-agent with expert's config |
| `cerebro_recall_memory` | `POST /memory/recall` | Semantic search over learned facts |
| `cerebro_save_fact` | `POST /memory/items` | Store a new learned fact |
| `cerebro_recall_knowledge` | `GET /memory/entries` | Query structured knowledge entries |
| `cerebro_run_routine` | `POST /engine/runs` | Trigger a routine execution |

This gives Claude Code the full power of both worlds: its own tools (file editing, bash, web search) plus Cerebro's domain tools (expert delegation, memory, routines). The knowledge injection from Phase 1 remains as a performance optimization — Claude Code can answer simple domain questions directly from context without the overhead of an MCP tool call.

## Implementation Sequence

| Order | File | Change |
|-------|------|--------|
| 1 | `src/types/providers.ts` | Add `'claude-code'` to ModelSource, add ClaudeCodeInfo type |
| 2 | `src/agents/types.ts` | Extend ResolvedModel.source |
| 3 | `src/types/ipc.ts` | Add IPC channels, ClaudeCodeAPI, extend CerebroAPI |
| 4 | `src/claude-code/detector.ts` | **New** — Detection service |
| 5 | `src/preload.ts` | Add claudeCode IPC bridge |
| 6 | `src/main.ts` | Register IPC handlers, startup detection |
| 7 | `src/claude-code/stream-adapter.ts` | **New** — ClaudeCodeRunner class |
| 8 | `src/agents/model-resolver.ts` | Add claude-code in fallback chain |
| 9 | `src/agents/loop/model-tiers.ts` | Classify claude-code as `'large'` |
| 10 | `src/agents/runtime.ts` | Add `startClaudeCodeRun()` code path |
| 11 | `backend/memory/recall.py` | Knowledge injection in `assemble_system_prompt()` |
| 12 | `backend/memory/router.py` | Accept `is_claude_code` in `/memory/context` |
| 13 | `src/context/ProviderContext.tsx` | claudeCodeInfo state, auto-select |
| 14 | `src/context/ChatContext.tsx` | claude-code validation guard |
| 15 | `src/components/screens/integrations/ClaudeCodeCard.tsx` | **New** — Settings card |
| 16 | `src/components/screens/integrations/ModelsSection.tsx` | Include ClaudeCodeCard |
| 17 | `src/components/chat/ModelSelector.tsx` | Add Claude Code option at top |
| 18 | `src/components/chat/ToolCallCard.tsx` | Icons for Claude Code tools |
