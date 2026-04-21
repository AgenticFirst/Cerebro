# Knowledge Nodes — Test Plan

Living document for the four Routines *Knowledge* actions after the April 2026 redesign. All four actions route through `singleShotClaudeCode()` — there is no Tavily, no vector DB, and no bespoke memory service — so the tests below lock in the expected contract between each action, Claude Code, and the already-shipped backend routers (`/agent-memory/*`, `/files/buckets/*`).

| Node | Action file | Retrieval | Writes |
|---|---|---|---|
| Search Memory | `src/engine/actions/search-memory.ts` | `singleShotClaudeCode` with `Read,Glob,Grep` tools scoped to `<agent-memory>/<slug>/` | — |
| Search Web | `src/engine/actions/search-web.ts` | `singleShotClaudeCode` with `WebSearch,WebFetch` | — |
| Search Documents | `src/engine/actions/search-documents.ts` | `GET /files/buckets/{id}/contents`, then `singleShotClaudeCode` with `Read,Glob,Grep` | — |
| Save to Memory | `src/engine/actions/save-to-memory.ts` | optional `singleShotClaudeCode` (extract mode) | `GET/PUT /agent-memory/{slug}/files/routines/{yyyy-mm-dd}.md` |

## Running Tests

```bash
# Backend (pytest)
npm run test:backend

# Engine / action unit + integration (vitest)
npm run test:frontend
#   — or narrow to knowledge:
npx vitest run src/engine/__tests__/search-memory.test.ts \
               src/engine/__tests__/search-web.test.ts \
               src/engine/__tests__/search-documents.test.ts \
               src/engine/__tests__/save-to-memory.test.ts \
               src/engine/__tests__/knowledge-nodes-integration.test.ts

# E2E (requires running app + Claude Code CLI logged in)
CEREBRO_E2E_DEBUG_PORT=9229 npm start          # terminal 1
npx playwright test e2e/routines-knowledge-nodes.spec.ts  # terminal 2
```

## LLM model policy for tests

- **Unit tests** mock `singleShotClaudeCode` — no live model call. They assert that the `model` param is *forwarded* to the subprocess, not that any specific default is used.
- **E2E tests** call the real Claude Code CLI and therefore consume tokens. Every e2e routine below pins `model: 'claude-sonnet-4-6'` on the step params, matching the product's "Sonnet for knowledge tasks in tests" rule. Do not swap to Haiku in e2e — we want failures that reflect production-grade output quality.

---

## 1. Search Memory

### Target behaviors

- Resolves the agent slug: `params.agent` if non-empty else `'cerebro'` (global).
- Builds a prompt that (a) names the scope ("your own notes" vs "your global notes"), (b) includes the query verbatim, (c) asks for `max_results` items, (d) requests JSON array `[{content, source, score}]`.
- Calls `singleShotClaudeCode({ agent, allowedTools: 'Read,Glob,Grep', maxTurns: 3 })`. Forwards `params.model` when provided.
- Parses the response, tolerating code fences around the JSON.
- Falls back to a single free-text result if the response isn't parseable JSON.
- Caps the returned array at `max_results` (default 5).
- Rejects empty/whitespace query with `Error("Search memory requires a query")`.

### Unit tests (`src/engine/__tests__/search-memory.test.ts`)

| # | Test | Verifies |
|---|---|---|
| SM-U1 | `parses well-formed JSON array` | Claude returns `[{content, source, score}]` → those exact rows land in `result.data.results`, `count` matches |
| SM-U2 | `strips code fences around the JSON` | `` ```json\n[…]\n``` `` output still parses |
| SM-U3 | `caps results at max_results` | Mock returns 10 entries, `max_results: 3` → only 3 returned |
| SM-U4 | `falls back to single free-text row when not JSON` | Non-JSON reply surfaces as one row with that text and `score: 0` |
| SM-U5 | `empty reply returns zero rows` | Empty Claude output → `results: []`, `count: 0` |
| SM-U6 | `defaults agent to "cerebro" for global scope` | Missing `agent` param → subprocess spawned with `agent: 'cerebro'` |
| SM-U7 | `forwards expert slug when provided` | `agent: 'marketing'` → spawned with `agent: 'marketing'`, prompt scope label switches to "your own notes" |
| SM-U8 | `passes Read,Glob,Grep as allowedTools` | `allowedTools` option forwarded verbatim |
| SM-U9 | `forwards model override` | `params.model: 'claude-sonnet-4-6'` → single-shot called with that model |
| SM-U10 | `empty query throws validation error` | `query: '   '` → rejects with `/requires a query/` |

### Integration (`knowledge-nodes-integration.test.ts`)
- **SM-I1** — A one-step routine with `search_memory` runs end-to-end: event stream has `step_started → step_completed` for the node, the `step_completed` summary mentions the agent, and no `step_failed` is emitted.

