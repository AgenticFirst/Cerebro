---
id: feature-screens
name: Screens sweep
scope: feature
feature: screens
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-05-31T01:18:25.105Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Electron app boots to Chat severity:P0 scope:smoke,chat
  <!-- obelisk:id=01KSXSRPTGEHC237D6W2P15VZS -->
  - **Expected:** Running `tail -f /dev/null | npm start &` opens Cerebro with the Chat welcome view, no renderer console errors, and no backend startup failure.
  - **Repro:** Start from repo root, wait for the Electron window, verify `/health` returns `{status: "ok"}` and the Chat nav item is active.
- [ ] Sidebar opens every screen severity:P0 scope:navigation,screens
  <!-- obelisk:id=01KSXSRPTG9PYS45476255MQSV -->
  - **Expected:** Clicking Chat, Experts, Tasks, Routines, Files, Knowledge Base, Approvals, Integrations, Marketplace, and Settings mounts the matching screen without a blank pane.
  - **Repro:** Use sidebar buttons with `data-tour-id=nav-*` where present; assert each screen title or empty-state text appears.
- [ ] App icons load in shell severity:P2 scope:assets,smoke
  <!-- obelisk:id=01KSXSRPTGTE0QTXMS08EFKD4T -->
  - **Expected:** The packaged window and README-rendered icon use valid image assets; no missing asset request appears for `assets/icon.png`, `assets/icon-rounded.png`, or `assets/icon.icns`.
  - **Repro:** Open the app and README preview; inspect network/log output and verify each asset decodes with platform image tooling.
- [ ] CI runs screen test jobs severity:P1 scope:ci,tests
  <!-- obelisk:id=01KSXSRPTG8RAFJD8QR6D99S33 -->
  - **Expected:** .github/workflows/test.yml runs frontend Vitest and backend Pytest on pushes and PRs to main using Node 20 and Python 3.12.
  - **Repro:** Open a PR touching `src/components/screens/ActivityScreen.tsx`; confirm both `Frontend Tests` and `Backend Tests` jobs execute and report status.
- [ ] Lint config accepts screen imports severity:P1 scope:tooling,screens
  <!-- obelisk:id=01KSXSRPTGJ2KJCWJT0G8FAG69 -->
  - **Expected:** `npm run lint -- src/components/screens/ActivityScreen.tsx` honors `.eslintrc.json` Electron/import/TypeScript rules and reports no config-resolution error.
  - **Repro:** Run the lint command locally after `npm ci`; verify failures, if any, are real lint findings rather than parser/plugin config failures.
- [ ] Prettier config formats screens severity:P2 scope:tooling,formatting
  <!-- obelisk:id=01KSXSRPTGBYS8GSG39TNPQ12W -->
  - **Expected:** `npx prettier --check src/components/screens/SettingsScreen.tsx` uses `.prettierrc.json` with single quotes, semicolons, LF endings, and 100-column print width.
  - **Repro:** Run Prettier check on a representative screen file and confirm `.prettierignore` excludes generated outputs only.
- [ ] Generated artifacts stay ignored severity:P1 scope:tooling,artifacts
  <!-- obelisk:id=01KSXSRPTGZXY9JEM97TC8912Y -->
  - **Expected:** Local outputs such as `.vite/`, `out/`, `coverage/`, `playwright-report/`, `test-results/`, `backend/venv/`, and SQLite files do not appear as untracked QA artifacts.
  - **Repro:** Create one temporary file under each ignored path, run `git check-ignore`, then remove the temporary files.
- [ ] Docs match QA launch commands severity:P2 scope:docs,onboarding
  <!-- obelisk:id=01KSXSRPTGJWGWZ1H3VN7T2N5J -->
  - **Expected:** README.md, CONTRIBUTING.md, AGENTS.md, and CLAUDE.md describe compatible install, start, test, and E2E launch commands for screen QA.
  - **Repro:** Compare documented commands against `package.json` scripts; flag stale commands or missing `tail -f /dev/null | npm start &` E2E guidance.

## Screen Navigation And State

- [ ] New Chat clears active screen severity:P0 scope:navigation,chat
  <!-- obelisk:id=01KSXSRPTGPH05D44A66ZZ2EYK -->
  - **Expected:** Clicking New Chat from Tasks navigates to Chat, clears any selected non-chat conversation, and shows the welcome composer or new empty thread.
  - **Repro:** Open Tasks, click the sidebar New Chat button, then assert Chat is active and no Tasks drawer or board focus remains.
