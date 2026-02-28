# Chat Persistence — Test Plan

Living document tracking test coverage for Cerebro's chat persistence layer.

## Running Tests

```bash
# All tests
npm test

# Backend only
npm run test:backend

# Frontend only
npm run test:frontend
```

## Backend Tests (`backend/tests/test_conversations.py`)

Each test gets a fresh temp SQLite database via the `client` fixture in `tests/conftest.py`.

| # | Test | Endpoint | Verifies |
|---|------|----------|----------|
| 1 | `test_create_conversation` | `POST /conversations` | Returns 201 with correct shape (id, title, timestamps, empty messages) |
| 2 | `test_duplicate_conversation_returns_409` | `POST /conversations` | Second POST with same ID returns 409 |
| 3 | `test_create_message_and_list` | `POST .../messages`, `GET /conversations` | Message appears nested in conversation list; `updated_at` bumped |
| 4 | `test_message_to_missing_conversation_returns_404` | `POST .../messages` | Returns 404 for non-existent conversation |
| 5 | `test_delete_conversation_cascades` | `DELETE /conversations/:id` | Conv + messages removed; GET returns empty list |
| 6 | `test_delete_nonexistent_returns_404` | `DELETE /conversations/:id` | Returns 404 for unknown ID |

## Frontend Tests (`src/context/__tests__/chat-helpers.test.ts`)

| # | Test | Verifies |
|---|------|----------|
| 7 | `generateId format` | Returns 32-char hex string (no dashes) — matches backend `String(32)` PK |
| 8 | `titleFromContent truncation` | Short strings pass through; >40 chars truncated with `...` |
| 9 | `fromApiConversation mapping` | Snake_case API JSON → camelCase `Conversation` with `Date` objects; null → undefined |

## Test Infrastructure

- **Backend**: pytest + FastAPI TestClient (httpx transport), temp SQLite per test
  - Config: `backend/pyproject.toml` — sets `testpaths` and `pythonpath`
  - Tests: `backend/tests/` — one file per feature (e.g. `test_conversations.py`)
  - Fixtures: `backend/tests/conftest.py` — pytest magic name; auto-loaded to share fixtures across all test files
- **Frontend**: Vitest with standalone `vitest.config.ts` (avoids Electron Forge Vite config conflicts)
  - Tests colocated in `__tests__/` folders next to the modules they test
  - Setup: `src/test-setup.ts` — polyfills `crypto` for Node test environment
- **Extracted helpers**: `src/context/chat-helpers.ts` — pure functions + API types pulled from ChatContext for testability

## Directory Structure

```
backend/
  tests/
    conftest.py              # pytest auto-loads this — shared fixtures (TestClient, temp DB)
    test_conversations.py    # conversation + message CRUD
  pyproject.toml             # pytest config

src/
  context/
    chat-helpers.ts          # extracted pure functions + API types
    __tests__/
      chat-helpers.test.ts   # unit tests for chat helpers
  test-setup.ts              # vitest global setup (crypto polyfill)

docs/
  test-plans/
    chat-persistence.md      # this file
```