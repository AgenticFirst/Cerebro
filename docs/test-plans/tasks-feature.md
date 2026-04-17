# Tasks Feature — Test Plan

Living document tracking test coverage for Cerebro's Tasks feature (Kanban board, expert runs, queued instructions, mentions, project folders, idle recovery).

The Tasks system is a state machine: cards move `backlog → in_progress → to_review → completed`, with `error` as a terminal column. The load-bearing transitions are (a) assigning a task and moving it to `in_progress` causes the assigned expert to start work, and (b) when the expert's run finishes, the task auto-flips to `to_review`. Most tests below exist to lock those two transitions down.

## Running Tests

```bash
# All unit + integration tests (backend + frontend)
npm test

# Backend only
npm run test:backend

# Frontend only
npm run test:frontend

# E2E (requires running app)
CEREBRO_E2E_DEBUG_PORT=9229 npm start     # in one terminal
npm run test:e2e                          # in another
npm run test:e2e:headed                   # with visible browser
```

---

## Backend Tests (`backend/tests/test_tasks.py`)

Each test gets a fresh temp SQLite database via the `client` fixture in `tests/conftest.py`. Target code: `backend/tasks/router.py`, `backend/tasks/schemas.py`, `backend/models.py` (Task/TaskComment/TaskChecklistItem).

### A1 — CRUD & validation

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 1 | `test_create_task_minimal` | `POST /tasks` | Body with only `title` returns 201; defaults: `column=backlog`, `priority=normal`, `position` assigned, `id` present |
| 2 | `test_create_task_full_fields` | `POST /tasks` | All fields (`description_md`, `expert_id`, `parent_task_id`, `priority`, `start_at`, `due_at`, `project_path`, `tags`) round-trip correctly; `tags` deduplicated |
| 3 | `test_create_task_empty_title_rejected` | `POST /tasks` | Blank/whitespace title → 422 |
| 4 | `test_create_task_invalid_column_rejected` | `POST /tasks` | `column="foo"` → 422 |
| 5 | `test_create_task_invalid_priority_rejected` | `POST /tasks` | `priority="critical"` → 422 |
| 6 | `test_create_task_project_path_sandbox_escape` | `POST /tasks` | `project_path="/etc"` or `"../../../"` → 400 from `validate_link_path` |
| 7 | `test_create_task_missing_expert_rejected` | `POST /tasks` | Non-existent `expert_id` → 404 (or documented error) |
| 8 | `test_create_task_missing_parent_rejected` | `POST /tasks` | Non-existent `parent_task_id` → 404 |
| 9 | `test_list_tasks_ordering` | `GET /tasks` | Tasks returned ordered by `column` then `position` |
| 10 | `test_list_tasks_filters` | `GET /tasks?column=...&expert_id=...&parent_task_id=...` | Each filter narrows results correctly |
| 11 | `test_get_task_includes_rollups` | `GET /tasks/{id}` | Response includes `checklist`, `checklist_total`, `checklist_done`, `comment_count`; 404 on missing |
| 12 | `test_stats_all_columns` | `GET /tasks/stats` | Returns counts for all 5 columns including zeros |
| 13 | `test_patch_task_updates_fields` | `PATCH /tasks/{id}` | Title/description/priority/dates/tags/project_path updates; `updated_at` bumped |
| 14 | `test_patch_task_reassign_expert_logs_system_comment` | `PATCH /tasks/{id}` | Changing `expert_id` writes a system comment; clearing it (→ null) unassigns |
| 15 | `test_patch_task_cannot_change_column` | `PATCH /tasks/{id}` | `column` in PATCH body is ignored (must use `/move`) |
| 16 | `test_delete_task_cascades` | `DELETE /tasks/{id}` | Comments + checklist items removed; subtasks' `parent_task_id` handled per spec |

