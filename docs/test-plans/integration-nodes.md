# Integration Nodes — Test Plan

Covers the three routine "integration" nodes that are currently live:
**http_request**, **run_command**, **run_claude_code**.

The plan lists *what the production behaviour has to be*. Tests assert
that behaviour; they never paper over a bug. If a test catches a
regression, the fix is in product code — not in the test.

LLM-using tests must request the **`claude-sonnet-4-6`** model per the
user's directive for this test round.

---

## Scope — what "integration" means here

These actions reach outside the routine engine: a network socket
(`http_request`), a subprocess (`run_command`), or the Claude Code CLI
(`run_claude_code`). Coverage at all three layers asserts:

1. **Engine (vitest)** — action-level behaviour under direct invocation:
   validation, SSRF, allowlists, auth schemes, Mustache templating,
   subprocess lifecycle, abort signal.
2. **Frontend** — config-panel behaviour is covered via the e2e renderer
   assertions below. No standalone React-Testing-Library suite exists in
   this repo; panels are interacted with through the live Electron
   renderer via CDP, so the e2e assertions double as the UI regressions.
3. **E2E (Playwright over CDP)** — real DAG, real engine, real subprocess
   or socket. Runs deterministic scenarios so failures point at a product
   bug, not Claude stochasticity.

There is **no Python backend** for these three actions — unlike
`wait_for_webhook` (which uses `/webhooks/*`) or `approval_gate` (which
uses `/engine/approvals`). The "backend" tier is therefore N/A for this
plan; "backend tests" in this document refers to the **engine-level
Node.js tests under `src/engine/__tests__/`** (the closest analogue —
they exercise the runtime that lives in the Electron main process).

---

## 1. HTTP Request

**Action** — `src/engine/actions/http-request.ts`
**UI** — `src/components/screens/routines/StepConfigPanel.tsx` →
`HttpRequestParams`

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| HR-U1 | GET with no body | Returns `{status, body, headers, duration_ms}`. `Content-Type` header NOT auto-set. |
| HR-U2 | POST with JSON body | Auto-sets `Content-Type: application/json` and writes the body to the socket. |
| HR-U3 | Missing URL | Throws `"HTTP request requires a URL"`. |
| HR-U4 | URL is literal `localhost` | Throws `"private/internal addresses are not allowed"`. |
| HR-U5 | URL targets 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0/8 | Each blocked with the same SSRF error. |
| HR-U6 | URL targets `::1`, `fc00::`, `fd00::` | Blocked. |
| HR-U7 | URL is `metadata.google.internal` | Blocked (cloud metadata guard). |
| HR-U8 | URL renders `{{var}}` from `wiredInputs` | Template is expanded before `new URL()`. Confirm by asserting the post-render URL hits SSRF or connects, depending on the expanded value. |
| HR-U9 | URL template resolves to empty string | Same error as HR-U3 — empty after render is still missing. |
| HR-U10 | Response body larger than 10 MB | Stream destroyed, rejects with `"exceeds 10MB"`. |
| HR-U11 | `auth_type: 'bearer'` with `auth_value: 'abc'` | Sends `Authorization: Bearer abc`. |
| HR-U12 | `auth_type: 'basic'`, `auth_value: 'u:p'` | Sends `Authorization: Basic dTpw`. |
| HR-U13 | `auth_type: 'basic'` without `:` | Throws `"username:password"` error. |
| HR-U14 | `auth_type: 'api_key'` with `auth_header: 'X-Foo'`, `auth_value: 'k'` | Sends header `X-Foo: k`. Default header name when blank: `X-API-Key`. |
| HR-U15 | Bearer `auth_value` with `{{token}}` template | Template expanded before the header is set. |
| HR-U16 | Custom header key and value both accept templates | Expanded before send. |
| HR-U17 | Response `Content-Type: application/json` with valid JSON | `body` is parsed object. |
| HR-U18 | Response JSON-typed but unparseable | `body` returned as raw string (no throw). |
| HR-U19 | Response `Content-Type: text/plain` | `body` returned as raw string. |
| HR-U20 | Step aborted via `context.signal` | Rejects with `"Aborted"`. |
| HR-U21 | Timeout exceeded | Rejects with `"timed out after"`. |
| HR-U22 | 4xx/5xx status | Resolves (not rejects) with the status and parsed body — non-2xx is not an error at this layer. |

### UI (`HttpRequestParams`)