### E2E (`e2e/routines-knowledge-nodes.spec.ts`)
- **SM-E1** — After a preceding `save_to_memory` step writes a known fact into `cerebro` memory, `search_memory` on that fact returns at least one result whose snippet contains the written keyword. Proves the write/read pair are consistent against the real agent-memory router and the real Claude Code CLI.

---

## 2. Search Web

### Target behaviors

- Builds a prompt requesting JSON `{results: [...], ai_answer?: string}`, drops `ai_answer` from the shape when `include_ai_answer` is false.
- Calls `singleShotClaudeCode({ agent: 'cerebro', allowedTools: 'WebSearch,WebFetch', maxTurns: 4 })`.
- Parses JSON with fence tolerance and leading/trailing prose tolerance.
- Coerces objects missing `snippet` but having `content` into the snippet field. Drops rows without a URL.
- `ai_answer` returned as `null` when `include_ai_answer: false`, regardless of what Claude emits.
- Caps results at `max_results` (default 5).
- Rejects empty query with `Error("Web search requires a query")`.

### Unit tests (`src/engine/__tests__/search-web.test.ts`) — already written

| # | Test | Status |
|---|---|---|
| SW-U1 | `parses JSON results from Claude Code output` | ✅ |
| SW-U2 | `strips code fences around the JSON` | ✅ |
| SW-U3 | `suppresses ai_answer when include_ai_answer is false` | ✅ |
| SW-U4 | `throws when query is missing` | ✅ |

Adds below (to extend coverage):

| # | Test | Verifies |
|---|---|---|
| SW-U5 | `coerces `content` field into snippet` | Rows with `content` but no `snippet` are reshaped |
| SW-U6 | `drops rows with no url` | Malformed row without a URL is filtered out |
| SW-U7 | `caps results at max_results` | Mock returns 8 rows, `max_results: 3` → 3 returned |
| SW-U8 | `passes WebSearch,WebFetch as allowedTools` | `allowedTools` option forwarded verbatim |
| SW-U9 | `forwards model override` | `model: 'claude-sonnet-4-6'` → forwarded |

### Integration
- **SW-I1** — `search_web` as a one-step routine runs to completion with step_completed summary mentioning the hit count. (Mocked Claude, real engine.)

### E2E
- **SW-E1** — A routine with `search_web` querying `"Anthropic claude model family"` against the real CLI using sonnet returns at least one result whose URL contains `anthropic.com` *or* `claude`.

---

## 3. Search Documents

### Target behaviors

- Requires `bucket_id`; throws if absent.
- Fetches bucket contents via `GET /files/buckets/{bucket_id}/contents?limit=50`.
- Short-circuits to `{results: [], count: 0}` with a `'Bucket is empty'` summary when the bucket has zero files — does NOT call the LLM.
- Builds a prompt that includes the file list (absolute paths + names + extensions) and asks Claude to answer the query.
- Calls `singleShotClaudeCode({ agent: 'cerebro', allowedTools: 'Read,Glob,Grep', maxTurns: 6 })`.
- Parses JSON array `[{path, snippet, score}]`, tolerant of fences and leading `[`/trailing `]`.
- Caps results at `max_results` (default 5).
- Empty query → `Error("Search documents requires a query")`.
- Missing bucket → `Error("Search documents requires a bucket — pick one in the step config")`.

### Unit tests (`src/engine/__tests__/search-documents.test.ts`)

| # | Test | Verifies |
|---|---|---|
| SD-U1 | `empty bucket short-circuits without calling Claude` | `backendFetch` returns `[]` → no singleShot call, `count: 0` |
| SD-U2 | `includes file paths in the prompt` | Bucket with 2 files → prompt passed to singleShot references both `abs_path`s |
| SD-U3 | `parses JSON array of hits` | Mock returns `[{path, snippet, score}]` → rows surfaced |
| SD-U4 | `strips fences around JSON array` | Fenced output parses |
| SD-U5 | `caps results at max_results` | 10 hits, `max_results: 2` → 2 returned |
| SD-U6 | `passes Read,Glob,Grep as allowedTools` | Verified |
| SD-U7 | `forwards model override` | `model` forwarded |
| SD-U8 | `empty query throws` | Validation |
| SD-U9 | `missing bucket_id throws` | Validation |
| SD-U10 | `malformed response returns empty list` | Non-JSON reply → `results: []` — does NOT crash |

### Backend tests (`backend/tests/test_files.py`) — already written

- Empty bucket, unknown bucket (404), managed-path resolution against `files_dir`, workspace absolute pass-through, traversal rejection, soft-delete exclusion, `limit` honoring.

### Integration
- **SD-I1** — One-step routine pointing at an empty bucket completes with `step_completed` and a summary of `'Bucket is empty'`. No step_failed.