### A2 — Column transitions (`POST /tasks/{id}/move`)

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 17 | `test_move_backlog_to_in_progress_no_started_at` | `POST /tasks/{id}/move` | Manual move to `in_progress` does NOT set `started_at` (only `run_started` does) |
| 18 | `test_move_to_completed_sets_completed_at` | `POST /tasks/{id}/move` | Moving to `completed` sets `completed_at` |
| 19 | `test_move_invalid_column_rejected` | `POST /tasks/{id}/move` | `column="nope"` → 422 |
| 20 | `test_move_preserves_position_ordering` | `POST /tasks/{id}/move` | Reordering within a column updates only `position`, not timestamps |
| 21 | `test_move_out_of_in_progress_run_id_policy` | `POST /tasks/{id}/move` | Documents whether `run_id` is cleared on manual move out of `in_progress`; locks behavior in |

### A3 — Run-event state machine (`POST /tasks/{id}/run-event`) — CRITICAL

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 22 | `test_run_started_flips_to_in_progress` | `POST /tasks/{id}/run-event` | `event=run_started`: column → `in_progress`, `run_id` set, `started_at` set, system comment "Expert started working" |
| 23 | `test_run_started_creates_or_reuses_run_record` | `POST /tasks/{id}/run-event` | Creates a `RunRecord` if absent; reuses an existing one by id |
| 24 | `test_run_completed_flips_to_to_review` | `POST /tasks/{id}/run-event` | `event=run_completed`: column → `to_review`, `completed_at` set, `RunRecord.status=completed`, system comment "Expert finished — ready for review". **Load-bearing.** |
| 25 | `test_run_failed_flips_to_error` | `POST /tasks/{id}/run-event` | column → `error`, `last_error` captured, `RunRecord.status=failed` |
| 26 | `test_run_cancelled_flips_to_error` | `POST /tasks/{id}/run-event` | column → `error`, `last_error="Run was cancelled"`, `RunRecord.status=cancelled` |
| 27 | `test_run_event_missing_task_returns_404` | `POST /tasks/{id}/run-event` | Unknown task id → 404 |
| 28 | `test_run_event_stale_run_id_policy` | `POST /tasks/{id}/run-event` | Mismatched `run_id` (event vs task) is ignored/overridden/409 per spec |
| 29 | `test_double_run_completed_idempotent` | `POST /tasks/{id}/run-event` | Firing `run_completed` twice: no duplicate system comments, no column regression |
| 30 | `test_run_completed_after_error_does_not_resurrect` | `POST /tasks/{id}/run-event` | Task in `error` does not bounce back to `to_review` on late `run_completed` |

### A4 — Cancel & hard reset

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 31 | `test_cancel_in_progress_returns_to_backlog` | `POST /tasks/{id}/cancel` | column → `backlog`, `run_id=None`, system comment added |
| 32 | `test_cancel_backlog_task_policy` | `POST /tasks/{id}/cancel` | Cancelling a non-running task is rejected or no-op per spec |
| 33 | `test_recover_stale_run_transitions_to_error` | `POST /engine/runs/recover-stale` | Stuck task (`in_progress` + stale `run_id`) moves to `error` with descriptive `last_error` |
| 34 | `test_hard_reset_discards_pending_instructions` | `POST /tasks/{id}/cancel` | Pending queued comments are set to `discarded` when parent is reset/cancelled |

### A5 — Comments & queued instructions

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 35 | `test_create_comment_plain` | `POST /tasks/{id}/comments` | `kind="comment"` persists with `queue_status=None` |
| 36 | `test_create_instruction_queues_when_running` | `POST /tasks/{id}/comments` | `kind="instruction"` on `in_progress` + `run_id` → `queue_status="pending"`, `pending_expert_id` set |
| 37 | `test_create_instruction_on_idle_task_policy` | `POST /tasks/{id}/comments` | Instruction on backlog/idle task: rejected or persisted without pending (locked to spec) |
| 38 | `test_queue_status_delivered_sets_triggered_run_id` | `PATCH /tasks/{id}/comments/{cid}/queue-status` | Transition to `delivered` sets `triggered_run_id` |
| 39 | `test_queue_status_discarded_irreversible` | `PATCH /tasks/{id}/comments/{cid}/queue-status` | `discarded` cannot transition back to `pending` |
| 40 | `test_delete_task_removes_comments` | `DELETE /tasks/{id}` | Comments cascade-deleted |
| 41 | `test_list_comments_ordering` | `GET /tasks/{id}/comments` | Mixed system/user/instruction comments returned ordered by `created_at` |

