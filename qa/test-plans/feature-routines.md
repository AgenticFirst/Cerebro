---
id: feature-routines
name: Routines sweep
scope: feature
feature: routines
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-06-01T07:51:51.799Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Documented launch opens Routines severity:P0 scope:routines,smoke
  <!-- obelisk:id=01KT12NV7QFN4NEBZJ0RS1G0HT -->
  - **Expected:** The README/CONTRIBUTING/CLAUDE npm start flow boots Electron, starts FastAPI, and the sidebar Routines item renders the Routines screen without uncaught renderer or backend errors.
  - **Repro:** From a clean checkout, run `npm install`, `npm run setup`, then `tail -f /dev/null | npm start &`; click sidebar `Routines` and watch terminal/devtools for uncaught errors.
- [ ] Routines list shows loading spinner severity:P1 scope:routines,smoke
  <!-- obelisk:id=01KT12NV7QVGZSDBEK0FEHD3B9 -->
  - **Expected:** While `GET /routines?limit=200` is pending, the Routines screen shows the centered loader and does not flash empty-state text.
  - **Repro:** Stub `window.cerebro.invoke` for `/routines?limit=200` to resolve after 2 seconds, navigate to Routines, and observe the initial render.
- [ ] Routines load error retries severity:P0 scope:routines,smoke
  <!-- obelisk:id=01KT12NV7Q0KDHBR7BJ3RP0PHV -->
  - **Expected:** If initial `GET /routines?limit=200` rejects, the screen shows `Failed to load routines`, the error text, and `Retry`; clicking Retry successfully reloads cards.
  - **Repro:** Mock the first `/routines?limit=200` call to throw and the second to return one routine; click `Retry`.
- [ ] Empty state opens create dialog severity:P1 scope:routines,smoke
  <!-- obelisk:id=01KT12NV7QV7K56Z59KVC8JTXX -->
  - **Expected:** With zero routines, `Create your first routine` opens the `New Routine` dialog with Name, Description, Trigger, and Create Routine controls focused on Name.
  - **Repro:** Return `{routines: [], total: 0}` from `/routines?limit=200`; click `Create your first routine`.
- [ ] Routine CI commands resolve severity:P1 scope:routines,smoke
  <!-- obelisk:id=01KT12NV7QDMK0WCZ8S6D7HJKN -->
  - **Expected:** `package.json` scripts referenced by `.github/workflows/test.yml` exist and can run routine frontend/backend tests without missing dependency or path errors.
  - **Repro:** Compare `package.json` with `.github/workflows/test.yml`; run `npm run test:frontend -- src/engine src/scheduler src/routine-templates` and `cd backend && venv/bin/python -m pytest -v tests/test_routines.py tests/test_engine.py`.
- [ ] Spanish Routines screen renders severity:P1 scope:routines,smoke
  <!-- obelisk:id=01KT12NV7QP7E3XYA5KBEF08WC -->
  - **Expected:** Switching locale to Spanish renders Rutinas, Nueva rutina, Ejecutar ahora, and validation/empty-state text without missing-key fallbacks or English-only routine strings.
  - **Repro:** Set i18n language to `es`, open Routines, create a routine, open the editor, and inspect list, create dialog, toolbar, and validation text.

## Authoring And Validation

- [ ] Blank name blocks creation severity:P0 scope:routines
  <!-- obelisk:id=01KT12NV7QC2VZHM21VSW6D45V -->
  - **Expected:** The Create Routine submit button stays disabled for an empty or whitespace-only Name, and no `POST /routines` request is sent.
  - **Repro:** Open `New Routine`, enter spaces in Name, leave Description optional, and try pressing Enter or clicking Create Routine.
- [ ] Manual routine opens editor severity:P0 scope:routines
  <!-- obelisk:id=01KT12NV7QX593HDXM3TGYKZSR -->
  - **Expected:** `POST /routines` receives trimmed `name`, trimmed `description`, and `trigger_type: manual`; the new routine appears first and opens `RoutineEditor`.
  - **Repro:** Create ` Daily Standup Summary ` with manual trigger; verify backend response, list ordering, and editor toolbar name.
- [ ] Scheduled create saves cron severity:P0 scope:routines
  <!-- obelisk:id=01KT12NV7QRGF3THGECF9Y5SRV -->
  - **Expected:** Creating a Scheduled routine with selected weekdays and time sends `trigger_type: cron`, a valid `cron_expression`, then calls `window.cerebro.scheduler.sync()`.
  - **Repro:** Open New Routine, choose Scheduled, set Monday/Wednesday 09:30, create it, and inspect the POST body plus scheduler sync spy.
- [ ] Failed create stays recoverable severity:P1 scope:routines
  <!-- obelisk:id=01KT12NV7QA5GR1BCV2GC696VE -->
  - **Expected:** If `POST /routines` fails, the dialog remains open, the Create button leaves loading state, and a `Failed to create routine` toast appears.
  - **Repro:** Mock `/routines` POST to reject; submit a valid manual routine and verify no editor navigation occurs.
- [ ] Trigger change clears stale schedule severity:P1 scope:routines
  <!-- obelisk:id=01KT12NV7Q5A37WV4S1217KFTF -->
  - **Expected:** Changing an existing cron routine to Manual or Webhook patches `trigger_type` and `cron_expression: null`; switching back to Scheduled creates a fresh cron value.
  - **Repro:** Open a scheduled routine, use the trigger pill in `EditorToolbar`, select Manual, then Scheduled, and inspect PATCH bodies.
