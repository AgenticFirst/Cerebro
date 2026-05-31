---
id: feature-src
name: Src sweep
scope: feature
feature: src
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-05-31T01:15:15.678Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Electron boots to Chat severity:P0 scope:smoke,electron
  <!-- obelisk:id=01KSXSJXTW8FD5AQS6KWNQC79N -->
  - **Expected:** Main window opens, backend health is ok, Chat is active, and no uncaught renderer/main errors appear.
  - **Repro:** Run `tail -f /dev/null | npm start &`; wait for the window, then verify `/health` and the Chat sidebar item.
- [ ] Sidebar reaches primary screens severity:P0 scope:navigation,renderer
  <!-- obelisk:id=01KSXSJXTW15FV6KMNRXBQN1DE -->
  - **Expected:** Chat, Experts, Tasks, Routines, Files, Approvals, Integrations, Skills, Knowledge Base, and Settings render their expected first view.
  - **Repro:** Click each sidebar item from a fresh boot and assert the screen header or empty state changes without console errors.
- [ ] README commands remain valid severity:P1 scope:docs,scripts
  <!-- obelisk:id=01KSXSJXTWE8F21Z3VJM086SXG -->
  - **Expected:** Documented commands map to package scripts and the referenced icon path exists.
  - **Repro:** Compare README Development commands with `package.json` scripts; verify `assets/icon-rounded.png` loads from the README image tag.
- [ ] Application icons are usable severity:P1 scope:assets,packaging
  <!-- obelisk:id=01KSXSJXTW422D8C766FG7RSTT -->
  - **Expected:** `icon.png`, `icon-rounded.png`, and `icon.icns` are non-empty valid assets and package metadata can reference them.
  - **Repro:** Inspect image metadata and run the packaging config smoke that reads the assets without throwing.
- [ ] Lint config parses TypeScript severity:P1 scope:lint,config
  <!-- obelisk:id=01KSXSJXTW1GYVF4VX8GR66WPG -->
  - **Expected:** ESLint loads `.eslintrc.json` with TypeScript, import, Electron, and Prettier rules enabled.
  - **Repro:** Run `npx eslint --print-config src/main.ts` and confirm it exits successfully with the expected parser/plugins.
- [ ] Prettier ignores generated outputs severity:P2 scope:format,config
  <!-- obelisk:id=01KSXSJXTWWTVYA50G97MNH9Q8 -->
  - **Expected:** Prettier uses single quotes, semicolons, LF endings, and skips ignored build/runtime folders.
  - **Repro:** Run `npx prettier --check src/main.ts package.json` and confirm `.prettierignore` excludes `node_modules`, `.vite`, `out`, and `backend/venv`.
- [ ] CI workflows cover both suites severity:P1 scope:ci,tests
  <!-- obelisk:id=01KSXSJXTW4V6Q30HJ6FPH6P2K -->
  - **Expected:** Test workflow has separate Node 20 frontend and Python backend jobs with dependency caching and pull request triggers.
  - **Repro:** Validate `.github/workflows/test.yml`; run workflow lint or inspect jobs for `npm run test:frontend` and backend `pytest`.
- [ ] Release paths require owner review severity:P0 scope:release,ownership
  <!-- obelisk:id=01KSXSJXTXW0T2EQC80A43BHE0 -->
  - **Expected:** Release workflow verifies tag/package version, limits release secrets to publish jobs, and CODEOWNERS maps release-sensitive paths to `@calovera`.
  - **Repro:** Validate `.github/workflows/release.yml` and `.github/CODEOWNERS`; check `.github/workflows/release.yml`, `forge.config.ts`, `scripts/`, and backend requirements ownership.
- [ ] Generated data stays untracked severity:P1 scope:git,config
  <!-- obelisk:id=01KSXSJXTXJ9CJ9ESNGHXE4Z94 -->
  - **Expected:** Runtime databases, env files, build outputs, backend virtualenvs, voice models, and bundled Python artifacts are ignored.
  - **Repro:** Run `git check-ignore` for `.env.test`, `cerebro.db`, `.vite/`, `out/`, `backend/venv/`, `voice-models/`, and `build-resources/python-runtime/`.

## Memory And Backup

- [ ] Agent memory lists markdown counts severity:P1 scope:memory,settings
  <!-- obelisk:id=01KSXSJXTX10BT2N92DZFVG53P -->
  - **Expected:** `GET /agent-memory` returns visible agent directories with markdown file counts and newest modification time.
  - **Repro:** Seed `<userData>/agent-memory/researcher/notes.md`; open Settings > Memory and call `GET /agent-memory`.
- [ ] New memory file appends extension severity:P1 scope:memory,persistence
  <!-- obelisk:id=01KSXSJXTX6EN9GDM9GKKD3DHP -->
  - **Expected:** Creating `projects/week-one` writes `projects/week-one.md`, selects it, and shows an empty editor.
  - **Repro:** In Settings > Memory select an agent, click the plus button, type `projects/week-one`, and press Enter.
- [ ] Saved memory edit survives reload severity:P1 scope:memory,persistence
  <!-- obelisk:id=01KSXSJXTXFGCG8NT2MQRFVVVN -->
  - **Expected:** Saved markdown content persists after app reload and `GET /agent-memory/{slug}/files/{path}` returns the exact content.
  - **Repro:** Edit a selected memory file, click Save, reload the app, reopen Settings > Memory, and reselect the file.