| # | Scenario | Expected |
|---|----------|----------|
| HR-UI1 | Panel mounts with default params | Method=GET, empty URL, empty headers, empty body, auth=none, timeout=30. |
| HR-UI2 | URL field loses focus while blank | Red border + `"Required — the request needs a URL."` error. |
| HR-UI3 | Method switched from GET to POST | Body textarea becomes visible. |
| HR-UI4 | Method switched back to GET | Body textarea hidden (body preserved in params). |
| HR-UI5 | Auth type switched to `bearer` | Password-masked value input appears. Help text reads "Authorization: Bearer". |
| HR-UI6 | Auth type switched to `api_key` | Both header-name input and value input appear. Default placeholder reads `X-API-Key`. |
| HR-UI7 | "Add header" button clicked | New empty key/value row added. |
| HR-UI8 | Variable chip clicked while URL focused | Chip's `{{token}}` inserted at URL cursor. |
| HR-UI9 | Variable chip clicked while body focused | Chip inserted into body. |
| HR-UI10 | Variable chip clicked while a header value is focused | Chip inserted into that header's value (not URL/body). |
| HR-UI11 | Header row removed | Row disappears and `params.headers` array shrinks. |

### E2E

| # | Scenario | Expected |
|---|----------|----------|
| HR-E1 | Run routine with `http_request` → local test server | `run_completed`, step status `completed`, output includes `status: 200` and the parsed JSON body. |
| HR-E2 | Routine configured to hit `http://169.254.169.254/` (cloud metadata) | `run_failed`, failure message contains `private/internal addresses`. |
| HR-E3 | Routine: `run_script` emits `{id: 42}` → `http_request` templates the URL with `{{prev.id}}` | The request URL actually contains `42`. Verified by the test server echoing `req.url`. |
| HR-E4 | Routine hits a server that returns 500 | Run still `completed`; the step output is `{status: 500, ...}`. Non-2xx is not a step failure. |

---

## 2. Run Command

**Action** — `src/engine/actions/run-command.ts`
**UI** — `StepConfigPanel.tsx` → `RunCommandParams`

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| RC-U1 | `command: 'echo'`, `args: 'hello world'` | Exit 0, stdout trims to `"hello world"`, `duration_ms >= 0`. |
| RC-U2 | `command: ''` | Throws `"requires a command"`. |
| RC-U3 | `command: 'rm'` | Throws `"not allowed"`. |
| RC-U4 | `command: 'node'` or `'python'` | Throws `"not allowed"`. |
| RC-U5 | `command: '/usr/bin/git'` (has `/`) | Throws `"no paths"`. |
| RC-U6 | `command: '{{name}}'` with `wiredInputs.name = 'echo'` | Still throws `"not allowed"` — command is NOT templated (security guard). |
| RC-U7 | Non-existent working directory | Throws `"does not exist"`. |
| RC-U8 | Command exits non-zero with stderr text | Rejects with `"Command failed (exit N): ..."`. |
| RC-U9 | `env: { PATH: '/tmp/evil' }` | Throws `"Cannot override environment variable"`. Also blocks `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`. |
| RC-U10 | `args: 'hello {{name}}'` with `wiredInputs.name='world'` | Templated before `parseArgs` — stdout is `"hello world"`. |
| RC-U11 | `working_directory: '/tmp/{{slug}}'` expanded to a real dir | Command runs in the expanded directory. |
| RC-U12 | `env: { X: 'from-{{source}}' }`, `source='cerebro'` | Env value passed to subprocess is `'from-cerebro'`. |
| RC-U13 | `args: '"hello world" --flag=1'` | `parseArgs` groups quoted segment into one argv entry. |
| RC-U14 | stdout > 20 lines | Only the first 20 log-streamed, trailing `"... (N more lines)"` logged. Full stdout still in result. |
| RC-U15 | Step aborted via signal | Child killed with SIGTERM; rejects `"Aborted"`. |
| RC-U16 | Timeout exceeded (`timeout: 1`, command sleeps) | Rejects with "Command failed" containing the timeout signal. |

### UI (`RunCommandParams`)

| # | Scenario | Expected |
|---|----------|----------|
| RC-UI1 | Panel mount with default params | Command empty, args empty, working-directory empty, timeout 300. |
| RC-UI2 | Command dropdown lists the full `ALLOWED_COMMANDS` set | 18 entries (git, gh, npm, npx, pip, claude, bun, pnpm, yarn, cargo, make, docker, ls, cat, echo, curl, wget, jq). |
| RC-UI3 | Blur the command select while blank | Red border + `"Required"` error. |
| RC-UI4 | Type a custom (non-allowlisted) command via programmatic state | `"<cmd> (not allowed)"` option present; error reads `"'<cmd>' is not in the allowed list"`. |
| RC-UI5 | Variable chip clicked while args focused | Chip inserted into args textarea. |
| RC-UI6 | Variable chip clicked while working-directory focused | Chip inserted into working-directory input. |
| RC-UI7 | Intro panel copy lists the sandbox rules (no arbitrary binaries, variables allowed) | Rendered text contains `"allowed"`. |

### E2E