- [ ] Collapsed sidebar preserves badges severity:P1 scope:navigation,badges
  <!-- obelisk:id=01KSXSRPTGJ57PWGFABX7KF48V -->
  - **Expected:** Collapsing the sidebar hides labels but preserves icon tooltips and task/approval badge dots; expanding restores counts and active screen styling.
  - **Repro:** Seed one `to_review` task and one pending approval, click the collapse toggle, inspect Tasks and Approvals icons, then expand.
- [ ] Apps accordion opens Knowledge Base severity:P1 scope:navigation,knowledge
  <!-- obelisk:id=01KSXSRPTG215WVDTD53ZKVCTC -->
  - **Expected:** The Apps group expands/collapses without losing active screen state, and clicking Knowledge Base mounts the knowledge screen full-height.
  - **Repro:** From Chat, collapse and expand Apps, click Knowledge Base, then navigate away and back to confirm no blank pane.
- [ ] Settings voice gate redirects severity:P1 scope:settings,voice
  <!-- obelisk:id=01KSXSRPTGNTESE57ATKDM0R3Z -->
  - **Expected:** When `voice-calls` is disabled, the Voice row is hidden and any pending request for Voice lands on Beta or Memory instead of rendering a dangling pane.
  - **Repro:** Disable the beta flag, set pending settings section to `voice`, open Settings, and assert Voice content is absent.
- [ ] Settings Activity lazy loads severity:P1 scope:settings,activity
  <!-- obelisk:id=01KSXSRPTG60BGFAA3W6ZK0ZQD -->
  - **Expected:** Clicking Settings > Activity loads the Activity screen inside Settings, including filters and run list, without changing the outer sidebar active item.
  - **Repro:** Open Settings, click Activity in the inner sidebar, verify `/engine/runs?offset=0&limit=30` is requested and Settings remains active.
- [ ] Files preferences survive reload severity:P1 scope:files,persistence
  <!-- obelisk:id=01KSXSRPTG3V8HVVJKW5FB9B8Y -->
  - **Expected:** Files view mode, sort key, and last sidebar filter persist through `/settings/files_view_mode`, `/settings/files_sort_key`, and `/settings/files_last_filter` after reload.
  - **Repro:** Open Files, switch to list view, choose Name sort, select Starred, reload the renderer, and assert those controls remain selected.
- [ ] Tour drives target screens severity:P2 scope:onboarding,navigation
  <!-- obelisk:id=01KSXSRPTGNM9DKRNNPG5CA2Q1 -->
  - **Expected:** Onboarding steps with `screen` and `settingsSection` move the app to the requested screen and spotlight the matching `data-tour-id` target.
  - **Repro:** Start/replay onboarding, advance through Chat, Tasks, Integrations, and Settings Memory steps; assert active nav and spotlight rectangle match.
- [ ] Unknown gated screen does not crash severity:P1 scope:navigation,voice
  <!-- obelisk:id=01KSXSRPTGSZKB9WCS4KVH8HHQ -->
  - **Expected:** Navigating to Call while `voice-calls` is disabled renders no crash, no orphaned drag bar, and allows sidebar navigation back to a valid screen.
  - **Repro:** With voice flag off, trigger `setActiveScreen('call')` via test harness, then click Chat and assert the app recovers.

## Backend Persistence And Failures

- [ ] Activity filters query engine runs severity:P0 scope:activity,engine
  <!-- obelisk:id=01KSXSRPTGS2HT4VHZ8BRZJHME -->
  - **Expected:** Status, type, and trigger filters map to `/engine/runs` query params and show only matching run cards with the total count updated.
  - **Repro:** Seed running, completed, failed, routine, preview, chat, and scheduled runs; click each Activity filter pill and inspect requests/results.
- [ ] Activity detail shows run steps severity:P0 scope:activity,engine
  <!-- obelisk:id=01KSXSRPTGEMGJWYM6ACHQD58T -->
  - **Expected:** Selecting a run opens the detail panel, loads `/engine/runs/{run_id}` plus events, and displays ordered steps, logs, errors, and child runs when present.
  - **Repro:** Seed a run with two step records, three execution events, and one child run; click its RunCard and verify panel sections.
- [ ] Activity retry recovers load failure severity:P1 scope:activity,network
  <!-- obelisk:id=01KSXSRPTGAAXSQHZ50BA48F1J -->
  - **Expected:** If `/engine/runs` throws or returns non-ok on first load, Activity shows the failed-to-load state with Retry; clicking Retry reloads successful data.
  - **Repro:** Mock `window.cerebro.invoke` to reject for the first `/engine/runs` call, then resolve with one run after clicking Retry.
