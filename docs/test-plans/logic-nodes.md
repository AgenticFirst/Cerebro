# Logic Nodes — Test Plan

Covers the six routine "logic" nodes: **condition**, **loop**, **delay**,
**approval_gate**, **wait_for_webhook**, **run_script**.

The plan lists *what the production behaviour has to be*. Tests assert that
behaviour; they never paper over a bug. If a test catches a regression, the
fix is in product code — not in the test.

LLM-using tests must request the **`claude-sonnet-4-6`** model per the
user's directive for this test round.

---

## 1. Condition

**Action** — `src/engine/actions/condition.ts`

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| C-U1 | Missing `field` | Throws "Condition requires a field" |
| C-U2 | All 9 operators (`equals`, `not_equals`, `contains`, `not_contains`, `greater_than`, `less_than`, `is_empty`, `is_not_empty`, `matches_regex`) | Each returns correct `passed` + `branch: 'true'|'false'` |
| C-U3 | Dot-path field access (`user.role`) | `evaluated_value` returns the nested value |
| C-U4 | Type coercion: `count=42` equals `'42'` | `passed: true` |
| C-U5 | Regex pattern > 200 chars (ReDoS guard) | `passed: false` even when pattern would otherwise match |
| C-U6 | Invalid regex (`[invalid`) | `passed: false`, does not throw |
| C-U7 | `is_empty` for empty array `[]` | `passed: true` |
| C-U8 | `contains` on object (JSON-stringified) | matches stringified key/value |
| C-U9 | `greater_than` on non-numeric | `passed: false` |
| C-U10 | Output always includes `passed`, `branch`, and `evaluated_value` fields | Shape matches outputSchema |

### UI (`StepConfigPanel.tsx:2334`)

- Intro copy renders and mentions the `true` / `false` branches.
- Required-field error fires on blur of the field input.
- Value input is hidden for `is_empty` / `is_not_empty`, visible for the rest.
- Chip insert strips `{{ }}` since the field is a raw dot-path.

### E2E

- Condition routine with two downstream steps, one wired to `true` branch, the
  other to `false`. Assert only the matching branch runs.

---

## 2. Loop

**Action** — `src/engine/actions/loop.ts` (currently **zero** unit tests)

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| L-U1 | Missing `items_field` | Throws "Loop requires an items_field" |
| L-U2 | Field is not an array (string, number, null, undefined, object) | Throws with `got <type>` detail |
| L-U3 | Field is valid array | `items`, `count`, and `variable_name` returned |
| L-U4 | `variable_name` defaults to `"item"` | Verified |
| L-U5 | Dot-path extraction (`upstream.data.rows`) | Works |
| L-U6 | Empty array | `items: []`, `count: 0` — no error |
| L-U7 | `summary` string contains the count | Observable |

### UI (`StepConfigPanel.tsx:2475`)

- `items_field` is required; blur-then-empty shows error.
- Variable-name regex (`^[A-Za-z_][A-Za-z0-9_]*$`) invalidates digits-first names and spaces.
- Intro copy explains the V1 "passes array through" contract.

### E2E

- Chain `run_script` (produces array) → `loop` → assert loop step completes
  and emits `items` matching the upstream output.

---

## 3. Delay

**Action** — `src/engine/actions/delay.ts`

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| D-U1 | Positive seconds | Waits roughly that long, returns `delayed_ms` + ISO `completed_at` |
| D-U2 | Zero / negative duration | Throws "positive duration" |
| D-U3 | `unit: 'minutes'` / `'hours'` | Converts correctly (verified via fake timers) |
| D-U4 | Aborted signal before start | Throws "Aborted" immediately |
| D-U5 | Aborted signal mid-wait | Throws "Aborted" — timer is cleared |
| D-U6 | `completed_at` is parseable ISO-8601 | `new Date(x)` does not yield Invalid Date |
| D-U7 | `wiredInputs` pass through into `data` | Upstream fields remain |

### UI (`StepConfigPanel.tsx:2596`)

- Live "Total wait" readout updates on duration/unit change.
- Units dropdown shows Seconds/Minutes/Hours.

### E2E

- Delay 1-second step in a routine; assert total elapsed time ≥ 1 s and the
  step completes successfully.

---

## 4. Approval Gate

**Action** — `src/engine/actions/approval-gate.ts`
**Engine wiring** — `src/engine/engine.ts:178–233`

### Expected behaviour

| # | Scenario | Expected |
|---|----------|----------|
| A-U1 | User-authored `params.summary` flows to the POST `/engine/approvals` body | Backend receives the author's text, not the generic fallback |
| A-U2 | User-authored `params.summary` flows to the `approval_requested` event | Event's `summary` field matches the authored text |
| A-U3 | Empty `params.summary` | Engine uses fallback `Step "<name>" requires your approval…` |
| A-U4 | Whitespace-only `params.summary` | Treated as empty → fallback used |
| A-U5 | Approved → step completes, `approval_status: 'approved'` is patched to step record |
| A-U6 | Denied → `StepDeniedError` thrown, downstream steps skipped, run cancelled |
| A-U7 | Validator rejects `approval_gate` with `requiresApproval: false` |
| A-U8 | Action output always carries `wiredInputs` through as `data` |

### Backend (`backend/engine/router.py` via `test_approvals.py`)

- Already covered: CRUD, resolve flow, recover-stale.
- New: POST preserves multi-line user summary verbatim (no truncation), and
  GET echoes it unchanged.

### UI (`StepConfigPanel.tsx:2658`)

- Amber warning intro renders.
- Required-field error on blank summary.

### E2E

- Routine with a single approval gate step. Spy on the approvals pending list,
  resolve approved via backend, assert `run_completed`. Separate test: resolve
  denied, assert `run_cancelled` / `run_failed`.

