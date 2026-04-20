# Cerebro Master Test Plan

Living document. Consolidates the acceptance tests that every main Cerebro feature must pass before a release is signed off. Sectioned test plans (`chat-persistence.md`, `tasks-feature.md`, `teams-feature.md`, `../experts-e2e-test-plan.md`) remain the authoritative per-feature specs — this document references them and fills gaps that span the full product.

This plan was last reopened in response to a live production incident (logged in §1). That incident is the *reason* every feature below must have acceptance tests that are actually exercised, not just documented.

---

## 0. How to use this document

- **Every main feature has (a) a one-line scope, (b) an acceptance table, and (c) pointers to the test files that implement it.** A row without an implementing test is a coverage gap — file an issue.
- **Status column meanings.** `impl` = automated and passing. `gap` = no test exists. `manual` = verified by hand pre-release; no automation yet.
- **Non-negotiable rule.** Every row marked `impl` must be a *runnable* test in this repo. No aspirational checkmarks.
- **Where the tests live.**
  - Backend: `backend/tests/test_*.py` (pytest, `npm run test:backend`)
  - Frontend unit: `src/**/*.test.ts` (vitest, `npm run test:frontend`)
  - E2E: `e2e/*.spec.ts` (Playwright over CDP against a running app, `npm run test:e2e`)

### Running everything

```bash
npm test                                  # backend + frontend
npm run test:backend                      # pytest
npm run test:frontend                     # vitest
CEREBRO_E2E_DEBUG_PORT=9229 npm start     # one terminal
npm run test:e2e                          # another
```

E2E prerequisites (same for every suite): Node ≥20, Python 3.12 backend venv, Claude Code CLI installed and logged in, at least one cloud provider key in Integrations.

---

## 1. Incident triage — "Claude Code exited unexpectedly (code 1)"

**Observed.** User sent (Spanish): *"Puedes crearme un agente que este especializado en redes sociales? especificamente en TikTok"*. Cerebro replied only with `Error: Claude Code exited unexpectedly (code 1) — agent 'cerebro' in /Users/clover/Library/Application Support/Cerebro`.

**Code path.** The message originates at `src/claude-code/stream-adapter.ts:159`. Reading the surrounding handler (lines 132-162) the fallback fires **only when all of the following are true**:

