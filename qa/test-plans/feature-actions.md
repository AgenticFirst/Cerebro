---
id: feature-actions
name: Actions sweep
scope: feature
feature: actions
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-05-31T01:24:01.899Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] App boots without uncaught errors severity:P0 scope:smoke,boot
  <!-- obelisk:id=01KSXT2ZQAGWN86WZH5PZP17CW -->
  - **Expected:** Electron, Vite, and FastAPI start; no renderer crash, backend health failure, or console uncaught exception appears.
  - **Repro:** Run `tail -f /dev/null | npm start &`, wait for the main window, then inspect terminal and DevTools console.
- [ ] Action screens are reachable severity:P0 scope:smoke,actions
  <!-- obelisk:id=01KSXT2ZQACACCVZQ1XC7J966C -->
  - **Expected:** Routines, Activity, and Approvals open from the sidebar and render loading, empty, or populated states without blank screens.
  - **Repro:** Launch the app, click sidebar items `Routines`, `Activity`, and `Approvals`.
- [ ] Backend action routers mount severity:P0 scope:backend,routing
  <!-- obelisk:id=01KSXT2ZQAJJ6NT7DSYDNZX98H -->
  - **Expected:** `/engine/runs`, `/agent-runs`, `/agent-memory`, `/experts`, and `/cloud-sync/status` respond with valid JSON or documented auth/setup errors.
  - **Repro:** Use the app backend port from runtime info and curl each route after boot.
- [ ] Branded icons load severity:P1 scope:smoke,icons
  <!-- obelisk:id=01KSXT2ZQAHYKNAM7NA5N8WKAT -->
  - **Expected:** Window, dock/taskbar, and README-rendered icon use valid Cerebro assets; missing or corrupt `assets/icon*.png`/`.icns` does not regress packaging.
  - **Repro:** Boot the app and run `file assets/icon-rounded.png assets/icon.png assets/icon.icns`.
- [ ] CI runs frontend and backend severity:P1 scope:ci,tests
  <!-- obelisk:id=01KSXT2ZQAZYAR08FNNAB7TXHD -->
  - **Expected:** GitHub Actions `test.yml` runs Node 20 frontend tests and Python 3.12 backend pytest on pushes and PRs to `main`.
  - **Repro:** Open a PR or manually inspect `.github/workflows/test.yml`; confirm both jobs complete.
- [ ] Lint format configs protect actions severity:P1 scope:ci,config
  <!-- obelisk:id=01KSXT2ZQAHZB5WDZPNF551KY9 -->
  - **Expected:** `npm run lint` and `npm run format:check` apply the checked ESLint/Prettier rules without scanning ignored build artifacts.
  - **Repro:** Run lint and format checks; verify `.eslintrc.json`, `.prettierrc.json`, `.prettierignore`, and `.gitignore` behavior.
- [ ] Owner review guards release paths severity:P1 scope:ci,release
  <!-- obelisk:id=01KSXT2ZQAPTJ4JSMC7BE6REP8 -->
  - **Expected:** Changes to `.github`, package manifests, build scripts, and release workflow paths require `@calovera` review.
  - **Repro:** Open a PR touching `.github/workflows/test.yml` or `package.json`; confirm CODEOWNERS requests the owner.
- [ ] Contributor docs match commands severity:P2 scope:docs,onboarding
  <!-- obelisk:id=01KSXT2ZQBJ22P6RHN3PFBNN28 -->
  - **Expected:** README, AGENTS, CLAUDE, and CONTRIBUTING list runnable setup/test commands and preserve Claude Code/action approval conventions.
  - **Repro:** Compare documented commands against `package.json` scripts and action approval behavior.

## Routine Actions

- [ ] Sidebar lists action categories severity:P0 scope:routine-actions,catalog
  <!-- obelisk:id=01KSXT2ZQBZT5YT4R4CMDZGANP -->
  - **Expected:** The action sidebar opens with AI, Knowledge, Integrations, Logic, and Output groups; trigger actions are excluded from the add-action list.
  - **Repro:** Create or edit a routine, press `A` or click `Add Action`, then inspect visible groups.
- [ ] Search filters actions by keyword severity:P1 scope:routine-actions,search
  <!-- obelisk:id=01KSXT2ZQB2PEBYK4PCMT7HBR2 -->
  - **Expected:** Typing `github`, `webhook`, or `memory` filters action cards by name, description, or keyword and shows an empty result message for misses.
  - **Repro:** Open the action sidebar and use the search input with matching and nonsense terms.
- [ ] Unavailable actions cannot drag severity:P1 scope:routine-actions,availability
  <!-- obelisk:id=01KSXT2ZQB6QPGKWDN5SV4908Z -->
  - **Expected:** Coming-soon cards such as Gmail or Notion show `soon`, are not draggable, and never create canvas nodes.
  - **Repro:** Try dragging `Gmail` or `Notion` from the Integrations group onto the canvas.
- [ ] HTTP action creates configurable node severity:P0 scope:routine-actions,http
  <!-- obelisk:id=01KSXT2ZQB2DNBS39E4QJKJKWR -->
  - **Expected:** Dragging `HTTP Request` creates a selected node with default params, shows its config panel, and serializes `actionType: http_request`.
  - **Repro:** Drag `HTTP Request` onto a routine, enter method and URL, then save and inspect `dag_json` via `/routines`.
