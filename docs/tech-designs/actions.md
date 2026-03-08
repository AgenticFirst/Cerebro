# Actions Tech Design — Routine Canvas

> **Status**: Draft
> **Depends on**: [Routines](routines.md), [Execution Engine](execution-engine.md), [Experts](experts-agentic-system.md), [Memory](memory-system.md)

## Problem

The Routine Canvas is functional but unintuitive. Users coming from n8n or Langflow expect categorized nodes, visual triggers on the canvas, typed connections, and concrete integration nodes (e.g., "Gmail", "Strava", "WhatsApp") — not abstract types like `model_call` or `connector`. The current `NodePalette` is a 180px popup with 4 generic action types. This redesign makes the canvas match modern workflow builders while leveraging Cerebro's unique strengths (Experts, Memory, Cloud Providers).

---

## 1. Action Category Taxonomy

6 categories modeled after n8n and Langflow, adapted for Cerebro's AI-agent identity.

### Category 1: Triggers (teal `#14b8a6`, icon: `Zap`)

Triggers become the **first node on the canvas** (like n8n). One trigger per routine. Cannot be deleted.

| Action | Name | Key Config Fields | Output Data |
|--------|------|-------------------|-------------|
| `trigger_schedule` | Schedule | days (M-Su checkboxes), time (HH:MM picker), timezone | `{ triggered_at, schedule_description }` |
| `trigger_manual` | Manual | _(none — just a "Run Now" button)_ | `{ triggered_at, triggered_by }` |
| `trigger_webhook` | Webhook | path (auto-generated URL), secret (optional auth token) | `{ payload, headers, method }` |
| `trigger_app_event` | App Event | app (dropdown: Gmail, Strava, Calendar...), event | Service-specific payload |

### Category 2: AI (violet `#8b5cf6`, icon: `Brain`)

These nodes use Cerebro's existing cloud providers or local models.

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `ask_ai` | Ask AI | prompt, model, system prompt, temperature, max tokens | Single LLM call |
| `run_expert` | Run Expert | expert, task, context, max turns | Delegates to a Cerebro Expert |
| `classify` | Classify | prompt, categories (label+description pairs), model | AI picks one category from a list |
| `extract` | Extract | prompt, schema (field name + type + description), model | Pulls structured data from unstructured text |
| `summarize` | Summarize | input_field, max_length (short/medium/long), focus, model | Condenses long text |

### Category 3: Knowledge (indigo `#6366f1`, icon: `BookOpen`)

These nodes tap into Cerebro's memory system, web search, and (future) document RAG.

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `search_memory` | Search Memory | query, scope, max results | Queries Cerebro's memory system |
| `search_web` | Search Web | query, max_results, include_ai_answer | Calls Tavily API |
| `search_documents` | Search Documents | query, collection, top_k, similarity_threshold | RAG retrieval (future) |
| `save_to_memory` | Save to Memory | content, scope, type | Persists information to memory |

### Category 4: Integrations (blue `#3b82f6`, icon: `Plug2`)

Each integration is a **specific node** — not a generic "connector" with a dropdown.

| Action | Name | Key Config Fields | Status |
|--------|------|-------------------|--------|
| `http_request` | HTTP Request | method, URL, headers, body, auth, timeout | Available |
| `run_command` | Run Command | command, args, working_directory, timeout, allowed_commands | Available |
| `run_claude_code` | Claude Code | mode (plan/implement/review/ask), prompt, working_directory, allowed_tools, max_turns | Available |
| `integration_google_calendar` | Google Calendar | action, calendar, date range, query filter | Coming Soon |
| `integration_gmail` | Gmail | action, search filter, to/subject/body | Coming Soon |
| `integration_slack` | Slack | action, channel, message text | Coming Soon |
| `integration_whatsapp` | WhatsApp | action, to, message text, type | Coming Soon |
| `integration_github` | GitHub | action, repo, filters | Coming Soon |
| `integration_strava` | Strava | action, activity_id, data to fetch | Coming Soon |
| `integration_notion` | Notion | action, database ID, filters | Coming Soon |

The HTTP Request node is the universal fallback — any API without a dedicated node can be called via HTTP Request.

### Category 5: Logic (slate `#64748b`, icon: `GitBranch`)

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `condition` | Condition | field, operator, value | If/else branching. Two output handles: True and False |
| `loop` | Loop | items_field, variable_name | Iterates over a list |
| `run_script` | Run Script | language, code, inputs | Runs user-authored code (Python/JS) with pipeline data as input |
| `delay` | Delay | duration, unit | Pauses execution |
| `approval_gate` | Approval Gate | summary, timeout | Pauses for human review (already implemented) |
| `wait_for_webhook` | Wait for Webhook | match_path, match_headers, timeout | Pauses until a matching HTTP request arrives |
| `merge` | Merge | strategy, match_field | Combines outputs from parallel branches |

### Category 6: Output (emerald `#10b981`, icon: `ArrowUpRight`)

| Action | Name | Key Config Fields | What It Does |
|--------|------|-------------------|-------------|
| `send_message` | Send Message | message, target | Posts a message in Cerebro's chat |
| `send_notification` | Notification | title, body, urgency | Desktop notification via Electron |
| `send_email` | Send Email | to, subject, body, provider | Sends email via configured provider |
| `webhook_response` | Webhook Response | status_code, body, headers | Returns data to webhook caller |

---

## 2. Deep Dive: New Primitive Actions

Three new action types unlock developer workflows, human-in-the-loop pipelines via external channels, and local tool execution — without requiring API keys or cloud spend.

### 2.1 Run Command (Integrations)

**What it is:** Execute a shell command on the local machine and capture output.

**Why it exists:** Many pipelines need to interact with local tools — `git diff`, `gh pr create`, `npm test`, `python script.py`. Without this, users would have to wrap every CLI tool in an HTTP API.

**Execution model:**
- Spawns a child process via Node `child_process.execFile` (NOT `exec` with a shell — no injection risk)
- Captures stdout and stderr separately
- Respects `StepDefinition.timeoutMs` (default 5 minutes)
- Listens to `context.signal` for cancellation → kills the child process
- Streams stdout lines to `context.log()` so the user sees progress in real time