- [ ] Ask AI node autosaves DAG severity:P0 scope:routines
  <!-- obelisk:id=01KT12NV7QNRH2K8E99TBZ0SKS -->
  - **Expected:** Dragging Ask AI onto the canvas creates a step node, marks Unsaved, then autosaves `dag_json` via `PATCH /routines/{id}` and shows Saved.
  - **Repro:** Open a routine editor, press `A`, drag Ask AI onto the canvas, wait over 1 second, and inspect the PATCH body for a serialized DAG.
- [ ] Edge creates variable chip severity:P1 scope:routines
  <!-- obelisk:id=01KT12NV7QKN6DY1C05DYFVCEX -->
  - **Expected:** Connecting one step into another adds an input mapping and the target config panel shows a clickable `{{source_step_name}}` variable chip that inserts into the focused prompt.
  - **Repro:** Add two Ask AI steps, connect first to second, open second config, focus prompt, click the variable chip, and save.
- [ ] Template blocks missing integrations severity:P0 scope:routines,integrations
  <!-- obelisk:id=01KT12NV7QZPHEFH70T98QSAN7 -->
  - **Expected:** Using the WhatsApp/HubSpot template with either connection missing stays on Preview and shows a setup-required banner with missing connection details and Go to Integrations.
  - **Repro:** Stub WhatsApp status disconnected and HubSpot `hasToken: false`; open Templates, select Customer Support via WhatsApp, click Use this template.

## Execution Triggers Persistence

- [ ] Run Now opens Activity severity:P0 scope:routines,activity-approvals
  <!-- obelisk:id=01KT12NV7Q6J7985S5QMBMWKFH -->
  - **Expected:** Clicking Run Now on an enabled routine with valid `dag_json` calls `engine.run({routineId, triggerSource: manual})`, navigates to Activity, and then POSTs `/routines/{id}/run` to increment `run_count`.
  - **Repro:** Seed an enabled routine with a one-step valid DAG; click Run Now on the card and verify Activity detail opens for the returned run id.
- [ ] Missing prompt blocks run severity:P0 scope:routines
  <!-- obelisk:id=01KT12NV7Q7CFQ4S33ASJCDRFZ -->
  - **Expected:** A routine containing an Ask AI step with blank `params.prompt` does not call `engine.run`; the card/editor displays the validation issue and run click shows a targeted error toast.
  - **Repro:** Save a DAG with `actionType: ask_ai` and empty prompt, then click Run Now from list and editor toolbar.
- [ ] Approval gate pauses run severity:P0 scope:routines,activity-approvals
  <!-- obelisk:id=01KT12NV7Q0MJFVCG92ZG99NPN -->
  - **Expected:** A step with `requiresApproval: true` creates an approval row, emits `approval_requested`, marks the run paused, and resumes or cancels according to Approve/Deny.
  - **Repro:** Run a routine with an approval-gated `send_telegram_message` or `github_open_pr` step; resolve it from Approvals and inspect `/engine/runs/{run_id}`.
- [ ] Failed step persists failure severity:P0 scope:routines,activity-approvals
  <!-- obelisk:id=01KT12NV7QPX5ZFBAQ2CM8TP1D -->
  - **Expected:** When a step exhausts retries with `onError: fail`, `/engine/runs/{run_id}` is `failed`, `failed_step_id` is set, the step record stores `error`, and downstream pending steps are skipped.
  - **Repro:** Run a DAG with an invalid `http_request` URL or missing registered action; inspect run, steps, and persisted events.
- [ ] Scheduler resyncs changed cron severity:P0 scope:routines
  <!-- obelisk:id=01KT12NV7QX7PH5EDQGMSPAKXS -->
  - **Expected:** Enabling, disabling, deleting, or changing cron routines reconciles node-cron jobs exactly once per final state and skips invalid cron expressions without crashing.
  - **Repro:** Create two cron routines, toggle one off, edit the other's schedule, call `window.cerebro.scheduler.sync()`, and inspect scheduler jobs/logs.
- [ ] Webhook payload resolves variables severity:P1 scope:routines
  <!-- obelisk:id=01KT12NV7QJT95PG4NQ0MJW9DB -->
  - **Expected:** `wait_for_webhook` registers `/webhooks/listen`, receives JSON on `/webhooks/catch/{listener_id}`, splats primitive trigger fields into wired inputs, completes the step, and deletes the listener.
  - **Repro:** Run a routine with `wait_for_webhook` timeout 10s, POST JSON to the emitted endpoint, then verify output payload and `GET /webhooks/catch/{id}/status` is unavailable after cleanup.
- [ ] Backup restores routine graph severity:P1 scope:routines,files
  <!-- obelisk:id=01KT12NV7QZ0M62X5XE3BRSJK4 -->
  - **Expected:** A backup archive includes the `routines` table count and restoring it preserves routine rows, `dag_json`, trigger metadata, notify channels, and related run records.
  - **Repro:** Create a routine with DAG, schedule, notify channel, and one run; POST `/backup/export`, inspect `manifest.json`, apply restore in a temp userData, and GET `/routines/{id}` plus `/engine/runs?routine_id={id}`.
- [ ] Cloud sync queues routine mutations severity:P2 scope:routines
  <!-- obelisk:id=01KT12NV7QWDBWQTXGDWA0WQ9K -->
  - **Expected:** With cloud sync enabled, routine create/update/delete operations write atomic `sync_outbox` rows for `routines` and related run/approval/step records; local-only settings are not leaked.
  - **Repro:** Enable `backend.cloud_sync.outbox.set_sync_enabled(true)`, create/update/delete a routine through `/routines`, then query `sync_outbox` for table_name `routines` and inspect payload fields.