### E2E
- **SD-E1** — Create a managed bucket, upload a small text file (using the FilesContext saveExternalToFiles), add a `search_documents` step targeting that bucket with sonnet model, run the routine, and assert the Claude Code response references the uploaded file's path. (Optional if uploading in e2e is expensive — can be stubbed with a pre-seeded bucket.)

---

## 4. Save to Memory

### Target behaviors

- Resolves agent slug (same rule as Search Memory).
- In `write` mode, persists the content verbatim. In `extract` mode, first calls `singleShotClaudeCode({ agent: 'cerebro', maxTurns: 2 })` with a distillation prompt, then persists the result.
- Writes to `routines/<YYYY-MM-DD>.md` under the resolved agent's memory directory.
- Reads the existing file first via `GET /agent-memory/{slug}/files/routines/{date}.md`. If present, appends a new entry separated by two blank lines. If absent (404), starts a fresh file with a `# Routine notes — <date>` header.
- Header line: `## <YYYY-MM-DD HH:MM>` when no topic, `## <YYYY-MM-DD HH:MM> — <topic>` when topic set.
- Returns `{ saved: true, item_id: '<agent>:routines/<date>.md' }`.
- Summary mentions whether the target was global (`'Saved to global memory (date)'`) or an expert slug.
- Empty content → `Error("Save to memory requires content")`.

### Unit tests (`src/engine/__tests__/save-to-memory.test.ts`)

| # | Test | Verifies |
|---|---|---|
| STM-U1 | `write mode appends verbatim content` | No singleShot call; PUT body includes the raw content under the timestamp header |
| STM-U2 | `write mode creates fresh file when none exists` | First GET returns 404 → PUT body starts with `# Routine notes — <date>` |
| STM-U3 | `write mode appends to existing file` | GET returns existing markdown → PUT body preserves prior content + adds separator + new entry |
| STM-U4 | `topic appears in H2 header` | `topic: 'Q1'` → header line ends with `— Q1` |
| STM-U5 | `extract mode distills before writing` | singleShot called exactly once, its output becomes the body; distillation prompt references "bulleted list of standalone facts" |
| STM-U6 | `extract mode falls back to raw content when distillation returns empty` | singleShot yields `""` → raw content used as body |
| STM-U7 | `writes under cerebro by default` | PUT path includes `/agent-memory/cerebro/files/` |
| STM-U8 | `writes under expert slug when agent set` | `agent: 'coder'` → PUT path includes `/agent-memory/coder/files/` |
| STM-U9 | `date-rolling filename` | Fake timer mocked → PUT path ends with today's `YYYY-MM-DD.md` |
| STM-U10 | `forwards model override in extract mode` | Extract singleShot receives the configured model |
| STM-U11 | `empty content throws` | Validation |
| STM-U12 | `item_id matches agent:path shape` | Response schema stable |

### Backend tests (`backend/tests/test_agent_memory.py`) — already present

24 tests covering PUT/GET/DELETE, path traversal rejection, non-.md rejection, and directory listing — the substrate save_to_memory depends on.

### Integration
- **STM-I1** — `save_to_memory` as a one-step routine with `write` mode. Verify the engine emits `step_completed` with an item_id summary; no errors. Backend mock intercepts the PUT and asserts the body matches the expected markdown shape.

### E2E
- **STM-E1 (paired with SM-E1)** — A manual routine with two steps: `save_to_memory` (agent=cerebro, mode=write, content includes a uniquely tagged sentence) → `search_memory` (agent=cerebro, query=the tag). Run the routine end-to-end; the search step's `step_completed` summary reports ≥ 1 match. This is the most load-bearing test: it proves the write-then-read loop works against the real agent-memory router and the real Claude Code CLI.
- **STM-E2** — Same with `mode: 'extract'`. Verify the written file's body is a bulleted list (contains `- ` prefix), not the raw input.

---

## Cross-cutting properties verified

- **Zero hidden I/O** — unit tests mock `singleShotClaudeCode` and `backendFetch`; no real subprocess spawns, no real HTTP, no filesystem writes outside vitest's tmp scope.
- **Tests fail on bugs rather than mask them** — the unit layer pins the *exact* allowedTools string, the *exact* path shape, and the *exact* fallback behaviors so any regression in those contracts lights up a failing test rather than silently degrading behavior.
- **E2E proves the end-to-end loop** — search_memory ↔ save_to_memory are always tested as a pair so we catch mismatches between the write format and the search prompt.
- **Sonnet is pinned in e2e** — we want failures that reflect production-grade output quality, not a cheaper/weaker model that happens to pass.

## What this plan does NOT cover (deferred)

- Stress / concurrency on agent-memory writes (single-writer assumption holds for routines today).
- Deep RAG quality evaluation for `search_documents` (no eval harness yet — SD-E1 just proves the round-trip works).
- UI-level component tests (no React Testing Library is installed; Playwright covers the rendered UI paths).