| # | Scenario | Expected |
|---|----------|----------|
| RC-E1 | Routine runs `echo "hello e2e"` | `run_completed`, stdout contains `"hello e2e"`, exit_code 0. |
| RC-E2 | Routine configured with `command: 'rm'` | `run_failed`, failure message contains `"not allowed"`. |
| RC-E3 | Routine: `run_script` emits `{target: 'world'}` → `run_command` echoes `hello {{prev.target}}` | stdout is `"hello world"`. |

---

## 3. Claude Code

**Action** — `src/engine/actions/run-claude-code.ts`
**UI** — `StepConfigPanel.tsx` → `ClaudeCodeParams`

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| CC-U1 | `prompt: ''` | Throws `"requires a prompt"`. |
| CC-U2 | `prompt: '{{missing}}'` that renders empty | Same error as CC-U1 — empty after render is missing. |
| CC-U3 | `prompt: '{{q}}'`, `wiredInputs.q='hi'` | Prompt rendered to `'hi'` before subprocess spawn. |
| CC-U4 | `mode: 'plan'` | Prompt prefix is `"Plan the implementation (do NOT write code):"`, `--allowedTools` includes `Read,Glob,Grep` and read-only git Bash. |
| CC-U5 | `mode: 'implement'` | Tools include `Write,Edit,Bash`. |
| CC-U6 | `mode: 'review'` | Prompt prefix is `"Review the following code changes:"`, tools include git-read Bash subcommands. |
| CC-U7 | `mode: 'ask'` (default) | No prefix; tools limited to `Read,Glob,Grep`. |
| CC-U8 | `working_directory: '/tmp/{{slug}}'` expanded | Subprocess cwd is the expanded path. |
| CC-U9 | Claude CLI not installed | Throws `"Claude Code CLI not found"`. |
| CC-U10 | Step aborted via signal | Subprocess killed with SIGTERM; rejects `"Aborted"`. |
| CC-U11 | Timeout exceeded | Subprocess killed; rejects `"timed out after"`. |
| CC-U12 | Non-zero exit with empty stdout | Rejects `"Claude Code failed (exit N)"`. |
| CC-U13 | Environment passed to subprocess | Only `SAFE_ENV_KEYS` present (PATH, HOME, USER, SHELL, LANG, TERM, TMPDIR, XDG_CONFIG_HOME, XDG_DATA_HOME, ANTHROPIC_API_KEY). No leakage of unexpected vars. |

### UI (`ClaudeCodeParams`)

| # | Scenario | Expected |
|---|----------|----------|
| CC-UI1 | Panel mount with default params | Mode=ask, empty prompt, empty working-directory, max_turns 50, timeout 600. |
| CC-UI2 | Mode dropdown lists ask / plan / implement / review in that order | All four rendered with their long labels. |
| CC-UI3 | Mode switched to `implement` | Description text explains file-write access. |
| CC-UI4 | Blur the prompt textarea while blank | Red border + `"Required"` error. |
| CC-UI5 | Variable chip clicked while prompt focused | Inserted at cursor in prompt. |

### E2E

| # | Scenario | Expected |
|---|----------|----------|
| CC-E1 | Routine with `run_claude_code` in `ask` mode and a prompt `"Reply with the single word 'OK'."` using `claude-sonnet-4-6` | `run_completed`; step output's `response` field is a non-empty string containing `OK`. Exit 0. |

**CC-E1 gating** — the test is skipped with a loud message if `claude` is not on the `PATH` inside the Electron process. Production CI must have the CLI installed; skipping locally is acceptable but never silent.

---

## Cross-cutting assertions

1. **Output schemas are stable.** Every action emits a payload that matches its declared `outputSchema`. Downstream `inputMappings` referencing `status`, `body`, `stdout`, `exit_code`, `response` continue to resolve after any change.
2. **Template substitution is consistent.** All three actions use `renderTemplate(…, wiredInputs)` from `src/engine/actions/utils/template.ts`. No action should hand-roll `replace(/{{…}}/g, …)`.
3. **Security invariants.**
   - `http_request` SSRF allowlist: private IPv4 ranges, `::1`, `fc00::/7`, `169.254.169.254`, and `localhost` all rejected before any socket opens.
   - `run_command` allowlist: only `ALLOWED_COMMANDS` accepted. Command name is **not** templated. Path-prefixed commands rejected.
   - `run_claude_code`: only `SAFE_ENV_KEYS` forwarded to the subprocess.
4. **Abort propagation.** Every action respects `context.signal`. Cancelling a run must not leave orphaned sockets or subprocesses.

---

## Non-goals (deliberate)

- **No embeddings, no vector DB** — search/RAG is outside integration-node scope.
- **No coverage of disabled stubs** (`integration_google_calendar`, `integration_slack`, etc.). Those nodes are `isAvailable: false`; we'll write their test plans when they're wired.
- **No load/performance tests** — these are functional correctness tests, not benchmarks.