- [ ] Approvals resolve once only severity:P0 scope:approvals,engine
  <!-- obelisk:id=01KSXSRPTGF51FKPTTJM84WX5X -->
  - **Expected:** Pending approvals load from `/engine/approvals?status=pending&limit=100`; Approve or Deny resolves once, refreshes the badge, and a second resolve receives a 409-style failure.
  - **Repro:** Seed one approval, click Approve, verify it moves to History; repeat direct resolve on the same id and assert already-resolved handling.
- [ ] Stale runs expire approvals severity:P1 scope:engine,tasks
  <!-- obelisk:id=01KSXSRPTGWY4P8QRV6S7ZM2Q9 -->
  - **Expected:** POST `/engine/runs/recover-stale` marks running/paused runs failed, expires pending approvals, and leaves interrupted tasks resumable in the Tasks screen.
  - **Repro:** Seed an in-progress task tied to a running run with a pending approval; call recover-stale and refresh Tasks and Approvals.
- [ ] Memory editor persists markdown severity:P0 scope:memory,persistence
  <!-- obelisk:id=01KSXSRPTGW5TGB0S0N2HM4PRP -->
  - **Expected:** Settings > Memory lists agent directories, creates `.md` files, saves edits through PUT `/agent-memory/{slug}/files/{path}`, and reloads saved content after app restart.
  - **Repro:** Create `qa-notes`, add `plan.md`, type content, Save, restart, and read the same file from the Memory section.
- [ ] Memory rejects path traversal severity:P0 scope:memory,validation
  <!-- obelisk:id=01KSXSRPTGHWRK4XH78ZMABD4Z -->
  - **Expected:** Encoded `..`, absolute paths, hidden slugs, backslash slugs, and non-`.md` writes are rejected without creating files outside the agent-memory root.
  - **Repro:** Call `/agent-memory/test/files/%2E%2E/%2E%2E/etc/passwd.md`, `/agent-memory/.hidden/files`, and PUT `file.txt`; assert 400 responses.
- [ ] Agent runs filter by conversation severity:P1 scope:agent-runs,persistence
  <!-- obelisk:id=01KSXSRPTGQ0GZT5J11Y6SA0E5 -->
  - **Expected:** Agent run records created through `/agent-runs` persist tools, parent_run_id, status, tokens, and list correctly by conversation_id, expert_id, and status.
  - **Repro:** Create parent and child agent runs, patch child to completed with tools_used, reload, then query `/agent-runs?conversation_id=...&status=completed`.
- [ ] Cloud sync surfaces offline status severity:P1 scope:cloud-sync,network
  <!-- obelisk:id=01KSXSRPTGGWS21SYCJV1EE77S -->
  - **Expected:** Integrations > Remote/Supabase status shows offline/error when `/cloud-sync/connect` cannot reach Postgres; secrets remain password fields and no DB URL appears in visible error text unless returned by backend.
  - **Repro:** Enter an invalid Postgres URL in Supabase sync, click Connect, and verify the error banner plus disconnected form state.
- [ ] Cloud sync outbox captures screen edits severity:P1 scope:cloud-sync,persistence
  <!-- obelisk:id=01KSXSRPTGW9E74XE90MQ3V0GR -->
  - **Expected:** When sync is enabled, screen-originated edits to settings, files, tasks, runs, and agent_runs create pending SyncOutbox rows; disabling sync stops new capture.
  - **Repro:** Enable outbox capture, change Files view mode, create a task, create an agent run, then inspect `sync_outbox`; disable and repeat.
- [ ] Database migration preserves screen data severity:P0 scope:database,persistence
  <!-- obelisk:id=01KSXSRPTGG4VAA3WACB1S80KH -->
  - **Expected:** Opening an older SQLite database adds missing columns/indexes, seeds the Default bucket, enables Knowledge FTS when available, and leaves screen data readable.
  - **Repro:** Start with a fixture DB missing recent columns, run backend startup, then open Files, Activity, Tasks, Chat, and Knowledge Base.
- [ ] Storage failures do not block sync severity:P1 scope:cloud-sync,files
  <!-- obelisk:id=01KSXSRPTG0H050TERVDZ2CEGG -->
  - **Expected:** Supabase Storage upload/download failures log warnings and return false/null, but row-level cloud sync continues and the UI remains usable.
  - **Repro:** Configure Supabase sync with valid DB and invalid storage bucket/key, create a managed file, trigger sync, and verify rows sync while storage error appears in status.