**Config panel:**
```
┌──────────────────────────────────┐
│  Run Command Configuration       │
├──────────────────────────────────┤
│  COMMAND                         │
│  [gh ▾]                          │
│  (git, gh, npm, node, python,    │
│   claude, or custom path)        │
│                                  │
│  ARGUMENTS                       │
│  ┌──────────────────────────┐    │
│  │ pr create --title        │    │
│  │ "{{ask_ai.response}}"    │    │
│  │ --body "{{review.resp}}" │    │
│  └──────────────────────────┘    │
│                                  │
│  WORKING DIRECTORY               │
│  [/Users/me/projects/my-app]     │
│                                  │
│  ▸ Advanced                      │
│    Timeout: [300] seconds        │
│    Environment Variables:        │
│    ┌──────────┬─────────────┐    │
│    │ Key      │ Value       │    │
│    └──────────┴─────────────┘    │
└──────────────────────────────────┘
```

**Output data:**
```typescript
{
  stdout: string;      // Full stdout
  stderr: string;      // Full stderr
  exit_code: number;   // 0 = success
  duration_ms: number;
}
```

**Security model:**
- `allowed_commands` param: list of permitted executables (defaults to `['git', 'gh', 'npm', 'node', 'python', 'claude']`)
- If the command is not in the allowed list, the action fails immediately
- Arguments are passed as an array (no shell interpolation)
- Working directory must exist and be under the user's home directory
- Environment variables are merged with the current process env (no overwriting PATH or HOME)

**How it interacts with the engine:**
- The action's `execute()` returns a Promise that resolves when the child process exits
- If the exit code is non-zero, the action throws `StepFailedError` — the step's `onError` policy (fail/skip/retry) applies normally
- Long-running commands (e.g., `npm install`) stream stdout via `context.log()`, so the user sees real-time output in the Activity screen and RunLogCard

---

### 2.2 Claude Code (Integrations)

**What it is:** Invoke the locally installed Claude Code CLI (`claude`) to plan, implement, review, or answer questions about code — using the user's existing Claude Code subscription. No API keys needed. No extra cost.

**Why it matters:** Claude Code is already installed on the user's machine and authenticated with its own subscription. Cerebro doesn't need to route through Anthropic's API, manage tokens, or charge the user. It just spawns the CLI and captures the output. This makes Cerebro a **workflow orchestrator** over Claude Code rather than a competitor to it.

**How Claude Code CLI works:**

```bash
# Non-interactive one-shot (prints result to stdout, exits)
claude --print "Plan how to implement user authentication"

# With structured JSON output
claude --print --output-format json "Review this code for security issues"

# With specific tools allowed
claude --print --allowedTools "Read,Glob,Grep" "Find all API endpoints"

# In a specific directory
claude --print -p /path/to/project "What does the auth middleware do?"
```

Key flags:
- `--print` (`-p`): Non-interactive mode. Sends prompt, prints result, exits. Essential for pipeline use.
- `--output-format json`: Returns `{ result: string, cost: {...}, duration_ms: number }` instead of plain text.
- `--allowedTools`: Comma-separated list of tools Claude Code can use (Read, Write, Edit, Glob, Grep, Bash, etc.)
- `--max-turns`: Limit agentic turns (default: until done)
- Working directory determines which project Claude Code operates on.

**Execution model:**
- Spawns `claude` via `child_process.spawn` (not execFile — needs streaming for long runs)
- Uses `--print --output-format json` for structured output
- Streams stderr to `context.log()` (Claude Code prints progress/thinking to stderr)
- Parses JSON from stdout on completion
- Timeout: configurable, defaults to 10 minutes (Claude Code tasks can be long)
- Cancellation: kills the child process on `context.signal` abort

**The four modes:**

| Mode | What the CLI does | When to use in a pipeline |
|------|-------------------|--------------------------|
| `plan` | Reads the codebase, produces a step-by-step implementation plan. Does NOT write code. | Before an approval gate — user reviews the plan |
| `implement` | Reads + writes code. Creates/edits files. | After plan is approved — the actual coding step |
| `review` | Reads the codebase and recent changes, produces a code review. Does NOT write code. | Quality gate before creating a PR |
| `ask` | Answers a question about the codebase. Read-only. | Information gathering (e.g., "list all modified files") |

**Mode → CLI flag mapping:**

