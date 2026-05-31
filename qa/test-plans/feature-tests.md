---
id: feature-tests
name: __tests__ sweep
scope: feature
feature: __tests__
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-05-31T01:26:20.957Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Test workflow runs both suites severity:P0 scope:ci,tests
  <!-- obelisk:id=01KSXT77GXQZSDGY44RFH6E6KZ -->
  - **Expected:** GitHub Actions workflow `Tests` has separate `frontend-tests` and `backend-tests` jobs that run `npm run test:frontend` and `python -m pytest -v` on PRs to `main`.
  - **Repro:** Inspect `.github/workflows/test.yml`; verify push and pull_request triggers target `main`, Node 20 is used for frontend, Python 3.12 is used for backend, and backend tests run from `backend`.
- [ ] Frontend tests collect without config errors severity:P0 scope:frontend,tests
  <!-- obelisk:id=01KSXT77GXEWTPYXR65AH16AJH -->
  - **Expected:** Vitest discovers `src/**/__tests__`, `*.test.ts`, and `*.test.tsx` without ESLint or module-resolution failures.
  - **Repro:** Run `npm run test:frontend`; confirm collection includes representative files under `src/engine/__tests__`, `src/agents/__tests__`, and `src/components/screens/__tests__`.
- [ ] Backend tests isolate temporary state severity:P0 scope:backend,fixtures
  <!-- obelisk:id=01KSXT77GXBWTMBKTM1R61P4H9 -->
  - **Expected:** Each backend pytest using `client` gets a fresh SQLite database and fresh `agent-memory` root, so test order does not affect results.
  - **Repro:** Run `cd backend && venv/bin/python -m pytest -v tests/test_agent_memory.py tests/test_expert_context.py`; verify repeated runs do not reuse rows or files.
- [ ] App boots backend healthily severity:P0 scope:smoke,startup
  <!-- obelisk:id=01KSXT77GX9CYQG6CEC1S1JCCC -->
  - **Expected:** Electron starts the FastAPI backend with `--agent-memory-dir` set, app shell loads, and no uncaught main-process startup errors appear.
  - **Repro:** Launch with `tail -f /dev/null | npm start &`; watch logs until backend port is printed, then navigate the app to Settings and Experts.
- [ ] Settings integrations screen reaches Supabase severity:P1 scope:supabase,ui
  <!-- obelisk:id=01KSXT77GXCSJ2T07ZRJC38M4S -->
  - **Expected:** Connected Apps renders the Supabase card and its form/status panel without crashing when status is disconnected.
  - **Repro:** Open Settings > Connected Apps > Supabase; verify database URL, project URL, service key, bucket, seed checkbox, and Connect button render.
- [ ] Project metadata remains parseable severity:P1 scope:metadata,configuration
  <!-- obelisk:id=01KSXT77GXQ0SR757ZTYNGZ7A0 -->
  - **Expected:** Repository metadata files used by tests and CI are syntactically valid: `.eslintrc.json`, `.prettierrc.json`, `.gitignore`, `.prettierignore`, README, AGENTS, CLAUDE, CONTRIBUTING, LICENSE.
  - **Repro:** Parse JSON files with Node, run `git check-ignore node_modules .vite out backend/venv coverage`, and verify Markdown files render headings and fenced commands.

## Backend Agent State APIs

- [ ] Create expert assigns defaults severity:P0 scope:experts,skills
  <!-- obelisk:id=01KSXT77GXTT13C95HM4XR6B4C -->
  - **Expected:** `POST /experts` returns 201 with generated `id`, default `type=expert`, `source=user`, `is_enabled=true`, `max_turns=10`, `token_budget=25000`, and default skills are assigned.
  - **Repro:** Use backend `client`; post `{ "name": "QA Analyst", "description": "Finds regressions" }` to `/experts`, then call `/experts/{id}` and `/experts/{id}/skills`.
- [ ] List experts filters and orders severity:P1 scope:experts,query
  <!-- obelisk:id=01KSXT77GXEZWSKBEGPJA36XWK -->
  - **Expected:** `GET /experts` respects `type`, `source`, `is_enabled`, `search`, `offset`, and `limit`; pinned experts sort before unpinned experts by name.
  - **Repro:** Create pinned, disabled, team, and user experts; call `/experts?type=team`, `/experts?is_enabled=false`, `/experts?search=qa`, and `/experts?limit=1&offset=1`.