- [ ] Agent memory rejects traversal severity:P0 scope:memory,validation
  <!-- obelisk:id=01KSXSJXTXD14Z4H92K55NSREA -->
  - **Expected:** Traversal paths return 400 and no file is created outside the agent-memory root.
  - **Repro:** Call `PUT /agent-memory/researcher/files/../escape.md` with content and inspect the parent directory.
- [ ] Agent memory rejects nonmarkdown severity:P1 scope:memory,validation
  <!-- obelisk:id=01KSXSJXTXJSP2NTK17VJMF7X0 -->
  - **Expected:** Writes whose target name does not end in `.md` return 400 with `Only .md files are allowed`.
  - **Repro:** Call `PUT /agent-memory/researcher/files/secrets.txt` and verify no `secrets.txt` appears.
- [ ] Backup export records manifest severity:P0 scope:backup,persistence
  <!-- obelisk:id=01KSXSJXTX32NXSRKD3PNB62HY -->
  - **Expected:** Export creates a `.cerebro-backup` zip containing `manifest.json`, `cerebro.db`, expected folders, stats, and updates `/backup/last`.
  - **Repro:** Use Settings > Backup > Create backup, then inspect the zip and call `GET /backup/last`.
- [ ] Corrupt backup shows inspect error severity:P1 scope:backup,io
  <!-- obelisk:id=01KSXSJXTX23SGX88QCG9YRQ61 -->
  - **Expected:** Invalid archives or archives missing `manifest.json` show the inspect failure toast and do not open the restore confirmation modal.
  - **Repro:** Pick a text file renamed `.cerebro-backup` through Settings > Backup > Restore from backup.
- [ ] Restore stages rollback before relaunch severity:P0 scope:backup,restore
  <!-- obelisk:id=01KSXSJXTXPJ197WXDXT9D7D6Y -->
  - **Expected:** `POST /backup/apply` creates `.backup-rollback`, `.backup-staging`, and `.backup-pending.json` without mutating the live DB before relaunch.
  - **Repro:** Apply a valid backup through the API, inspect userData staging files, and compare live DB rows before restarting.

## Cloud Sync And Agent Runs

- [ ] Supabase connect requires DB URL severity:P1 scope:cloud-sync,validation
  <!-- obelisk:id=01KSXSJXTX4TJ72CZ9NMNP1WVK -->
  - **Expected:** Connect stays disabled until the Postgres password field has a non-empty database URL.
  - **Repro:** Open Integrations > Supabase Sync with empty `dbUrl`; verify Connect disabled, then type one character.
- [ ] Bad Supabase connection shows error severity:P1 scope:cloud-sync,network
  <!-- obelisk:id=01KSXSJXTXASWBWRJ94EKHWX3S -->
  - **Expected:** Invalid Postgres URLs return `{ok:false,error}` and the UI remains disconnected with the error visible.
  - **Repro:** Enter `postgresql://bad-host` in the DB URL field and click Connect, or call `POST /cloud-sync/test`.
- [ ] Successful Supabase connect starts worker severity:P0 scope:cloud-sync,runtime
  <!-- obelisk:id=01KSXSJXTXETNWQ9FP7CVX7MDY -->
  - **Expected:** `POST /cloud-sync/connect` starts the sync worker, status becomes connected, seed option is honored, and secret fields clear in the UI.
  - **Repro:** Connect with a test Supabase Postgres URL and optional storage settings; poll `GET /cloud-sync/status`.
- [ ] Sync trigger refreshes status severity:P1 scope:cloud-sync,io
  <!-- obelisk:id=01KSXSJXTXKMDW69PJQQZXWW8N -->
  - **Expected:** Sync Now calls `/cloud-sync/trigger`, wakes the worker, and refreshes pending count, last synced time, and last error display.
  - **Repro:** With sync connected, click Sync Now and watch the status cells update after the 600 ms refresh.
- [ ] Disconnect stops outbox capture severity:P1 scope:cloud-sync,persistence
  <!-- obelisk:id=01KSXSJXTX3BWHCHCTR95NSZWK -->
  - **Expected:** Disconnect stops the worker, status becomes disabled, and later local writes do not enqueue sync outbox rows.
  - **Repro:** Click Disconnect, create or edit a conversation, then inspect `sync_outbox` for no new rows.
- [ ] Seed skips local-only settings severity:P0 scope:cloud-sync,privacy
  <!-- obelisk:id=01KSXSJXTXYC62D9A7JQK20EPF -->
  - **Expected:** Initial seed enqueues synced tables but excludes credential and device-local settings with `telegram_`, `hubspot_`, `github_`, `sandbox:`, and `sync:` prefixes.
  - **Repro:** Insert settings with those prefixes, call `/cloud-sync/connect` with `seed:true`, and inspect outbox payloads.
- [ ] Agent run lifecycle persists tools severity:P1 scope:agent-runs,persistence
  <!-- obelisk:id=01KSXSJXTXSSQB2CMZBBBQDEQ9 -->
  - **Expected:** Create, patch, and fetch agent runs preserve status, token counts, errors, completion time, and `tools_used` as a JSON array.
  - **Repro:** Call `POST /agent-runs`, `PATCH /agent-runs/{id}` with `tools_used`, then `GET /agent-runs/{id}`.
- [ ] Agent run filters validate pagination severity:P1 scope:agent-runs,validation
  <!-- obelisk:id=01KSXSJXTXQXH3HVVTV3254B4V -->
  - **Expected:** Filtering by conversation, expert, and status returns ordered totals; invalid `offset` or `limit > 200` returns 422.
  - **Repro:** Seed multiple runs, call `GET /agent-runs?conversation_id=...&status=running`, then try `offset=-1` and `limit=201`.