| Mode | `--allowedTools` | Prompt prefix |
|------|-----------------|---------------|
| `plan` | `Read,Glob,Grep,Bash(git diff),Bash(git log)` | `"Plan the implementation (do NOT write code): "` |
| `implement` | `Read,Write,Edit,Glob,Grep,Bash` | (user's prompt as-is) |
| `review` | `Read,Glob,Grep,Bash(git diff),Bash(git log),Bash(git status)` | `"Review the following code changes: "` |
| `ask` | `Read,Glob,Grep` | (user's prompt as-is) |

**Config panel:**
```
┌──────────────────────────────────┐
│  Claude Code Configuration       │
├──────────────────────────────────┤
│  MODE                            │
│  ┌──────┐ ┌───────────┐         │
│  │ Plan │ │ Implement │         │
│  └──────┘ └───────────┘         │
│  ┌────────┐ ┌─────┐             │
│  │ Review │ │ Ask │             │
│  └────────┘ └─────┘             │
│                                  │
│  PROMPT                          │
│  ┌──────────────────────────┐    │
│  │ Implement the following  │    │
│  │ plan:                    │    │
│  │ {{plan_step.response}}   │    │
│  └──────────────────────────┘    │
│                                  │
│  PROJECT DIRECTORY               │
│  [/Users/me/projects/my-app]     │
│  [Browse...]                     │
│                                  │
│  ▸ Advanced                      │
│    Max Turns: [50]               │
│    Timeout: [600] seconds        │
│    Additional Allowed Tools:     │
│    [                         ]   │
└──────────────────────────────────┘
```

**Output data:**
```typescript
{
  response: string;     // Claude Code's text output
  cost: {               // Token usage from Claude Code
    input_tokens: number;
    output_tokens: number;
  } | null;
  duration_ms: number;
  files_modified: string[];  // Parsed from Claude Code's output (if available)
  exit_code: number;
}
```

**How it interacts with the engine:**
- Same pattern as `run_command` — long-lived Promise, child process, streaming logs
- The `execute()` function returns when the `claude` process exits
- Claude Code's stderr output (progress, thinking) streams to `context.log()` → visible in Activity screen
- If `claude` is not installed or not found in PATH, the action fails with a clear error: "Claude Code CLI not found. Install it from https://claude.ai/download"
- If `claude` is not authenticated, it fails with: "Claude Code is not authenticated. Run `claude` in your terminal first to log in."

**Detection of Claude Code installation:**
```typescript
// In the action's execute():
const claudePath = await which('claude').catch(() => null);
if (!claudePath) {
  throw new Error('Claude Code CLI not found. Install it from https://claude.ai/download');
}
```

---

### 2.3 Wait for Webhook (Logic)

**What it is:** Pauses pipeline execution until a matching HTTP request arrives at a dynamically registered endpoint. This is the external-channel equivalent of `approval_gate`.

**Why it exists:** `approval_gate` only works through Cerebro's UI — the user clicks approve/deny in the Approvals screen. But many real workflows need to pause for input from **external systems**: a WhatsApp reply, a Slack message, a GitHub webhook, a payment confirmation. `wait_for_webhook` bridges this gap.

**How it works — the full lifecycle:**

```
1. Pipeline reaches wait_for_webhook step
2. Action registers a temporary endpoint on the Python backend:
   POST /webhooks/listen { run_id, step_id, match_path, timeout_seconds }
   → Backend returns { listener_id, endpoint_url }
3. Action emits a "waiting" event (visible in Activity screen)
4. Action's execute() returns a Promise that blocks
5. ... time passes ...
6. External system POSTs to the endpoint URL
7. Backend receives the POST, matches it to the listener, forwards to main process:
   IPC: 'webhook:received' { listener_id, payload, headers }
8. Main process resolves the blocked Promise with the webhook payload
9. Action returns { payload, headers, received_at } as output
10. Pipeline continues — downstream nodes can read {{wait.payload.message}}
```

**The listener infrastructure (Python backend):**

New module: `backend/webhooks/`

```python
# backend/webhooks/router.py

# In-memory listener registry (not persisted — listeners are ephemeral)
active_listeners: dict[str, WebhookListener] = {}

@router.post("/webhooks/listen")
async def register_listener(body: RegisterListenerRequest) -> RegisterListenerResponse:
    """Register a temporary webhook listener for a pipeline step."""
    listener_id = str(uuid4())
    listener = WebhookListener(
        id=listener_id,
        run_id=body.run_id,
        step_id=body.step_id,
        match_path=body.match_path,  # e.g., "/webhook/whatsapp-reply"
        timeout_at=datetime.now() + timedelta(seconds=body.timeout_seconds),
        callback=None,  # Set by the main process via IPC
    )
    active_listeners[listener_id] = listener
    return RegisterListenerResponse(
        listener_id=listener_id,
        endpoint_url=f"http://localhost:{port}/webhooks/catch/{listener_id}",
    )

@router.post("/webhooks/catch/{listener_id}")
async def catch_webhook(listener_id: str, request: Request):
    """Receive an incoming webhook and forward to the waiting pipeline step."""
    listener = active_listeners.get(listener_id)
    if not listener:
        raise HTTPException(404, "No active listener")
    if datetime.now() > listener.timeout_at:
        del active_listeners[listener_id]
        raise HTTPException(410, "Listener expired")

    payload = await request.json() if request.headers.get("content-type") == "application/json" else await request.body()
    headers = dict(request.headers)

    # Forward to main process via the IPC bridge
    # (The main process registered a callback when it created the listener)
    await notify_main_process(listener_id, payload, headers)

    del active_listeners[listener_id]
    return {"received": True}
```

**On the main process side (TypeScript):**

```typescript
// In wait-for-webhook action's execute():
async execute(input: ActionInput): Promise<ActionOutput> {
  const { match_path, timeout } = input.params;
  const timeoutMs = (timeout as number || 3600) * 1000; // default 1 hour

  // 1. Register listener on backend
  const res = await fetch(`http://localhost:${input.context.backendPort}/webhooks/listen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      run_id: input.context.runId,
      step_id: input.context.stepId,
      match_path,
      timeout_seconds: timeoutMs / 1000,
    }),
  });
  const { listener_id, endpoint_url } = await res.json();

  input.context.log(`Waiting for webhook at: ${endpoint_url}`);
  input.context.log(`Timeout: ${timeoutMs / 1000}s`);

  // 2. Return a Promise that blocks until webhook arrives or timeout
  return new Promise((resolve, reject) => {
    // Listen for webhook forwarded from backend
    const handler = (_event: unknown, data: { listener_id: string; payload: unknown; headers: Record<string,string> }) => {
      if (data.listener_id !== listener_id) return;
      ipcMain.removeListener('webhook:received', handler);
      clearTimeout(timer);
      resolve({
        data: {
          payload: data.payload,
          headers: data.headers,
          received_at: new Date().toISOString(),
          endpoint_url,
        },
        summary: `Webhook received at ${endpoint_url}`,
      });
    };

    ipcMain.on('webhook:received', handler);

    // Timeout
    const timer = setTimeout(() => {
      ipcMain.removeListener('webhook:received', handler);
      reject(new Error(`Webhook timeout after ${timeoutMs / 1000}s — no request received at ${endpoint_url}`));
    }, timeoutMs);

    // Cancellation
    input.context.signal.addEventListener('abort', () => {
      ipcMain.removeListener('webhook:received', handler);
      clearTimeout(timer);
      reject(new Error('Run cancelled'));
    });
  });
}
```

**How it relates to `approval_gate`:**

| | `approval_gate` | `wait_for_webhook` |
|---|---|---|
| **Input source** | Cerebro UI (Approvals screen) | External HTTP request |
| **Resolution** | User clicks approve/deny | External system POSTs data |
| **Output** | Pass-through (upstream data) | Webhook payload |
| **Timeout** | Optional | Required (default 1 hour) |
| **Use case** | Human reviews output before proceeding | Pipeline waits for external event |
| **Engine mechanism** | `onApprovalRequired` callback + pending approvals map | Registered webhook listener + IPC forwarding |

**Config panel:**
```
┌──────────────────────────────────┐
│  Wait for Webhook Configuration  │
├──────────────────────────────────┤
│  ENDPOINT PATH                   │
│  ┌──────────────────────────┐    │
│  │ /webhook/whatsapp-reply  │    │
│  └──────────────────────────┘    │
│  Full URL will be shown after    │
│  the listener starts             │
│                                  │
│  TIMEOUT                         │
│  [3600] seconds (1 hour)         │
│                                  │
│  DESCRIPTION                     │
│  ┌──────────────────────────┐    │
│  │ Waiting for user to      │    │
│  │ reply on WhatsApp with   │    │
│  │ plan approval             │    │
│  └──────────────────────────┘    │
│  (Shown in Activity screen       │
│   while waiting)                 │
│                                  │
│  ▸ Match Criteria (optional)     │
│    Header: [X-User-Phone]        │
│    Value:  [+1234567890]         │
└──────────────────────────────────┘
```

**Output data:**
```typescript
{
  payload: unknown;    // The webhook body (JSON or raw)
  headers: Record<string, string>;
  received_at: string; // ISO timestamp
  endpoint_url: string;
}
```

---

### 2.4 Run Script (Logic)

**What it is:** Run a user-authored script (Python or JavaScript) as a pipeline step, with upstream data piped in as input and the script's output available to downstream nodes.

**Why it's in Logic, not Integrations:** `run_command` and `run_claude_code` call external tools — they integrate with something outside Cerebro. `run_script` is the user's own glue code: parsing, reshaping, computing, filtering pipeline data. It replaces the `transformer` action with something far more expressive. It's a programmable Logic node.

**Why it exists:** The `transformer` action (format/extract/filter/merge) covers basic cases, but real pipelines need custom logic: parse a WhatsApp webhook payload into structured fields, compute a score from multiple upstream values, format a PR description with conditional sections, deduplicate a list. Rather than building ever more transformer operations, give the user a code editor.

**Execution model:**
- **Python scripts** run via the Python backend: `POST /scripts/execute` sends the code + input data, the backend executes in a subprocess with a timeout, returns stdout + parsed output
- **JavaScript scripts** run in a Node.js `vm.Script` sandbox in the main process (no filesystem access, no network, no `require`)
- Input data from upstream steps is available as a global variable `input` (an object with all wired inputs)
- The script writes its output by printing JSON to stdout (Python) or assigning to `output` (JS)
- Timeout: default 30 seconds (scripts should be fast glue code, not long-running jobs)

**Example — parsing a WhatsApp webhook payload:**

```python
# Input: raw WhatsApp Business API webhook body
# Available as: input["payload"]