---

## 5. Wait for Webhook

**Action** — `src/engine/actions/wait-for-webhook.ts` (currently **zero** unit tests)
**Backend router** — `backend/webhooks/router.py` (currently **zero** backend tests)

### Backend (new `backend/tests/test_webhooks.py`)

| # | Scenario | Expected |
|---|----------|----------|
| W-B1 | POST `/webhooks/listen` | Returns `listener_id`, `endpoint_url`, `created_at`; status 200 |
| W-B2 | GET `/webhooks/catch/{id}/status` before payload | `received: false`, `payload: null` |
| W-B3 | POST `/webhooks/catch/{id}` with JSON body | 200 response; next GET returns `received: true` with payload + headers |
| W-B4 | POST `/webhooks/catch/{id}` twice | Second returns 409 (already received) |
| W-B5 | POST to unknown `listener_id` | 404 |
| W-B6 | POST non-JSON body | Captures as `{"raw": "<decoded>"}`, not 500 |
| W-B7 | DELETE `/webhooks/listen/{id}` | 204; subsequent status poll returns 404 |
| W-B8 | Too many active listeners (> `MAX_ACTIVE_LISTENERS`) | 429 on next register |
| W-B9 | Timeout expiry cleans up the listener | Expired listener's status poll returns 404 |

### Frontend unit (new `src/engine/__tests__/wait-for-webhook.test.ts`)

| # | Scenario | Expected |
|---|----------|----------|
| W-U1 | Registers listener with params (match_path / timeout / description) | Fetched POST body matches params |
| W-U2 | Polls until `received: true`, then returns payload + endpoint_url | Happy-path output shape matches outputSchema |
| W-U3 | Abort signal mid-poll | Throws "Aborted", still emits DELETE cleanup |
| W-U4 | Timeout (deadline reached) | Throws "Webhook timeout…" with the configured `timeoutSecs` in the message |
| W-U5 | Listener cleanup fires on success AND on failure (try/finally) | DELETE called exactly once per run |

### E2E

- Create a routine with a `wait_for_webhook` step (2 s timeout). POST to
  the captured endpoint via IPC bridge, assert `run_completed` + payload
  delivered.

---

## 6. Run Script

**Action** — `src/engine/actions/run-script.ts`
**Backend router** — `backend/scripts/router.py` (currently **zero** backend tests)

### Backend (new `backend/tests/test_scripts.py`)

| # | Scenario | Expected |
|---|----------|----------|
| S-B1 | Valid Python, `output["result"] = input["x"] + 1` | `exit_code: 0`, `result` has `"result"` key |
| S-B2 | Empty code | 400 |
| S-B3 | Non-`python` language | 400 |
| S-B4 | Non-zero exit (`raise Exception`) | `exit_code != 0`, `stderr` non-empty, HTTP 200 (engine decides) |
| S-B5 | Script prints to stderr | Returned in `stderr` field |
| S-B6 | Short timeout (< 1 s) on `while True: pass` | `exit_code: 124` + `stderr` mentions timeout |
| S-B7 | `input_data` wired into script | Script can read `input["x"]` |
| S-B8 | Non-JSON stdout | `result` is `{"output": "<raw>"}` |

### Frontend unit (expand `src/engine/__tests__/run-script.test.ts`)

| # | Scenario | Expected |
|---|----------|----------|
| S-U1 | JS: reads wiredInputs, writes to `output`, returns result | ✓ |
| S-U2 | JS: `console.log` captured as `stdout` | ✓ |
| S-U3 | JS: throws inside script → wrapped error | ✓ |
| S-U4 | JS: `require(...)` fails (sandbox escape blocked) | ✓ |
| S-U5 | Empty code throws "requires code" (both languages) | ✓ |
| S-U6 | **New**: Python path calls backend `/scripts/execute` with language+code+input_data+timeout | ✓ |
| S-U7 | **New**: Python non-zero exit bubbles up as thrown error with stderr head | ✓ |
| S-U8 | **New**: JS `input` is a deep clone — mutating it doesn't affect wiredInputs | ✓ |
| S-U9 | **New**: JS code-generation disabled — `new Function('return 1')()` throws | ✓ |

### UI (`StepConfigPanel.tsx:2800`)

- Two-button pill switches between Python and JavaScript.
- Language-aware placeholder in textarea.
- Timeout shows "seconds" suffix.

### E2E

- Create a routine with a single JS `run_script` step that writes
  `output.msg = "hi"`; assert step completes and output flows downstream.

---

## Tooling notes

- **LLM tests**: any routine that uses an LLM (condition-from-classification,
  etc.) MUST request `model: 'claude-sonnet-4-6'` — the current user default
  for this round is Sonnet.
- **Fake timers**: delay tests use `vi.useFakeTimers()` where useful to keep
  suite speed under 2 s total.
- **Mocks**: backend HTTP is faked via `vi.mock('../actions/utils/backend-fetch')`
  (pattern already used by `search-documents.test.ts`).
- **Helpers**: each existing test file ships its own `makeContext()`; new
  files follow that pattern for consistency.

---

## Bug-catching criteria

Tests **must fail** if any of the following regress:

1. `engine.ts` stops passing `params.summary` through to the approval POST body
   or the `approval_requested` event.
2. `readExistingFile` (save-to-memory) or any similar helper starts swallowing
   non-404 errors.
3. `wait-for-webhook` leaks listeners on error paths.
4. `run_script` JS sandbox regains access to `require`, `process`, or Function
   constructors.
5. `delay` stops cleaning up the timer on abort.
6. `condition` evaluates regex patterns > 200 chars (ReDoS regression).
7. `loop` silently accepts a non-array and passes `undefined` / `NaN` downstream.