- [ ] Verified expert locks body fields severity:P0 scope:experts,validation
  <!-- obelisk:id=01KSXT77GXCC5TJSPBDF61S29M -->
  - **Expected:** Patching a verified expert allows only `is_enabled` and `is_pinned`; attempts to change `name`, `description`, `system_prompt`, or `slug` return 403.
  - **Repro:** Seed or insert an expert with `is_verified=true`; PATCH `/experts/{id}` with `{ "name": "Changed" }`, then PATCH `{ "is_enabled": false }`.
- [ ] Agent run lifecycle persists severity:P0 scope:agent-runs,persistence
  <!-- obelisk:id=01KSXT77GXTW1HMXVXNC4JD6JB -->
  - **Expected:** `POST /agent-runs`, `PATCH /agent-runs/{id}`, `GET /agent-runs/{id}`, and filtered `GET /agent-runs` preserve status, turns, tokens, parent_run_id, tools_used, error, and completed_at.
  - **Repro:** Create parent and child runs with conversation and expert IDs; patch child to completed with `tools_used:["search_web"]`; list by `conversation_id`, `expert_id`, and `status`.
- [ ] Agent run pagination is bounded severity:P1 scope:agent-runs,validation
  <!-- obelisk:id=01KSXT77GXF9BHRAR5AY560GA3 -->
  - **Expected:** `GET /agent-runs` rejects negative offsets, zero limits, and limits above 200; valid pagination returns `total` and newest runs first.
  - **Repro:** Create three runs with distinct `started_at`; call `/agent-runs?offset=-1`, `/agent-runs?limit=0`, `/agent-runs?limit=201`, and `/agent-runs?limit=2`.
- [ ] Memory file browser confines paths severity:P0 scope:agent-memory,security
  <!-- obelisk:id=01KSXT77GXDBM200TB3Z9KP3T8 -->
  - **Expected:** `/agent-memory/{slug}/files/{path}` rejects invalid slugs, absolute paths, dot-prefixed slugs, traversal paths, and non-`.md` writes without reading or writing outside the root.
  - **Repro:** Call PUT/GET/DELETE against `/agent-memory/.hidden/files/a.md`, `/agent-memory/a/files/../../escape.md`, and `/agent-memory/a/files/script.py`; verify 400 and no outside file appears.
- [ ] Memory CRUD refreshes listings severity:P0 scope:agent-memory,persistence
  <!-- obelisk:id=01KSXT77GX3V16P7AM1ZWRX3F7 -->
  - **Expected:** Creating, overwriting, reading, listing, and deleting nested markdown files updates `file_count`, file size, relative path, content, and `last_modified` consistently.
  - **Repro:** PUT `/agent-memory/cerebro/files/routines/2026-05-30.md`, GET `/agent-memory`, GET `/agent-memory/cerebro/files`, GET the file, DELETE it, then verify GET returns 404.
- [ ] Expert context attaches parsed files severity:P0 scope:expert-context,files
  <!-- obelisk:id=01KSXT77GXQQ53PPGKPCR2FMK6 -->
  - **Expected:** `POST /experts/{id}/context-files` stores an existing `FileItem`, calculates parsed char_count/truncated, returns joined file metadata, and lists in sort order.
  - **Repro:** Create expert, register a `.docx` through `/files/items/from-path`, parse it through `/files/parse`, attach with `kind=template`, then GET `/experts/{id}/context-files`.

## Sync And Test Metadata

- [ ] Cloud sync status starts disabled severity:P1 scope:cloud-sync,status
  <!-- obelisk:id=01KSXT77GXEF5E9PKNRWJVJ2XA -->
  - **Expected:** `GET /cloud-sync/status` returns a stable disconnected or idle snapshot with `status`, `last_synced_at`, `last_error`, and `pending` without requiring Supabase credentials.
  - **Repro:** With no Supabase env or saved connection, call `/cloud-sync/status` through TestClient and through the Settings Supabase panel.