import json

entry = input["payload"]["entry"][0]
change = entry["changes"][0]["value"]
message = change["messages"][0]

output = {
    "from": message["from"],           # "+1234567890"
    "text": message["text"]["body"],    # "Yes, lets do that"
    "timestamp": message["timestamp"],
    "message_id": message["id"],
}

print(json.dumps(output))
```

**Example — building a PR description from multiple upstream outputs:**

```python
plan = input["plan"]["response"]
review = input["review"]["response"]
files = input["implement"]["files_modified"]

file_list = "\n".join(f"- `{f}`" for f in files)

output = {
    "title": plan.split("\n")[0][:70],
    "body": f"""## Plan
{plan}

## Files Changed
{file_list}

## Review
{review}
"""
}

print(json.dumps(output))
```

**Config panel:**
```
┌──────────────────────────────────┐
│  Run Script Configuration        │
├──────────────────────────────────┤
│  LANGUAGE                        │
│  ┌────────┐ ┌──────────────┐    │
│  │ Python │ │ JavaScript   │    │
│  └────────┘ └──────────────┘    │
│                                  │
│  CODE                            │
│  ┌──────────────────────────┐    │
│  │ # Upstream data is in    │    │
│  │ # the `input` dict       │    │
│  │                          │    │
│  │ msg = input["payload"]   │    │
│  │ text = msg["text"]       │    │
│  │                          │    │
│  │ output = {               │    │
│  │   "cleaned": text.strip()│    │
│  │ }                        │    │
│  │ print(json.dumps(output))│    │
│  └──────────────────────────┘    │
│  (Monospace editor, ~15 lines)   │
│                                  │
│  ▸ Advanced                      │
│    Timeout: [30] seconds         │
│    Test Input (JSON): [{ ... }]  │
│    [▶ Test Run]                  │
└──────────────────────────────────┘
```

**Output data:**
```typescript
{
  result: Record<string, unknown>;  // Parsed JSON from stdout
  stdout: string;                   // Raw stdout (if not valid JSON, this is the output)
  stderr: string;                   // Warnings/debug output
  duration_ms: number;
}
```

**Security model:**
- Python: runs in a **subprocess** via the backend, not in the FastAPI process. The subprocess has no access to Cerebro's database, credentials, or backend state. The backend passes only the `input` data as a JSON argument.
- JavaScript: runs in Node's `vm.Script` with a frozen context. No `require`, no `process`, no `fs`, no `fetch`. Only `input`, `output`, `JSON`, `Math`, `Date`, `Array`, `Object`, `String`, `Number`, `RegExp`, `console.log`.
- Both: hard timeout (default 30s, max 5 minutes). Infinite loops are killed.
- Both: stdout is capped at 1MB. Scripts that produce excessive output are truncated.

**Relationship to `transformer`:**

`run_script` is a superset of `transformer`. Every transformer operation (format, extract, filter, merge) can be expressed as a 3-line script. For V1, both coexist — `transformer` stays for backward compatibility with existing routines. Over time, `run_script` replaces it as the recommended way to do custom data processing.

---

### 2.5 How Long-Lived Runs Work

The pipeline in section 5 can run for **hours** — waiting for WhatsApp replies, Claude Code implementing code, user reviewing diffs. This raises questions about engine state management.

**Current state:** The `ExecutionEngine` keeps active runs in memory. The `DAGExecutor` blocks on a Promise during approval gates. This pattern already supports long pauses (approvals can take hours). The same mechanism extends to `wait_for_webhook` and long-running `run_claude_code` steps.

**What stays in memory during a pause:**
- The `DAGExecutor` instance (blocked on a Promise in the current step)
- The `RunScratchpad` (step outputs from completed steps — needed for downstream input resolution)
- The `AbortController` (for cancellation)
- Active webhook listeners (in the Python backend's in-memory registry)

**What's persisted (survives app restart):**
- Run record with status `paused` (via `PATCH /engine/runs/{id}`)
- Step records with status `completed` / `running` (via `PATCH /engine/runs/{id}/steps/{id}`)
- Event buffer (batch-persisted periodically and on finalization)

**Recovery after app restart:**
- Paused runs are NOT automatically resumed — they show as "stale" in Activity
- The existing `POST /engine/runs/recover-stale` endpoint marks them as failed
- Future enhancement: checkpoint the DAG state (which steps completed, their outputs) so runs can resume after restart. This requires serializing the scratchpad to the database. Not in V1.

**Memory concern:** A run waiting on a webhook for 4 hours holds ~10KB in memory (the executor, scratchpad, and listener). With 10 concurrent waiting runs, that's ~100KB — negligible. The bottleneck is not memory but the user's patience.

---

## 3. Worked Example: Strava Running Coach Pipeline

**Intent**: "After every Strava run, analyze my performance against my training plan and send me a WhatsApp message with coaching advice."

```
[Webhook Trigger]  →  [Search Memory]  →  [Run Expert]  →  [Send Message]
  POST /webhook/       "training plan       Running Coach     WhatsApp via
  strava-activity       this week"          + activity data    HTTP Request
                       Scope: Running       + training plan
                       Coach