### A6 — Checklist

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 42 | `test_checklist_crud` | `POST/PATCH/DELETE /tasks/{id}/checklist[/{item_id}]` | Create, toggle `is_done`, reorder `position`, delete |
| 43 | `test_checklist_promote_creates_task` | `POST /tasks/{id}/checklist/{item_id}/promote` | New `Task` created in `backlog`; `promoted_task_id` linked; item flagged/removed per spec |
| 44 | `test_checklist_counts_on_task_get` | `GET /tasks/{id}` | `checklist_total` / `checklist_done` reflect current item states |

### A7 — Subtasks

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 45 | `test_subtask_filter` | `GET /tasks?parent_task_id=<id>` | Only children of that parent returned |
| 46 | `test_delete_parent_subtask_policy` | `DELETE /tasks/{id}` | Parent deletion either cascades children or orphans them; behavior locked in |

---

## Frontend Unit Tests (Vitest)

Target: `src/context/TaskContext.tsx`, `src/lib/mentions.ts`, Kanban/Task components. `window.cerebro` is mocked via a local shim set up in each test file.

### B1 — `src/lib/__tests__/mentions.test.ts`

| # | Test | Verifies |
|---|------|----------|
| 1 | `resolveMentions matches formal tokens` | `@[Name](expert:id)` parsed with correct start/end indices |
| 2 | `resolveMentions requires word boundary for loose matches` | `"email@foo"` does not match expert named `foo` |
| 3 | `resolveMentions longest prefix wins` | With experts "Ada" & "Ada Lovelace", `"@Ada Lovelace"` resolves to the longer name |
| 4 | `extractMentionIds returns unique ordered ids` | Deduplication preserves document order |
| 5 | `stripMentionSyntax and normalizeToTokens are inverse` | Round-trip from formal tokens → `@Name` → formal tokens yields original |

### B2 — `src/context/__tests__/TaskContext.test.tsx`

Render `<TaskProvider>` with a test harness; mock `window.cerebro.invoke` / `.agent` / `.taskTerminal`.

| # | Test | Verifies |
|---|------|----------|
| 6 | `loadTasks populates state` | Initial `GET /tasks` + `/tasks/stats` → tasks & stats in context; `isLoading` toggles |
| 7 | `createTask fires POST and appends task` | POST body matches inputs; new task visible in `tasks` |
| 8 | `moveTask is optimistic and rolls back on failure` | UI updates immediately; API 500 reverts state |
| 9 | `startTask happy path` | Spawns `cerebro.agent.run`, stores `run_id`, local column → `in_progress`, run listener registered |
| 10 | `startTask without expert rejects` | Throws clear error; no agent spawn |
| 11 | `run listener done → task flips to to_review` | Synthetic `done` event → POST `/run-event` with `run_completed` → local column → `to_review`. **Mirrors backend A-24.** |
| 12 | `run listener error → task flips to error` | `error` event → POST `run_failed`; column → `error`; `last_error` set |
| 13 | `sendInstruction while running queues instruction` | Creates `instruction` comment with `queue_status=pending`; no new agent run |
| 14 | `sendInstruction while idle spawns new run` | Spawns follow-up run; reassigns expert if `@mention` points elsewhere |
| 15 | `auto-drain pending instruction after done` | After `done` with a pending instruction, `drainQueuedInstruction` marks it `delivered` and starts follow-up |
| 16 | `confirmFailurePrompt drains after failure` | User confirming the failure prompt drains queued instruction |
| 17 | `orphan recovery on mount` | `in_progress` tasks with stale `run_id` flip to `error` locally; failure prompts surface for queued instructions |
| 18 | `resolveCwd prefers project_path` | Returns project_path if set; else auto-creates per-task workspace |

### B3 — Component tests (React Testing Library)

