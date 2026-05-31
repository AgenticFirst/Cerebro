---
id: feature-backend
name: Backend sweep
scope: feature
feature: backend
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-05-31T01:20:59.790Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Backend CLI honors custom data paths severity:P0 scope:backend,startup
  <!-- obelisk:id=01KSXSXDWEH6C7QZ67ZT2PPV24 -->
  - **Expected:** FastAPI starts, creates db_path, files_dir, parsed_files_dir, voice_models_dir, and agent_memory_dir, and GET /health returns {"status":"ok"}.
  - **Repro:** Run backend/main.py with --db-path, --files-dir, --agent-memory-dir, and --voice-models-dir pointing at a temp directory; request GET /health.
- [ ] Electron backend spawn reaches health severity:P0 scope:electron,startup
  <!-- obelisk:id=01KSXSXDWEKK96RHC3XQEYE5H8 -->
  - **Expected:** src/main.ts spawns backend/main.py with userData paths, waits for /health, marks backendStatus healthy, and exposes backend requests.
  - **Repro:** Launch with tail -f /dev/null | npm start &, watch logs for Python backend ready, then call renderer backend proxy for GET /health.
- [ ] CI backend job runs from backend severity:P1 scope:ci,backend
  <!-- obelisk:id=01KSXSXDWE5ZQP0MMHSHN5BMH1 -->
  - **Expected:** .github/workflows/test.yml installs backend/requirements-ci.txt and runs python -m pytest -v with working-directory backend on pull requests.
  - **Repro:** Inspect workflow or run action locally with act; verify backend-tests job uses setup-python 3.12 and the backend working directory.
- [ ] Ignored backend artifacts stay untracked severity:P1 scope:config,persistence
  <!-- obelisk:id=01KSXSXDWEATYXF0QGT8R5WY37 -->
  - **Expected:** .gitignore and .prettierignore exclude backend/venv, __pycache__, pytest cache, SQLite db/wal/journal files, .vite, dist, and out.
  - **Repro:** Create temp backend/venv, backend/__pycache__/x.pyc, backend/test.db-wal, and .vite files; run git status --short and prettier check.
- [ ] Project metadata assets load cleanly severity:P2 scope:docs,assets
  <!-- obelisk:id=01KSXSXDWE1E109GK676Q51F3F -->
  - **Expected:** README references existing icon assets, LICENSE exists, and assets/icon.png, icon-rounded.png, and icon.icns are readable valid image files.
  - **Repro:** Run file assets/icon.png assets/icon-rounded.png assets/icon.icns and verify README image/link paths for assets and LICENSE resolve.
- [ ] Lint and format configs parse severity:P2 scope:config,tooling
  <!-- obelisk:id=01KSXSXDWEWBM4VC79W4ZMVVAJ -->
  - **Expected:** .eslintrc.json and .prettierrc.json parse as JSON and support npm run lint and npm run format:check without config-load failures.
  - **Repro:** Run node -e JSON.parse on both config files, then run npm run lint and npm run format:check on a clean checkout.

## Agent State

- [ ] Create delegated agent run succeeds severity:P0 scope:agent-runs
  <!-- obelisk:id=01KSXSXDWEBKEGV8G5966CJBH6 -->
  - **Expected:** POST /agent-runs returns 201 with id, status, parent_run_id, expert_id, conversation_id, turns 0, total_tokens 0, and started_at.
  - **Repro:** Create an expert, then POST /agent-runs with id, expert_id, conversation_id, parent_run_id, and status running.
- [ ] Complete run serializes tool list severity:P0 scope:agent-runs,persistence
  <!-- obelisk:id=01KSXSXDWESBHF6WRCTJZDZH5F -->
  - **Expected:** PATCH /agent-runs/{run_id} persists status completed, turns, total_tokens, tools_used as a list, error null, and completed_at.
  - **Repro:** Create a run, PATCH it with tools_used ["Read","Bash"], completed_at ISO timestamp, turns 4, total_tokens 1200; GET the run.
- [ ] List runs filters and paginates severity:P1 scope:agent-runs
  <!-- obelisk:id=01KSXSXDWE839SXC7CVZ2HTAXS -->
  - **Expected:** GET /agent-runs applies conversation_id, expert_id, status, offset, and limit, returns matching runs newest first and an accurate total.
  - **Repro:** Seed multiple running/completed runs across two experts and conversations; query /agent-runs?expert_id=...&status=completed&limit=1&offset=1.
- [ ] Agent memory write survives restart severity:P0 scope:agent-memory,persistence
  <!-- obelisk:id=01KSXSXDWEA2EKE9PFVQKPH1S7 -->
  - **Expected:** PUT /agent-memory/{slug}/files/{path} creates parent directories, writes UTF-8 markdown, and GET returns the same content after backend restart.
  - **Repro:** PUT /agent-memory/cerebro/files/routines/2026-05-30.md with markdown, rebuild TestClient using the same temp agent_memory_dir, then GET it.
- [ ] Agent memory traversal is rejected severity:P0 scope:agent-memory,validation
  <!-- obelisk:id=01KSXSXDWEMFAGW5XQ8XKGZ7Y7 -->
  - **Expected:** Encoded dot-dot paths, encoded absolute paths, backslash slugs, and dot-prefixed slugs return 400 and never read or write outside agent_memory_dir.
  - **Repro:** Call GET, PUT, and DELETE using /agent-memory/test/files/%2E%2E/%2E%2E/etc/passwd.md and GET /agent-memory/.hidden/files.