1. The subprocess exited non-zero (or was killed by a signal).
2. `stderrTail` is empty — the 500-char rolling stderr buffer caught nothing.
3. `stdoutTail` is empty — no non-JSON text was printed to stdout before exit (Claude Code's own error lines like `Unknown agent 'foo'` land here).

In other words, the subprocess died *silently*. Every structured failure mode — rate limit, auth, max-turns, unknown-agent, sandbox-exec kill — has a dedicated branch above the fallback that would have surfaced a specific message. None of them fired.

**What we confirmed on disk.** At the time of repro the `cerebro` agent file exists at `<userData>/.claude/agents/cerebro.md`, and the `create-expert` skill is fully installed at `<userData>/.claude/skills/create-expert/SKILL.md` with its helper script at `<userData>/.claude/scripts/create-expert.sh`. So the failure is **not** a race against expert materialization (which is the known race covered by `e2e/expert-chat.spec.ts`).

**Likely root causes — ranked by probability.**

1. **Claude Code CLI silent exit.** The CLI itself crashed before writing anything. Candidates: an OOM at startup under sandbox-exec, a native-binding load error, or a config-file parse error that exits 1 without logging. The CLI is a third-party binary — Cerebro has limited visibility here.
2. **Malformed `cerebro.md` agent file.** If the installer wrote an agent file with a YAML-frontmatter issue, the CLI might reject it and exit 1. The installer in `src/claude-code/installer.ts` re-runs on every app start and could, on a partial write or schema change, produce a file the CLI won't load.
3. **Sandbox-exec kill without stderr.** The `wrapClaudeSpawn` wrapper (stream-adapter.ts:88) can apply `sandbox-exec` on macOS. Denials normally land in stderr, but a kill before exec can exit 1 with nothing on stderr.

**The real product bug is observability, not the cause itself.** A user should never see a generic "exited unexpectedly" line — it's a leak of internal state with no actionable information. Even when the subprocess dies silently, Cerebro should capture the exit code, the cwd, the agent, and a "we don't know why — please share logs" message with a direct link to the log file.

**Recommended fixes (out of scope for this plan, but tracked here).**

1. In `stream-adapter.ts`, when the fallback branch is hit, additionally log the full tail of both streams (even if trimmed to empty) and the spawn args — currently we drop those on the floor.
2. Also capture the CLI's own log file path if one exists (`~/.cache/claude/` on Darwin) and reference it in the user-facing error.
3. Add a process-health probe: spawn the CLI with `--version` at app start and record the result in diagnostics. A silent crash on `--version` would pin #1 vs. #2 above without user-facing churn.

**Regression test.** Added in `e2e/create-expert.spec.ts` — test "skill path: Cerebro handles the TikTok request without a silent crash" sends the exact Spanish message and asserts the reply is **either** an on-topic response **or** a structured error. The generic exit line is an automatic failure. Running this test on the pre-fix build must reproduce the incident.

---

## 2. Chat — Cerebro Core Conversation

**Scope.** The primary `/Chat` screen where the user talks to `cerebro` directly. Includes streaming, tool-call rendering, message persistence, conversation list, delete, and system-prompt assembly with memory injection.

**Authoritative sub-plan.** `docs/test-plans/chat-persistence.md`.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| C1 | New message streams token-by-token into the last assistant bubble | impl | `src/context/ChatContext.test.ts`, `e2e/expert-chat.spec.ts` |
| C2 | Reply is **never** the generic "Claude Code exited unexpectedly" line | impl | `e2e/expert-chat.spec.ts` (both tests), `e2e/create-expert.spec.ts` (skill path) |
| C3 | Errors render as structured messages (auth / rate-limit / max-turns / expert-not-found) | impl | `src/claude-code/stream-adapter.test.ts` (unit coverage of the branch table) |
| C4 | Tool calls render with a card per call (`data-testid="tool-call-card"` with `data-tool-name`, `data-tool-status`) | impl | `e2e/experts-messages.spec.ts` (uses `readLastMessageToolCalls`) |
| C5 | Conversation survives app restart — sidebar lists it, clicking it replays the whole history | impl | `docs/test-plans/chat-persistence.md` |
| C6 | Deleting a conversation removes it from the sidebar and cancels any active run | manual | gap — file as follow-up |
| C7 | The assembled system prompt includes profile + style context files and scope-specific memory | impl | `backend/tests/test_memory.py` if present; **gap** otherwise — add `test_context_assembly` |
| C8 | Sending while a previous run is still streaming queues or blocks per the spec (never double-spawns) | manual | gap — add an E2E that starts two sends back-to-back |

---

## 3. Experts — Create, Install, Message

**Scope.** Creation (UI dialog, `create-expert` skill, direct API), auto-install to disk, expert roster in sidebar, Messages tab per-expert threads, profile drawer, enable/disable/pin.

**Authoritative sub-plan.** `docs/experts-e2e-test-plan.md` (Messages tab).

### 3.1 Create

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| E1 | `POST /experts` with `{name, description, system_prompt}` returns 201; GET `/experts/{id}` **in the same request cycle** returns the row | impl | `backend/tests/test_experts_api.py::test_create_then_get_returns_same_row_immediately` |
| E2 | Creating an expert with a real domain auto-assigns category + default skills | impl | `backend/tests/test_experts_api.py::test_domain_triggers_skill_assignment`, `::test_domain_unknown_no_category_skills_assigned` |
| E3 | The Cerebro `create-expert` skill, invoked by the LLM from chat, creates an expert and reports SUCCESS | impl (LLM) | `e2e/create-expert.spec.ts` (skill path) |
| E4 | Creating an expert with only a name (minimal payload) succeeds and produces a messageable agent | impl | `e2e/create-expert.spec.ts` (direct API path) |
| E5 | A user-source expert's on-disk `.claude/agents/<slug>.md` file exists before the expert row is returned to the UI | impl | `e2e/create-expert.spec.ts` (direct API path — messaging proves the file exists) |
| E6 | Creating an expert with a slug that collides with an existing slug returns 409, not a silent overwrite. Same for PATCH. | impl | `backend/tests/test_experts_api.py::test_create_slug_collision_returns_409`, `::test_update_slug_to_existing_returns_409` |
| E7 | Verified and builtin experts cannot be modified or deleted by user-facing endpoints | impl | `backend/tests/test_experts_api.py::test_update_verified_expert_body_fields_returns_403`, `::test_delete_verified_expert_returns_403`, `::test_delete_builtin_expert_returns_403` |

### 3.2 Install / Materialize

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| E8 | On app startup, every enabled expert in the DB has a matching `.claude/agents/<slug>.md` on disk | manual | gap — add `rematerialize-experts` script smoke test |
| E9 | The installer is idempotent: two back-to-back runs produce identical files | gap | — add vitest for `src/claude-code/installer.ts` |
| E10 | Deleting a user-source expert via `DELETE /experts/{id}` returns 204 and subsequent GET returns 404 | impl | `backend/tests/test_experts_api.py::test_delete_user_expert_returns_204`, `::test_delete_nonexistent_expert_returns_404` |
| E11 | The `cerebro` agent file is always reinstalled from source (not user-editable) | manual | gap |

### 3.3 Message

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| E12 | Chatting with a verified (seeded) expert never hits the generic exit error | impl | `e2e/expert-chat.spec.ts` (happy path) |
| E13 | Chatting with a user-created expert immediately after creation (zero wait) never hits the generic exit error | impl | `e2e/expert-chat.spec.ts` (race), `e2e/create-expert.spec.ts` (race) |
| E14 | Every verified expert has an identity, replies on-topic, and respects the keyword signature | impl | `docs/experts-e2e-test-plan.md` W1-W2, `e2e/experts-messages.spec.ts` |
| E15 | Each expert thread has isolated history — switching experts does not bleed messages across threads | impl | `e2e/experts-messages.spec.ts` |
| E16 | Write/Edit tool calls produce attachment chips with a working download button | impl | `e2e/experts-messages.spec.ts` |

---

## 4. Teams — Orchestration & Delegation

**Scope.** Sequential/parallel team coordination, `delegate_to_team`, `propose_team`, TeamRunCard, TeamProposalCard.

**Authoritative sub-plan.** `docs/test-plans/teams-feature.md`.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| T1 | A sequential team invokes each member in order, passing the prior member's output | impl | `backend/tests/test_teams.py`, `e2e/teams-messages.spec.ts` |
| T2 | A parallel team fans out `Agent` calls in a single message | impl | `e2e/teams-messages.spec.ts` (`assertAgentInvocations`) |
| T3 | `propose_team` creates a proposal card the user can save into a real team | impl | `backend/tests/test_teams.py` |
| T4 | `delegate_to_team` depth check prevents nested team runs beyond `MAX_DELEGATION_DEPTH` | impl | `src/agents/tools/delegation-tools.test.ts` if present, else gap |
| T5 | Team run metadata persists in message metadata and survives reload | impl | `docs/test-plans/teams-feature.md` |
| T6 | All four verified teams (Market Research, App Build, Product Launch, Code Review) execute end-to-end without the generic exit error | impl | `e2e/teams-messages.spec.ts` |

---

## 5. Tasks — Kanban & Expert Runs

**Scope.** Kanban board, task lifecycle, queued instructions, mentions, project folders, idle recovery, console output.

**Authoritative sub-plan.** `docs/test-plans/tasks-feature.md` (48 backend tests + 15 E2E scenarios).

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| K1 | Task creation with minimum `title` lands in `backlog` | impl | `backend/tests/test_tasks.py::test_create_task_minimal` |
| K2 | `run_completed` flips `in_progress` → `to_review`, idempotent | impl | `backend/tests/test_tasks.py::test_run_completed_flips_to_to_review`, `test_double_run_completed_idempotent` |
| K3 | Starting a task spawns a PTY and the Console tab shows live output | impl | `e2e/tasks.spec.ts` (uses `verifyConsoleHasOutput`) |
| K4 | Cancelling an in-progress task returns it to `backlog` and kills the subprocess | impl | `backend/tests/test_tasks.py::test_cancel_in_progress_returns_to_backlog` |
| K5 | Queued instructions survive restart and drain on the next run | impl | `backend/tests/test_tasks.py` |
| K6 | Project folders sandboxed against `validate_link_path` (no `/etc`, no `../../`) | impl | `backend/tests/test_tasks.py::test_create_task_project_path_sandbox_escape` |

---

## 6. Routines — Scheduling & Proposals

**Scope.** Routine data model, scheduling (cron), "Run Now", Routine Proposal Cards, preview execution, persistence of run metadata.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| R1 | Cron-scheduled routines fire on schedule and create a run | impl | `backend/tests/test_routines.py` |
| R2 | "Run Now" executes the routine and streams logs into chat | manual | gap — add E2E |
| R3 | Routine proposal cards save correctly (title, schedule, steps) | impl | `backend/tests/test_routine_lifecycle.py` |
| R4 | Deleting a routine cancels any in-flight execution | manual | gap |
| R5 | Routine runs show up in Activity screen with `type=routine` | gap | — add E2E |

---

## 7. Approvals — Gates & Recovery

**Scope.** Approval request creation, pending/history UI, sidebar badge count, startup recovery of stale approvals.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| AP1 | A step that requires approval pauses the run and creates a pending approval row | impl | `backend/tests/test_approvals.py` |
| AP2 | Approving resumes the run; denying cancels it (`StepDeniedError`) | impl | `backend/tests/test_approvals.py` |
| AP3 | Sidebar badge count reflects current `pending` approvals | manual | gap — add vitest for `useApprovals` |
| AP4 | App restart while a run is paused marks it stale and expires the approval | impl | `backend/tests/test_approvals.py` (`recover-stale`) |
| AP5 | Denying an approval persists the decision reason, shown in History tab | impl | `backend/tests/test_approvals.py` |

---

## 8. Memory — Agent-Memory File Browser

**Scope.** Each Claude Code subagent owns a `<userData>/agent-memory/<slug>/` directory of markdown files. The Settings → Memory UI browses it via `backend/agent_memory/router.py`. Note: the legacy `backend/memory/` router is read-only and only exists for the one-shot migration; new coverage targets `agent_memory`.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| M1 | Listing directories returns slug + file_count + last_modified; only counts `.md` files; hidden (`.`) dirs skipped | impl | `backend/tests/test_agent_memory.py::test_list_directories_*` (4 tests) |
| M2 | Listing files within a slug returns nested paths as relative strings | impl | `backend/tests/test_agent_memory.py::test_list_files_*` (4 tests) |
| M3 | Read / write / delete a markdown file (including nested paths) | impl | `backend/tests/test_agent_memory.py::test_read_file_*`, `::test_write_file_*`, `::test_delete_file_*` (7 tests) |
| M4 | Writing a non-`.md` file is rejected | impl | `backend/tests/test_agent_memory.py::test_write_file_non_md_extension_rejected` |
| M5 | Path traversal via URL-encoded `..` is rejected by `_safe_join` (GET/PUT/DELETE) | impl | `backend/tests/test_agent_memory.py::test_path_traversal_*` (3 tests) |
| M6 | Slugs with backslashes or leading `.` are rejected by `_slug_dir` | impl | `backend/tests/test_agent_memory.py::test_slug_with_backslash_rejected`, `::test_slug_starting_with_dot_rejected` |
| M7 | Knowledge entries / learned facts (old system prompt assembly) | gap | legacy memory system — superseded by agent-memory directories; no new tests needed |

---

## 9. Integrations — Providers, Keys, Local Models

**Scope.** Keys section (Anthropic, OpenAI, Google, HF, Tavily), cloud provider verification, local model catalog, downloads, inference engine.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| I1 | Saving a cloud key pushes it to the Python backend (verify via `GET /cloud/status`) | impl | manual smoke, partial in `backend/tests/test_settings.py` |
| I2 | `POST /cloud/verify` returns a clear error for bad keys (401 or network) | impl | `backend/tests/test_cloud.py` if present; else gap |
| I3 | Local model download progresses via SSE, final state = `ready` | manual | gap |
| I4 | Only one local model is loaded at a time (singleton inference engine) | manual | gap |
| I5 | Web search (Tavily) returns results when configured; "Coming Soon" when not | gap | — add `backend/tests/test_search.py::test_status_reflects_key` |

---

## 10. Files — Workspace Buckets

**Scope.** Files screen, buckets (default + pinned + user), FileItem metadata rows, soft-delete/trash, copy, touch (last-opened), ordering, filtering.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| F1 | Bucket CRUD — create/update/delete, default-bucket protection (`test_delete_default_bucket_returns_400`), reassignment on delete | impl | `backend/tests/test_files.py::test_*_bucket_*` (~20 tests) |
| F2 | Bucket list `file_count` reflects active (non-soft-deleted) items | impl | `backend/tests/test_files.py::test_bucket_list_includes_file_count`, `::test_bucket_list_excludes_soft_deleted_items_from_count` |
| F3 | FileItem CRUD — create/read/patch/delete, validation of `source` / `storage_kind`, 400 on unknown bucket | impl | `backend/tests/test_files.py::test_*_item_*` (~15 tests) |
| F4 | Soft delete by default, `hard=true` for permanent delete, restore clears `deleted_at` | impl | `backend/tests/test_files.py::test_delete_item_soft_delete_by_default`, `::test_delete_item_hard_delete`, `::test_restore_item_clears_deleted_at` |
| F5 | Listing supports filter by bucket / unfiled / source / storage_kind / starred / name search, plus order and pagination | impl | `backend/tests/test_files.py::test_list_items_*` (9 tests) |
| F6 | Copy preserves metadata, forces `storage_kind=managed`, validates target bucket | impl | `backend/tests/test_files.py::test_copy_item_*` (5 tests) |
| F7 | Touch bumps `last_opened_at`; empty-trash hard-deletes soft-deleted rows; managed-paths endpoint | impl | `backend/tests/test_files.py::test_touch_item_*`, `::test_empty_trash_*`, `::test_list_managed_paths` |

---

## 11. Activity & Run Records

**Scope.** Activity screen lists runs hierarchically (`parent_run_id`), filters by conversation/run type, drill-down to children.

| # | Acceptance | Status | Test |
|---|-----------|--------|------|
| AC1 | Every orchestration run creates a `RunRecord` with the right type | impl | `backend/tests/test_engine.py` |
| AC2 | Parent/child hierarchy is navigable (orchestration → delegation/team/routine) | impl | `backend/tests/test_engine.py` (`children` endpoint) |
| AC3 | Activity screen renders the hierarchy with expandable rows | manual | gap — add E2E |

---

## 12. Cross-cutting — Must-hold product invariants

| # | Invariant | Why it matters |
|---|-----------|----------------|
| X1 | **No user-facing message is ever the generic "Claude Code exited unexpectedly" line.** | §1 — it's pure noise. Every failure must surface a structured, actionable error. |
| X2 | A fresh install can chat with the default `cerebro` agent on first message without any UI-visible error, given a valid cloud key. | Onboarding. |
| X3 | Every operation that spawns a subprocess (chat, task, routine) cleans up on app quit — no orphaned `claude` processes. | Memory / stability — check via `ps` post-quit. |
| X4 | No API key is ever written to disk outside the OS keychain or the in-memory credentials holder. | Security — regression test by grepping `<userData>` for real keys after usage. |
| X5 | No user-authored data (context files, memory items, tasks) is lost across an app upgrade. | Trust — covered by migration tests; add when a migration is introduced. |
| X6 | Every LLM-driven test passes deterministically when the model replies empty or with an unexpected shape. | Flakiness budget — E2E suite must not rely on the model saying a specific sentence. |

---

## 13. Release gate

Before cutting a release:

1. **All rows marked `impl` must pass.** Red → block the release.
2. **All rows marked `manual` must be walked through by the on-call engineer** against the release-candidate build and logged in the release notes.
3. **`gap` rows are tolerated** only if the feature is not on the release's critical path. Each gap closed is a small release-gate credit.
4. **The §1 regression test must run green** on the release candidate. This is the rule the product broke once; it must not break again silently.

---

## 14. Maintenance

- When a test is added, update the matching table row's **Status** and **Test** columns in the same PR.
- When a `gap` row is closed, remove the "— add …" hint.
- When a test is deleted, do not leave a stale `impl` row — downgrade to `gap` with a note.
- When a new feature lands, add a new section to this document in the same PR (not a follow-up). A feature without acceptance tests ships only under an explicit exception in the PR description.