```

**Data flow:**
1. **Webhook Trigger** receives Strava POST → `{ payload: { distance, pace, duration, heart_rate_avg, ... } }`
2. **Search Memory** queries "training plan this week" scoped to Running Coach → `{ results: [{ content: "Week 12: Easy 10K Mon..." }] }`
3. **Run Expert** delegates to Running Coach with Strava data + memory results → detailed coaching advice
4. **Send Message** via HTTP Request to WhatsApp Business API with expert's response

---

## 4. Worked Example: Morning Briefing Pipeline

**Intent**: "Every weekday at 9 AM, gather my calendar events and unread emails, create an agenda, and notify me."

```
[Schedule]  →  [Google Calendar]  ─┐
 Weekdays      Get Events Today    ├→  [Ask AI]  →  [Notification]
 9:00 AM    →  [Gmail]           ─┘    "Create       "Your Daily
               Get Unread Emails        briefing"     Briefing"
```

Schedule trigger fans out to two integration nodes (Calendar + Gmail) in parallel, then AI summarizes.

---

## 5. Worked Example: Email Auto-Responder with Approval

```
[App Event: Gmail]  →  [Classify]  →  [Condition]
 New Email              urgent/         If urgent? ──┐
                        action/                      │
                        fyi/spam     ┌── False ──┐   └── True ──┐
                                     ▼            │              ▼
                                 [Ask AI]         │          [Ask AI]
                                 "Auto-ack"       │          "Draft reply"
                                     │            │              │
                                     ▼            │              ▼
                                 [Send Email]     │      [Approval Gate]
                                 auto-ack reply   │       "Review draft"
                                                  │              │ (approved)
                                                  │              ▼
                                                  │      [Send Email]
                                                  │       AI draft reply
```

---

## 6. Worked Example: WhatsApp → Claude Code → PR Pipeline

**Intent:** "Send a WhatsApp message to Cerebro with an iOS task. Claude Code plans how to implement it, I receive the plan on WhatsApp, I approve by saying 'Yes, lets do that', Claude Code implements the code, I get a list of implemented files, I can ask for diffs, I approve, a reviewer reviews the code, then a PR is created."

This is the most complex pipeline in Cerebro. It uses 5 of the 6 action categories and demonstrates all three new primitives (`run_claude_code`, `wait_for_webhook`, `run_command`).

### Canvas layout

```
┌─ ⚡ ──────────┐     ┌─ 🔌 ──────────────┐     ┌─ 🔌 ──────────────┐     ┌─ ↗ ──────────────┐
│ Webhook       │     │ Claude Code       │     │ HTTP Request      │     │ Send Message    │
│ ────────────  │────▶│ ──────────────    │────▶│ ──────────────    │────▶│ ──────────────  │
│ POST /webhook │     │ Mode: Plan        │     │ POST WhatsApp     │     │ Cerebro chat:   │
│ /whatsapp     │     │ Prompt: "Plan     │     │ Business API      │     │ "Sent plan to   │
│               │     │  how to implement │     │ Send plan text    │     │  WhatsApp,       │
│ Payload:      │     │  {{trigger        │     │ to user's phone   │     │  waiting..."    │
│ WhatsApp msg  │     │  .payload.text}}" │     │                   │     │                 │
│          [●]  │     │ Dir: /project     │     │              [●]  │     │            [●]  │
└───────────────┘     │              [●]  │     └───────────────────┘     └─────────────────┘
                      └───────────────────┘
                                                        │
                                                        ▼
┌─ ◇ ──────────────┐     ┌─ ◇ ──────────────────┐     ┌─ ◇ ──────────────┐
│ Wait for Webhook │     │ Condition            │     │ Wait for Webhook │
│ ──────────────── │     │ ──────────────────   │     │ ──────────────── │
│ /webhook/        │────▶│ Does reply contain   │  ┌──│ /webhook/        │
│ whatsapp-reply   │     │ "yes"?               │  │  │ whatsapp-reply   │
│                  │     │                      │  │  │                  │
│ "Waiting for     │     │ True ──────────────┐ │  │  │ "Waiting for     │
│  plan approval"  │     │ False ─── [Stop] ┐ │ │  │  │  final approval" │
│             [●]  │     │             [●]  │ │ │  │  │             [●]  │
└──────────────────┘     └──────────────────┘ │ │ │  └──────────────────┘
                                              │ │ │           ▲
                                              ▼ │ │           │
                              ┌─ ↗ ────────────┐│ │           │
                              │ Send Message   ││ │           │
                              │ ──────────────  ││ │           │
                              │ "Cancelled."   ││ │           │
                              └────────────────┘│ │           │
                                                │ │           │
         ┌──────────────────────────────────────┘ │           │
         ▼                                        │           │