- [ ] Connection test reports schema failures severity:P0 scope:cloud-sync,network
  <!-- obelisk:id=01KSXT77GX1W6KDX3WAT2MA44S -->
  - **Expected:** `POST /cloud-sync/test` returns `{ok:false,error}` for invalid Postgres URLs or unreachable hosts, and does not start the background worker.
  - **Repro:** POST `{ "db_url": "postgresql+psycopg://bad" }` to `/cloud-sync/test`; then GET `/cloud-sync/status` and verify no connected worker state.
- [ ] Connect with seed enqueues rows severity:P0 scope:cloud-sync,seed
  <!-- obelisk:id=01KSXT77GXQKBCP7XS04AP1D3J -->
  - **Expected:** `POST /cloud-sync/connect` with `seed=true` calls `seed_outbox`, skips local-only settings like `sync:*`, starts the worker, and reports pending seeded rows.
  - **Repro:** Insert local experts, conversations, files, and a `sync:cursor` setting; monkeypatch remote engine startup; POST `/cloud-sync/connect` with `seed:true`; inspect `sync_outbox`.
- [ ] Worker retries offline push severity:P0 scope:cloud-sync,worker
  <!-- obelisk:id=01KSXT77GXZ8609WTE2AEFPDSH -->
  - **Expected:** A failed sync tick sets status `offline`, records `last_error`, leaves pending outbox rows unchanged, and succeeds on a later trigger when the remote is available.
  - **Repro:** Create a `SyncWorker` with a build_engine monkeypatch that raises once, then succeeds; call `_tick` or `/cloud-sync/trigger`; assert pending count remains then drains.
- [ ] Storage errors do not break sync severity:P1 scope:cloud-sync,storage
  <!-- obelisk:id=01KSXT77GX8XQGW0DTJN39RZN2 -->
  - **Expected:** Supabase Storage bucket, upload, and download failures are logged and return false/None without failing row-level push or pull.
  - **Repro:** Use `SupabaseStorage` with an httpx mock returning 500 and raising timeout; call `ensure_bucket`, `upload`, and `download`; verify no exception escapes.
- [ ] Remote schema is idempotent severity:P1 scope:cloud-sync,schema
  <!-- obelisk:id=01KSXT77GXSBWRH8DV1P6YAPPE -->
  - **Expected:** `ensure_remote_schema` creates mirror tables for configured synced tables, adds `server_updated_at`, creates `sync_tombstones`, and can run twice without error.
  - **Repro:** Run `ensure_remote_schema` against a disposable SQLAlchemy engine; inspect `remote_metadata.tables` and call `remote_columns(table)` for a representative synced table.
- [ ] CI ownership protects sensitive files severity:P1 scope:ci,codeowners
  <!-- obelisk:id=01KSXT77GX1Q5128XM12WGYRGN -->
  - **Expected:** CODEOWNERS requires `@calovera` review for `.github/`, workflow files, packaging scripts, `package.json`, lockfile, build manifests, and Python bundle inputs.
  - **Repro:** Parse `.github/CODEOWNERS`; assert each sensitive path listed in comments has an owner and no broader later rule removes ownership.
- [ ] Formatting and ignore rules match scripts severity:P1 scope:formatting,configuration
  <!-- obelisk:id=01KSXT77GX6GJFNE7M76WS24VV -->
  - **Expected:** Prettier and ESLint configs align with `package.json` scripts, and ignored generated outputs include `node_modules`, `.vite`, `out`, `dist`, `backend/venv`, coverage, pytest cache, and Playwright artifacts.
  - **Repro:** Run `npm run format:check` and `npm run lint`; inspect `.prettierrc.json`, `.prettierignore`, `.eslintrc.json`, and `.gitignore` for script-compatible patterns.
- [ ] Brand icons remain packageable severity:P2 scope:assets,packaging
  <!-- obelisk:id=01KSXT77GXDW276J5Y5H2NY0PS -->
  - **Expected:** `assets/icon.png` and `assets/icon-rounded.png` remain valid 1024x1024 RGBA PNGs, and `assets/icon.icns` remains a valid macOS icon resource referenced by packaging/docs.
  - **Repro:** Run `file assets/icon-rounded.png assets/icon.png assets/icon.icns`; verify README references `assets/icon-rounded.png` and package/make flow can read icon assets.