- [ ] Agent memory delete is idempotent severity:P1 scope:agent-memory,io
  <!-- obelisk:id=01KSXSXDWEYMWY6QNASDDRHWDT -->
  - **Expected:** DELETE /agent-memory/{slug}/files/{path} returns 204 for existing and missing files; deleted files then return 404 on GET.
  - **Repro:** Create agent-memory/deleter/remove.md, DELETE it twice through the API, then GET /agent-memory/deleter/files/remove.md.
- [ ] Attach parsed expert context file severity:P0 scope:expert-context,files
  <!-- obelisk:id=01KSXSXDWEGQS0NEYWWH56VWVD -->
  - **Expected:** POST /experts/{expert_id}/context-files returns joined file metadata, parsed_text_path, char_count, truncated flag, and default sort_order.
  - **Repro:** Create expert, register a docx through /files/items/from-path, parse it with /files/parse, then attach with kind template.
- [ ] Context file validation returns precise errors severity:P1 scope:expert-context,validation
  <!-- obelisk:id=01KSXSXDWEE5S90RVZXB7THDB5 -->
  - **Expected:** Missing expert returns 404, missing or soft-deleted FileItem returns 404 or is hidden from list, and invalid kind returns 400.
  - **Repro:** POST /experts/nope/context-files, POST with file_item_id missing, POST with kind bogus, then soft-delete an attached file and list.

## Cloud Sync

- [ ] Disconnected status is stable severity:P0 scope:cloud-sync,status
  <!-- obelisk:id=01KSXSXDWE8TK4D9HF927JAZVP -->
  - **Expected:** GET /cloud-sync/status returns status disabled, pending 0, last_synced_at null, and last_error null when no worker is running.
  - **Repro:** Start backend without CEREBRO_SUPABASE_DB_URL and call GET /cloud-sync/status before any connect request.
- [ ] Connection test reports failures severity:P0 scope:cloud-sync,network
  <!-- obelisk:id=01KSXSXDWEHXM1WAX4V60RNKM1 -->
  - **Expected:** POST /cloud-sync/test with an unreachable or malformed db_url returns 200 with ok false and a non-empty error, not an uncaught 500.
  - **Repro:** POST /cloud-sync/test using db_url postgresql+psycopg://bad:bad@127.0.0.1:1/postgres.
- [ ] Seed connect enqueues existing rows severity:P0 scope:cloud-sync,outbox,persistence
  <!-- obelisk:id=01KSXSXDWEN6952QBTRX4QB06G -->
  - **Expected:** POST /cloud-sync/connect with seed true calls seed_outbox, enqueues insert rows for synced tables, and skips local-only settings keys.
  - **Repro:** Seed experts, conversations, settings github_token and sync:cursor; monkeypatch runtime.start_sync; POST /cloud-sync/connect with seed true.
- [ ] Outbox captures atomic row changes severity:P0 scope:cloud-sync,outbox
  <!-- obelisk:id=01KSXSXDWEY4FQZMQF0ARWD6YH -->
  - **Expected:** When sync is enabled, insert/update/delete on synced models creates pending SyncOutbox rows in the same transaction with materialized defaults.
  - **Repro:** Call set_sync_enabled(True), create/update/delete an Expert in one SQLAlchemy session, then inspect sync_outbox payload_json and row_pk.
- [ ] Remote apply avoids echo loops severity:P0 scope:cloud-sync,outbox
  <!-- obelisk:id=01KSXSXDWEVP5Y6XRJ660B5410 -->
  - **Expected:** Sessions marked cloud_sync_apply do not create new SyncOutbox rows, and sync: settings remain local-only.
  - **Repro:** Set session.info["cloud_sync_apply"] = True, upsert an Expert and Setting key sync:cursor, commit, then count pending outbox rows.
- [ ] Offline worker preserves pending rows severity:P0 scope:cloud-sync,network
  <!-- obelisk:id=01KSXSXDWEJ3XEMZWYMKTZ1ZPG -->
  - **Expected:** SyncWorker startup or tick failure sets status offline, stores last_error, and leaves pending SyncOutbox rows for retry.
  - **Repro:** Instantiate SyncWorker with an invalid Postgres URL and a temp SQLite database containing one pending SyncOutbox row; run one tick or start cycle.
- [ ] Push applies last-write-wins tombstones severity:P1 scope:cloud-sync,persistence
  <!-- obelisk:id=01KSXSXDWEAGQ5995Y2N6398ZK -->
  - **Expected:** Worker push upserts newer rows, does not overwrite newer remote rows with stale local payloads, deletes remote rows, and writes sync_tombstones.
  - **Repro:** Use a test Postgres or mocked engine with remote_metadata; enqueue update payloads with older/newer updated_at and one delete op.
- [ ] Pull persists cursor and deletions severity:P1 scope:cloud-sync,persistence
  <!-- obelisk:id=01KSXSXDWE9VQY5V6ZWQPAG3ED -->
  - **Expected:** Worker pull applies remote rows locally without outbox echo, deletes local rows from tombstones, and stores sync:cursor as a local-only setting.
  - **Repro:** Seed remote mirror tables and sync_tombstones with server_updated_at values; run _pull and inspect local rows plus Setting key sync:cursor.
- [ ] Storage failures do not break sync severity:P1 scope:cloud-sync,io
  <!-- obelisk:id=01KSXSXDWESF91549Y3DBDK2JE -->
  - **Expected:** SupabaseStorage upload/download timeouts, 404s, and 500s return false or null, log warnings, and do not fail row-level sync.
  - **Repro:** Monkeypatch httpx.Client post/get to raise timeout and return 404/500; call ensure_bucket, upload, download, and worker blob upload/download.