| # | Test File | Verifies |
|---|---|---|
| 19 | `TaskCard.test.tsx` | Renders title, priority dot, due-date badge states (overdue/today/formatted), checklist progress, comment count, expert initials |
| 20 | `TaskCard.test.tsx` | Start button disabled without expert; enabled when assigned |
| 21 | `TaskCard.test.tsx` | Column dropdown invokes `onMoveTask(column)` |
| 22 | `KanbanBoard.test.tsx` | Tag filter pills narrow visible cards |
| 23 | `KanbanBoard.test.tsx` | Empty column shows "All Clear" |
| 24 | `NewTaskDialog.test.tsx` | Submit disabled until title non-empty; Escape closes; `@mention` auto-fills expert |
| 25 | `CommentComposer.test.tsx` | Instruction button disabled when pending instruction exists |
| 26 | `CommentThread.test.tsx` | Pending instruction renders "Queued, Waiting" + discard; delivered shows "Sent to Expert" |
| 27 | `MentionTextarea.test.tsx` | `@` opens dropdown; Enter inserts `@[Name](expert:id)`; arrow keys navigate |
| 28 | `ChecklistEditor.test.tsx` | Add/toggle/delete items; "Promote" creates a new task and marks the item |
| 29 | `ProjectFolderField.test.tsx` | Picker button invokes `window.cerebro.sandbox.pickDirectory`; clear resets to null |

---

## E2E Tests (Playwright) — `e2e/tasks.spec.ts`

The E2E suite was redesigned against the current Kanban UI. Every test asserts EXPECTED behavior — a failing test means a real bug in the product, not a stale test. Some tests are expected to fail today because they cover known-but-unfixed bugs (flagged below).

Helpers are in `e2e/helpers.ts`: `connectToApp`, `goToTasks`, `column`, `card`, `cardColumn`, `openNewTaskDialog`, `createTaskViaDialog`, `quickAddInColumn`, `openDetail`, `detailStatus`, `waitForCardInColumn`, `waitForStatus`, `verifyConsoleHasOutput`, `firstExpertName`, `screenshot`.

### C1 — Creation

| # | Test | Verifies |
|---|------|----------|
| 1 | `new task dialog — submit is disabled until title is non-empty` | Create Task button disabled for empty & whitespace-only input; enabled once a real title is typed |
| 2 | `create task via dialog — card lands in Backlog` | Submitting the dialog creates the task in the `backlog` column |
| 3 | `quick-add in a column header — card lands in that column` | Quick-adding from the In Progress `+` button creates the card in `in_progress`, not `backlog` |
| 4 | `@mention in description auto-assigns that expert` | Typing `@<expert>` in the description auto-populates the expert dropdown and shows the "auto" hint |

### C2 — Start preconditions

| # | Test | Verifies |
|---|------|----------|
| 5 | `Start button is disabled when no expert is assigned` | Detail drawer Start button stays disabled without an assignee |
| 6 | `Start button is enabled once an expert is assigned` | With an expert assigned, the Start button is clickable |

### C3 — State machine (CRITICAL)

| # | Test | Verifies |
|---|------|----------|
| 7 | `full flow — Start moves card Backlog → In Progress → To Review` | Start click → card enters `in_progress` within 15s, Console shows live output, run completes → **card lands in `to_review`** (not directly in `completed`). Load-bearing end-to-end assertion. |
| 8 | `To Review → Completed requires a user action` | A card placed in `to_review` does not auto-advance to `completed` on its own |

### C4 — Cancel

| # | Test | Verifies |
|---|------|----------|
| 9 | `Cancel returns a running card to Backlog and clears the run` | Clicking Cancel on an in-flight task returns the card to `backlog` within 10s |

### C5 — Regression

| # | Test | Verifies |
|---|------|----------|
| 10 | `re-run does NOT prematurely mark the task as done` | After the first run completes (→ `to_review`), clicking Re-run keeps the task in Running ≥15s; no false completion from replayed TUI history. |

### C6 — Queued instructions

| # | Test | Verifies |
|---|------|----------|
| 11 | `instruction queued while running shows a pending badge` | Sending an instruction via the composer mid-run renders a Queued/Waiting/Pending badge |
| 12 | `cancelling a task with a pending instruction discards the queue entry` | After cancel, the pending badge disappears — the queue entry must not leak past the cancel boundary. **Expected to fail today — catches bug #6.** |