- [ ] Approval gate serializes required approval severity:P0 scope:routine-actions,approvals
  <!-- obelisk:id=01KSXT2ZQBYFHH0HWKKPXBXR3F -->
  - **Expected:** `Approval Gate` nodes save with `requiresApproval: true`; validator rejects any saved approval gate missing that flag.
  - **Repro:** Add an Approval Gate, save, inspect DAG, then tamper the flag false and attempt a run.
- [ ] Connections auto-wire variable chips severity:P1 scope:routine-actions,mapping
  <!-- obelisk:id=01KSXT2ZQB16Q4RKPTWFNXXMR5 -->
  - **Expected:** Connecting output from one step to another adds a primary `inputMappings` entry and displays a clickable `{{variable}}` chip.
  - **Repro:** Connect `Ask AI` to `Send Message`, select the target node, and inspect Available Variables.
- [ ] Renaming rewrites downstream templates severity:P1 scope:routine-actions,mapping
  <!-- obelisk:id=01KSXT2ZQB3YDJDS2N1GYGERH9 -->
  - **Expected:** Renaming a source step updates downstream mapping target names and replaces old `{{step_name}}` tokens without collisions.
  - **Repro:** Wire two steps, insert the variable chip into a prompt, rename the source, and reopen the target config.
- [ ] Save reload preserves canvas DAG severity:P0 scope:routine-actions,persistence
  <!-- obelisk:id=01KSXT2ZQBN2EMPYBC231JKSJ3 -->
  - **Expected:** Manual save and autosave preserve trigger config, step params, edges, annotations, approval flags, and no visual trigger edge leaks into `dependsOn`.
  - **Repro:** Build a routine with trigger, two actions, an edge, and a sticky note; save, reload the app, and inspect canvas plus `dag_json`.

## Execution And Persistence

- [ ] Run validation blocks missing fields severity:P0 scope:validation,routine-actions
  <!-- obelisk:id=01KSXT2ZQBMB7VEQV55HXE02J0 -->
  - **Expected:** Run Now aborts before execution and shows a targeted toast for missing `prompt`, `url`, `repo`, `title`, or required integration connection.
  - **Repro:** Create invalid Ask AI, HTTP Request, HubSpot, and GitHub steps; click Run Now.
- [ ] Chat catalog requires bearer token severity:P0 scope:chat-actions,security
  <!-- obelisk:id=01KSXT2ZQBWPM3P2AE2G6C7PC4 -->
  - **Expected:** `/chat-actions/catalog?lang=es` returns Spanish labels with valid auth and 401 without `Authorization: Bearer <token>`.
  - **Repro:** Read runtime port/token, curl catalog with and without the header.
- [ ] Chat run validates body shape severity:P0 scope:chat-actions,validation
  <!-- obelisk:id=01KSXT2ZQB3117F159Y8SE5YTZ -->
  - **Expected:** `/chat-actions/run` returns 400 for non-JSON, missing `type`, or non-object `params` without starting an engine run.
  - **Repro:** POST malformed payloads to the loopback chat-actions server.
- [ ] Chat actions always request approval severity:P0 scope:chat-actions,approvals
  <!-- obelisk:id=01KSXT2ZQBGX1J11CRRVT3NE1J -->
  - **Expected:** A valid chat-exposable action creates a `chat_action` run, pending approval row, sidebar badge, and Approvals card before side effects execute.
  - **Repro:** POST `send_notification` or connected `send_telegram_message`; check `/engine/runs?run_type=chat_action` and Approvals.
- [ ] Approval decision resolves long poll severity:P0 scope:approvals,engine
  <!-- obelisk:id=01KSXT2ZQB1ZJZKVTX69FHFPAS -->
  - **Expected:** Approving returns HTTP 200 with run id, approval id, summary, and step data; denying returns 403 and stores the denial reason in history.
  - **Repro:** Start a chat action curl, approve once, repeat and deny with a reason from Approvals.
- [ ] Action IO failures persist errors severity:P0 scope:engine,io
  <!-- obelisk:id=01KSXT2ZQBXHVKSW3B961N669P -->
  - **Expected:** HTTP timeout/private-host block, disallowed command, missing working directory, and webhook timeout fail the step with readable error records.
  - **Repro:** Run routines for `http_request`, `run_command`, and `wait_for_webhook` failure cases; inspect Activity run details.
- [ ] Stale runs recover on restart severity:P1 scope:engine,persistence
  <!-- obelisk:id=01KSXT2ZQBAR52DTVA78ZETEFB -->
  - **Expected:** Interrupted running/paused runs become failed, pending approvals become expired, and affected tasks receive reconciliation comments.
  - **Repro:** Start an approval-gated routine, quit before resolving, relaunch, then call or observe `/engine/runs/recover-stale`.
- [ ] Support data survives action workflows severity:P1 scope:agent-runs,agent-memory,cloud-sync
  <!-- obelisk:id=01KSXT2ZQBXDPGCSHJ0FRCG77S -->
  - **Expected:** Agent runs filter/update tools JSON, expert context validates attached files, agent memory blocks path escape, and cloud sync keeps outbox pending while offline.
  - **Repro:** Exercise `/agent-runs`, `/experts/{id}/context-files`, `/agent-memory/{slug}/files`, and `/cloud-sync/connect` with offline Supabase.