┌─ 🔌 ──────────────┐     ┌─ 🔌 ──────────────┐  │  ┌─ 🔌 ──────────────┐
│ Claude Code       │     │ HTTP Request      │  │  │ HTTP Request      │
│ ──────────────    │────▶│ ──────────────    │──┘  │ ──────────────    │
│ Mode: Implement   │     │ POST WhatsApp     │     │ POST WhatsApp     │
│ Prompt: "{{plan   │     │ Send file list:   │     │ "Here are the     │
│  .response}}"     │     │ "Files modified:  │     │  files changed:   │
│ Dir: /project     │     │  {{implement      │     │  {{implement      │
│              [●]  │     │  .files_modified}}│     │  .files_modified}} │
└───────────────────┘     │  Reply to review" │     │  Send 'approve'   │
                          │              [●]  │     │  to continue."    │
                          └───────────────────┘     │              [●]  │
                                                    └──────────────────┘
                                                             │
                                                             ▼
                          ┌─ ◇ ──────────────┐     ┌─ 🔌 ──────────────┐     ┌─ 🔌 ──────────────┐
                          │ Condition         │     │ Claude Code       │     │ Run Command       │
                          │ ──────────────    │────▶│ ──────────────    │────▶│ ──────────────    │
                          │ Reply contains    │     │ Mode: Review      │     │ gh pr create      │
                          │ "approve"?        │     │ "Review all       │     │ --title "{{...}}" │
                          │                   │     │  changes for      │     │ --body "{{review  │
                          │ True ───────────┐ │     │  quality, security│     │  .response}}"     │
                          │ False ─ [Stop]  │ │     │  and correctness" │     │              [●]  │
                          │            [●]  │ │     │ Dir: /project     │     └───────────────────┘
                          └─────────────────┘ │     │              [●]  │              │
                                              │     └───────────────────┘              ▼
                                              │                                ┌─ 🔌 ──────────────┐
                                              │                                │ HTTP Request      │
                                              └───────────────────────────────▶│ ──────────────    │
                                                                               │ POST WhatsApp     │
                                                                               │ "PR created:      │
                                                                               │  {{pr.stdout}}"   │
                                                                               │              [●]  │
                                                                               └───────────────────┘
```

### Step-by-step data flow

| # | Node | Action | What happens | Output |
|---|------|--------|-------------|--------|
| 1 | **Webhook Trigger** | `trigger_webhook` | WhatsApp Business API forwards incoming message to `POST /webhook/whatsapp` | `{ payload: { text: "Add dark mode toggle to settings", from: "+1234567890" } }` |
| 2 | **Claude Code: Plan** | `run_claude_code` | Spawns `claude --print --output-format json "Plan how to implement: Add dark mode toggle..."` in the project directory. Claude Code reads the codebase, produces a plan. **No code is written.** | `{ response: "## Plan\n1. Add ThemeContext...\n2. Create toggle...", files_modified: [], duration_ms: 45000 }` |
| 3 | **HTTP Request: Send Plan** | `http_request` | POSTs to WhatsApp Business API: `{ to: "{{trigger.payload.from}}", text: "Here's my plan:\n\n{{plan.response}}\n\nReply 'Yes' to proceed." }` | `{ status: 200, body: { message_id: "..." } }` |
| 4 | **Send Message** | `send_message` | Posts status to Cerebro chat: "Sent implementation plan to WhatsApp. Waiting for approval..." | — |
| 5 | **Wait for Webhook: Plan Approval** | `wait_for_webhook` | Registers listener at `/webhook/whatsapp-reply`. Pipeline **pauses**. Minutes or hours pass. User replies "Yes, lets do that" on WhatsApp. WhatsApp forwards reply to the listener endpoint. | `{ payload: { text: "Yes, lets do that", from: "+1234567890" } }` |
| 6 | **Condition: Approved?** | `condition` | Checks if `{{wait.payload.text}}` contains "yes" (case-insensitive). | Routes to True (implement) or False (cancel) branch |
| 7 | **Claude Code: Implement** | `run_claude_code` | Spawns `claude --print --output-format json "Implement the following plan: {{plan.response}}"`. Claude Code writes code — creates/edits files. This step can take **5-15 minutes**. Progress streams to Activity screen via `context.log()`. | `{ response: "Done. Modified 4 files...", files_modified: ["src/context/ThemeContext.tsx", "src/components/ui/ThemeToggle.tsx", ...], duration_ms: 480000 }` |
| 8 | **HTTP Request: Send File List** | `http_request` | POSTs to WhatsApp: "Implementation complete! Files modified:\n- src/context/ThemeContext.tsx\n- ...\n\nReply 'approve' to create PR, or ask 'diff ThemeContext' for details." | `{ status: 200 }` |
| 9 | **Wait for Webhook: Review** | `wait_for_webhook` | Pipeline pauses again. User can reply "approve" or ask for diffs. For V1, this is a single-reply wait. (Conversational loops are V2.) | `{ payload: { text: "approve" } }` |
| 10 | **Condition: Approved?** | `condition` | Checks if reply contains "approve". | Routes to True (review) or False (stop) |
| 11 | **Claude Code: Review** | `run_claude_code` | Spawns `claude --print "Review all changes in this project for quality, security, and correctness"`. Read-only — does not modify code. | `{ response: "## Code Review\n\nOverall: Good. Two suggestions:\n1. Add error boundary...\n2. Consider memoizing..." }` |
| 12 | **Run Command: Create PR** | `run_command` | Executes `gh pr create --title "Add dark mode toggle" --body "{{review.response}}"` in the project directory. Requires `gh` CLI installed and authenticated. | `{ stdout: "https://github.com/user/repo/pull/42", exit_code: 0 }` |
| 13 | **HTTP Request: Send PR Link** | `http_request` | POSTs to WhatsApp: "PR created: https://github.com/user/repo/pull/42\n\nReview summary:\n{{review.response}}" | `{ status: 200 }` |

### What makes this pipeline possible

| Primitive | Role in this pipeline |
|-----------|----------------------|
| `trigger_webhook` | Receives WhatsApp messages forwarded by WhatsApp Business API |
| `run_claude_code` | Plans, implements, and reviews code using locally installed CLI — **no API keys, no extra cost** |
| `wait_for_webhook` | Pauses pipeline twice — waiting for plan approval and implementation approval |
| `condition` | Routes based on WhatsApp reply content |
| `run_command` | Creates the GitHub PR via `gh` CLI |
| `http_request` | Sends WhatsApp messages via Business API |

### What this pipeline does NOT do (V1 limitations)

1. **No conversational diff loop.** The user can't say "show me diff for ThemeContext" and get a response back within the pipeline, then ask for another diff. Each `wait_for_webhook` handles one reply. A conversational loop (`wait → respond → wait → ...`) requires a new `conversation_loop` action type (V2).

2. **No automatic WhatsApp message parsing.** The pipeline receives raw webhook payloads. Extracting the message text, sender phone number, etc. depends on the WhatsApp Business API format. An `extract` node before the condition could formalize this.

3. **No resume after app restart.** If Cerebro closes while waiting for a webhook, the run is lost. Checkpoint-based resume is a future enhancement (see section 2.4).

---

## 7. Action Sidebar (replaces NodePalette)

320px right-side sliding panel. Replaces the current 180px bottom-left popup.

**Structure:**
- Header: "Add Node" title with close button
- Search input filtering across all categories by name, description, keywords
- 6 collapsible category groups, each with colored header icon
- Each action item shows icon, name, and description
- "soon" badge on unavailable actions — visible but not draggable

**Interaction:**
- Open via `+` button (bottom-left) or keyboard shortcut `A`
- Drag-and-drop OR click-to-add (adds at viewport center)
- Mutually exclusive with StepConfigPanel (selecting a node closes sidebar; opening sidebar deselects node)

---

## 8. Sticky Notes

Annotation nodes on the canvas.

- Warm semi-transparent yellow background
- No handles — cannot connect to other nodes
- Editable text (double-click to edit inline)
- Resizable via drag handle
- Keyboard shortcut: `Shift+N`
- NOT part of the DAG — filtered out during serialization
- Persisted in `annotations[]` alongside steps in `dag_json`

---

## 9. Node Visual Differentiation

Each category gets a distinct left border + background tint:

| Category | Left Border | Background | Selected Glow |
|----------|------------|------------|---------------|
| Triggers | 4px teal `#14b8a6` | `teal-500/5` | teal glow |
| AI | 4px violet `#8b5cf6` | `violet-500/5` | violet glow |
| Knowledge | 4px indigo `#6366f1` | `indigo-500/5` | indigo glow |
| Integrations | 4px blue `#3b82f6` | `blue-500/5` | blue glow |
| Logic | 4px slate `#64748b` | `slate-400/5` | slate glow |
| Output | 4px emerald `#10b981` | `emerald-500/5` | emerald glow |