### C7 — Delete & filters

| # | Test | Verifies |
|---|------|----------|
| 13 | `deleting a task removes the card from the board` | Delete action removes the card; a zero-count assertion guards against ghost cards |
| 14 | `tag filter pill narrows visible cards to the matching tag` | When tag pills render, clicking one narrows the visible cards (skips gracefully when no tags exist) |

---

## Test Infrastructure

- **Backend**: pytest + FastAPI TestClient (httpx transport), temp SQLite per test
  - Config: `backend/pyproject.toml` — sets `testpaths` and `pythonpath`
  - Tests: `backend/tests/` — one file per feature (e.g. `test_tasks.py`)
  - Fixtures: `backend/tests/conftest.py` — `client` fixture provides fresh DB + app state per test
- **Frontend**: Vitest with standalone `vitest.config.ts`
  - Tests colocated in `__tests__/` folders next to the modules under test
  - Setup: `src/test-setup.ts` — polyfills `crypto`
  - `window.cerebro` mocked per file via a local shim; no MSW/global fetch mock required
- **E2E**: Playwright via CDP attach to a running Electron instance
  - Config: `playwright.config.ts` — `testDir: e2e`, `workers: 1`, 6-minute timeout
  - Helpers: `e2e/helpers.ts` — `connectToApp`, `goToTasks`, `column`, `card`, `cardColumn`, `createTaskViaDialog`, `quickAddInColumn`, `openDetail`, `waitForCardInColumn`, `waitForStatus`, `verifyConsoleHasOutput`, `firstExpertName`, `screenshot`
  - Start app first: `CEREBRO_E2E_DEBUG_PORT=9229 npm start`

## Directory Structure

```
backend/
  tasks/
    router.py         # all /tasks endpoints
    schemas.py        # Pydantic contracts
  models.py           # Task, TaskComment, TaskChecklistItem
  tests/
    conftest.py       # reuse `client` fixture
    test_tasks.py     # A1–A7 above

src/
  context/
    TaskContext.tsx
    __tests__/
      TaskContext.test.tsx    # B2 above
  lib/
    mentions.ts
    __tests__/
      mentions.test.ts        # B1 above
  components/
    screens/
      TasksScreen.tsx
      tasks/
        KanbanBoard.tsx       # + .test.tsx (B3)
        KanbanColumn.tsx
        TaskCard.tsx          # + .test.tsx (B3)
        TaskDetailDrawer.tsx
        NewTaskDialog.tsx     # + .test.tsx (B3)
        CommentComposer.tsx   # + .test.tsx (B3)
        CommentThread.tsx     # + .test.tsx (B3)
        MentionTextarea.tsx   # + .test.tsx (B3)
        ChecklistEditor.tsx   # + .test.tsx (B3)
        ProjectFolderField.tsx# + .test.tsx (B3)

e2e/
  helpers.ts             # Kanban-aware helpers (see E2E section)
  tasks.spec.ts          # C1–C7: creation, start preconditions, full flow,
                         #        cancel, re-run regression, queue, delete
```

## Known Bugs Currently Caught by This Suite

The tests below intentionally fail against today's code because they codify the expected behavior of bugs that still need fixing. Fix the product, not the test.

| Bug | Caught by | Expected behavior |
|-----|-----------|-------------------|
| Unknown `run-event` type silently 200s | A3 `test_run_event_unknown_type_rejected` | Return 400 for unknown event types |
| `run_completed` on an errored task resurrects it to `to_review` | A3 `test_run_completed_after_error_does_not_resurrect` | Error is terminal; ignore late `run_completed` |
| Double `run_completed` duplicates the "ready for review" system comment | A3 `test_double_run_completed_idempotent` | Second `run_completed` is a no-op |
| Stale `run_id` on `run_completed` overwrites a fresh run | A3 `test_run_event_stale_run_id_policy` | Ignore events whose `run_id` does not match the task's current `run_id` |
| Cancel leaves queued pending instructions in `pending` | A4 `test_hard_reset_discards_pending_instructions`, E2E C6 #12 | Cancel transitions pending queue entries to `discarded` |