Trigger nodes: 260px wide, special layout (shows schedule/URL prominently).
Condition nodes: Two output handles (True/False) instead of one.
All other nodes: 200px wide, standard layout.

---

## 10. Data References Between Nodes (Variable System)

`{{step_name.field}}` syntax in prompt and text fields:

| Expression | Meaning |
|-----------|---------|
| `{{trigger.payload}}` | The trigger node's output |
| `{{trigger.payload.distance}}` | A specific field from the trigger payload |
| `{{search_memory.results}}` | The Search Memory node's results array |
| `{{classify.category}}` | The Classify node's chosen category |
| `{{ask_ai.response}}` | The Ask AI node's text response |
| `{{run_expert.response}}` | The Run Expert node's text response |
| `{{http_request.body}}` | The HTTP Request node's response body |
| `{{claude_code.response}}` | Claude Code's text output |
| `{{claude_code.files_modified}}` | Array of file paths Claude Code modified |
| `{{run_command.stdout}}` | Command's stdout output |
| `{{run_command.exit_code}}` | Command's exit code (0 = success) |
| `{{wait.payload}}` | The webhook body received during a wait |
| `{{wait.payload.text}}` | A specific field from the webhook payload |

Config panels show autocomplete when typing `{{` — listing available upstream node outputs.

---

## 11. Connection Handle Types (Visual Only in V1)

Edges color-coded by source node's output type:

| Handle Type | Color | Source Nodes |
|------------|-------|-------------|
| `message` | Violet `#8b5cf6` | Ask AI, Run Expert, Summarize, Claude Code |
| `data` | Amber `#f59e0b` | Extract, HTTP Request, Run Command, Search Memory, Search Web, integrations |
| `category` | Indigo `#6366f1` | Classify |
| `signal` | Slate `#64748b` | Condition, Loop, Delay, Approval Gate, Wait for Webhook, triggers |

No type enforcement in V1 — any output can connect to any input. Colors are purely visual.

---

## 12. Serialization and Backward Compatibility

`dag_json` evolves from `{ steps: [...] }` to:

```typescript
interface CanvasDefinition {
  steps: StepDefinition[];            // Same as before
  trigger?: TriggerNodeData;          // NEW — trigger node position + config
  annotations?: AnnotationNodeData[]; // NEW — sticky notes
  canvasViewport?: {                  // NEW
    x: number;
    y: number;
    zoom: number;
  };
}
```

All new fields are optional. Old `dag_json` values parse correctly. When opening a routine with old-format `dag_json`, the canvas auto-creates a trigger node from the routine's `trigger_type` field.

---

## 13. Mapping Old Action Types to New

| Old `actionType` | New `actionType` | Category | Notes |
|-----------------|-----------------|----------|-------|
| `model_call` | `ask_ai` | AI | Renamed for clarity |
| `expert_step` | `run_expert` | AI | Renamed for clarity |
| `transformer` | `transform` | Logic | Renamed |
| `connector` | `http_request` | Integrations | Generic → specific |
| `channel` | `send_message` | Output | Renamed for clarity |
| `approval_gate` | `approval_gate` | Logic | Unchanged |

Migration handled transparently in `dagToFlow()`. Old `actionType` values in existing DAGs are mapped to new names on load.

---

## 14. Changes to Existing Routines Tech Design

1. **Reference**: "See `actions.md` for the complete action type taxonomy, canvas UX, and sidebar design."
2. **Updated DAG JSON format**: `CanvasDefinition` as new serialization format (backward-compatible superset).
3. **Trigger-on-canvas**: Triggers represented as canvas nodes. `trigger_type` and `cron_expression` on Routine model remain source of truth, synced bidirectionally.
4. **Variable system**: `{{step_name.field}}` expression syntax.

---

## 15. Files Modified

| File | Change |
|------|--------|
| `src/utils/step-defaults.ts` | `ActionCategory` + `ACTION_CATEGORIES`. New `ActionMeta` fields. All new action types (incl. `run_command`, `run_claude_code`, `wait_for_webhook`). Old type migration map. |
| `src/utils/dag-flow-mapping.ts` | `CanvasDefinition` type. Trigger node + annotation serialization. Old actionType migration. |
| `src/utils/handle-types.ts` | Handle type → color registry. Add `run_command`, `run_claude_code` → `data`, `wait_for_webhook` → `signal`. |
| `src/hooks/useRoutineCanvas.ts` | Trigger node state, sidebar state, sticky note CRUD, category-colored edges. |
| `src/components/screens/routines/RoutineEditor.tsx` | Replace NodePalette → ActionSidebar. Register new node types. Keyboard shortcuts (`A`, `Shift+N`). |
| `src/components/screens/routines/RoutineStepNode.tsx` | Category-aware styling (left border, bg tint, selected glow). Handle colors. Preview text for all action types. |
| `src/components/screens/routines/StepConfigPanel.tsx` | Config forms for all action types incl. Run Command, Claude Code, Wait for Webhook. |
| `src/components/screens/routines/EditorToolbar.tsx` | Trigger pill reads from canvas trigger node. |
| `src/engine/engine.ts` | Register `run_command`, `run_claude_code`, `wait_for_webhook` in `createRegistry()`. Add webhook listener IPC forwarding. |
| `src/engine/actions/index.ts` | Export new action implementations. |

## 16. Files Created

| File | Purpose |
|------|---------|
| `docs/tech-designs/actions.md` | This tech design document |
| `src/components/screens/routines/ActionSidebar.tsx` | Main sidebar (320px, categories, search) |
| `src/components/screens/routines/ActionSidebarItem.tsx` | Draggable item in sidebar |
| `src/components/screens/routines/ActionCategoryGroup.tsx` | Collapsible category section |
| `src/components/screens/routines/TriggerNode.tsx` | ReactFlow node for triggers |
| `src/components/screens/routines/TriggerConfigPanel.tsx` | Config panel for trigger nodes |
| `src/components/screens/routines/StickyNoteNode.tsx` | Annotation node |
| `src/engine/actions/run-command.ts` | `run_command` action — shell command execution with security model |
| `src/engine/actions/run-claude-code.ts` | `run_claude_code` action — Claude Code CLI wrapper (plan/implement/review/ask) |
| `src/engine/actions/wait-for-webhook.ts` | `wait_for_webhook` action — pause until external HTTP request arrives |
| `backend/webhooks/router.py` | Webhook listener registry — register/catch/expire temporary listeners |
| `backend/webhooks/schemas.py` | Pydantic schemas for webhook listener API |

## 17. Files Removed

| File | Reason |
|------|--------|
| `src/components/screens/routines/NodePalette.tsx` | Replaced by ActionSidebar |

---

## 18. Implementation Phases

| Phase | Scope | Size |
|-------|-------|------|
| **A** | Category registry + updated ACTION_META with new action types + migration map | Small |
| **B** | Action Sidebar (replaces NodePalette) with search + categories | Medium |
| **C** | Node visual differentiation (left border, bg tint, handle colors) | Small |
| **D** | Trigger nodes on canvas + TriggerConfigPanel + bidirectional sync | Medium |
| **E** | Sticky notes (StickyNoteNode + Shift+N shortcut) | Small |
| **F** | Variable system (`{{step.field}}` autocomplete in config panels) | Medium |
| **G** | New AI action implementations (Classify, Extract, Summarize) | Medium |
| **H** | New Logic implementations (Condition w/ dual handles, Loop, Delay, Merge) | Medium |
| **I** | HTTP Request action implementation | Medium |
| **J** | Knowledge actions (Search Memory, Search Web, Save to Memory) | Medium |
| **K** | Run Command + Claude Code action implementations | Medium |
| **L** | Wait for Webhook action + backend webhook listener infrastructure | Large |
| **M** | Integration node framework + first integration | Large |

---

## 19. Open Questions

1. **Conversational loops (V2).** The WhatsApp pipeline can't do "ask for diff → get diff → ask for another diff → approve" in a loop. This needs a new `conversation_loop` action type that wraps `wait_for_webhook` + `condition` + response in a repeating construct. Design deferred to V2.

2. **Claude Code SDK vs CLI.** We currently shell out to `claude --print`. The Claude Code Agent SDK (`@anthropic-ai/claude-code`) offers programmatic control (streaming events, tool-level callbacks, mid-run cancellation). Worth evaluating for V2. CLI is simpler and works today.

3. **Run state checkpoint and resume.** Long-running pipelines (hours of WhatsApp waits) are lost on app restart. Serializing the run scratchpad (all completed step outputs) to SQLite would enable resume. Requires: (a) serialize scratchpad to DB on each step completion, (b) deserialize on startup, (c) re-register webhook listeners, (d) resume the executor from the last completed wave. Significant complexity — defer to V2.

4. **Webhook security.** The catch endpoint is unauthenticated in V1. Anyone who discovers the listener URL can trigger the pipeline. For V2: HMAC signature verification (WhatsApp Business API supports this), or a shared secret per listener.

5. **Claude Code authentication detection.** How do we verify Claude Code is installed AND authenticated before the user builds a pipeline? Options: (a) run `claude --version` on app startup and cache result, (b) validate in the Claude Code config panel with a test button, (c) fail fast with a helpful error at execution time. Option (c) is simplest for V1.
