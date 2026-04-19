# Verified Teams (Beta) — Test Plan

Living document tracking test coverage for Cerebro's Verified Teams feature: 4 curated, pre-built multi-expert orchestrators (`market-research-and-business-plan`, `app-build-team`, `product-launch-team`, `code-review-team`) seeded in `backend/experts/seed.py`, materialized as Claude Code subagents by `src/claude-code/installer.ts`, and surfaced in the Hierarchy + Messages tabs behind a `beta:teams` feature flag.

The load-bearing behaviors locked down by this suite are: (a) the data contract (slugs, members, strategies, edit-protection) is exactly what `seed.py` defines; (b) flipping `beta:teams` off hides every team — no race between `FeatureFlagsContext` load and `ExpertContext` filter; (c) the live coordination pipeline actually engages — the coordinator's `Agent` tool is invoked for every member, not silently bypassed.

## Running Tests

```bash
# All unit + integration tests (backend + frontend)
npm test

# Backend only
npm run test:backend
npm run test:backend -- tests/test_teams.py        # this suite only

# E2E (requires a running app + Claude Code logged in)
CEREBRO_E2E_DEBUG_PORT=9229 npm start              # in one terminal
npm run test:e2e -- teams-messages                 # in another
npm run test:e2e:headed -- teams-messages          # with visible browser
```

The live coordination tests (T1-T4) use whatever model Claude Code is configured with. Cerebro chat runs through Claude Code (see CLAUDE.md), so the suite trusts the operator's existing `claude login` and does not pin a model.

---

## Backend Tests (`backend/tests/test_teams.py`)

Each test gets a fresh temp SQLite database via the `client` fixture in `tests/conftest.py`. The fixture triggers FastAPI's lifespan, which seeds all 4 verified teams. Target code: `backend/experts/seed.py::VERIFIED_TEAMS`, `backend/experts/seed.py::seed_verified_teams`, `backend/experts/router.py:125-133` (verified-edit protection).

### A — Data contract

| # | Test | Verifies |
|---|------|----------|
| 1 | `test_seed_creates_all_four_teams` | `GET /experts?type=team` returns ≥4 rows; slugs include all of `{market-research-and-business-plan, app-build-team, product-launch-team, code-review-team}`; every seeded team has `is_verified=True`, `source="builtin"` |
| 2 | `test_market_research_team_has_correct_members` | Members in order: `data-analyst → growth-marketer → product-manager`; `strategy="sequential"`; `coordinator_prompt` non-trivial (>100 chars) |
| 3 | `test_app_build_team_has_correct_members` | Members in order: `product-designer → full-stack-engineer → backend-engineer → frontend-engineer → security-engineer`; `strategy="sequential"` |
| 4 | `test_product_launch_team_has_correct_members` | Members in order: `growth-marketer → technical-writer → customer-support-specialist → product-manager`; `strategy="parallel"` |
| 5 | `test_code_review_team_has_correct_members` | Members in order: `security-engineer → frontend-engineer → backend-engineer → full-stack-engineer`; `strategy="parallel"` |
| 10 | `test_team_member_ids_resolve_to_real_experts` | For every team, every `team_members[i].expert_id` exists in the experts table; every member is `is_verified=True` and `type="expert"` |

### B — Edit protection (verified-team gate at `backend/experts/router.py:125`)

| # | Test | Verifies |
|---|------|----------|
| 6 | `test_verified_team_rejects_content_edits` | `PATCH /experts/<team_id>` for `name`, `description`, `coordinator_prompt`, `strategy`, `team_members` → 403 |
| 7 | `test_verified_team_allows_toggle_edits` | `PATCH /experts/<team_id> {"is_pinned": true}` → 200; same for `is_enabled` |
| 8 | `test_verified_team_rejects_delete` | `DELETE /experts/<team_id>` → 403 |

### C — Idempotent reseeding

| # | Test | Verifies |
|---|------|----------|
| 9 | `test_seed_is_idempotent_preserves_toggles` | Toggle `is_pinned=true`, call `seed_verified_teams(db)` again, `is_pinned` still `true`; `strategy` still matches the seed (i.e. seeded content refreshed but user toggles preserved) |

---

## E2E Tests (Playwright) — `e2e/teams-messages.spec.ts`

Helpers added in `e2e/helpers.ts`: `VERIFIED_TEAMS`, `enableTeamsFlag`, `disableTeamsFlag`, `setSetting`, `getSetting`, `teamRow`, `openTeamProfileDrawer`, `readLastMessageToolCalls`, `assertAgentInvocations`, `expertSlugToAgentNamePrefix`. Existing helpers reused as-is: `connectToApp`, `goToExperts`, `gotoMessagesTab`, `selectExpertInMessagesTab`, `sendExpertMessage`, `waitForExpertReply`, `lastAssistantMessage`, `expertRow`, `snapshotConversationIds`, `deleteConversationsNotIn`, `GENERIC_EXIT_ERROR`, `STRUCTURED_ERROR`.

The suite runs `serial`. `beforeAll` snapshots the current `beta:teams` value, enables the flag, and snapshots existing conversation IDs. `afterAll` deletes only conversations the suite created and restores the flag to its pre-test value.

### U1-U8 — UI behavior, no LLM required

| # | Test | Verifies |
|---|------|----------|
| U1 | `beta:teams off hides every team from the rail` | With flag off, no "Groups" header; every team row absent. Catches a flag-load race between `FeatureFlagsContext` and `ExpertContext`. |
| U2 | `Groups section renders all 4 teams with verified badges` | "Groups" header visible; all 4 team rows present with at least one lucide-badge-check svg each |
| U3 | `team header shows Group label + strategy chip` | Each team's `ThreadHeader` renders the "Group" pill plus the matching strategy pill (Sequential/Parallel) |
| U4 | `team profile drawer renders members + strategy + coordinator` | Market-Research drawer shows Strategy header + Sequential chip; every member name visible; Coordinator section header rendered; "Verified — maintained by Cerebro" lock chip visible |
| U5 | `team thread composer uses team-specific placeholder` | Composer textarea on a team thread uses `experts.teamMessageComposer` placeholder ("Message the team…"), not the default expert one |
| U6 | `clicking a member row in the team drawer opens that member` | From Market-Research drawer, clicking the Data Analyst row re-targets the drawer to the Data Analyst's expert profile (h2 with member name visible; Coordinator section absent) |
| U7 | `flag-off mount selects an expert, never a hidden team` | With flag off, the `ThreadHeader` does not show the "Group" chip — the default-selection effect picked an expert |
| U8 | `flipping flag off while a team is selected re-selects an expert` | Open a team → flip flag off → reload → header shows an expert (no "Group" chip). Catches the reactive-filter safety effect in `MessagesTab` |
| CT1 | `team members are also listed as standalone experts` | Every team's member experts also appear in the `ExpertListRail` direct messages section (teams don't shadow their member experts) |

### T1-T4 — Live coordination tests (LLM-backed, slow — 6min timeout each)

These four tests take a small, deterministic prompt designed to make the coordinator delegate to its members and synthesize a short reply. Each asserts both:

1. **Content signal** — the synthesized reply contains domain-specific markers proving the synthesis read from each member.
2. **Coordination signal** — `readLastMessageToolCalls(page)` reads the rendered ToolCallCard nodes (stable `data-testid="tool-call-card"`, `data-tool-name`, `data-subagent-type` attributes) and asserts that an `Agent` tool invocation was issued for every expected member slug. Catches the silent-failure mode where the coordinator skips delegation and answers directly.

| # | Test | Team (strategy) | Prompt kernel | Content markers | Coordination markers |
|---|------|-----------------|----------------|----------------|----------------------|
| T1 | `market-research-and-business-plan — T live coordination + content synthesis` | sequential, 3 members | "1-paragraph business plan for `dayplan` (calendar→summaries) under 300 words. Cover problem, ICP, success metric, MVP roadmap." | `problem`, `customer/ICP/audience`, `metric/success/signal`, `roadmap/MVP/launch` | `Agent` invocations for `data-analyst`, `growth-marketer`, `product-manager` |
| T2 | `app-build-team — T live coordination + content synthesis` | sequential, 5 members | "1-paragraph architecture sketch + 5-line directory tree for hello-world TODO (SQLite + FastAPI + React) under 250 words." | Directory-tree shape (`/`, `.py`, `.tsx`, `main`, `App`); design vocabulary (`schema/endpoint/route/component/api`) | `Agent` invocations for `product-designer`, `full-stack-engineer`, `backend-engineer`, `frontend-engineer`, `security-engineer` |
| T3 | `product-launch-team — T live coordination + content synthesis` | parallel, 4 members | "1-paragraph launch brief for `smart-inbox`: positioning, channel, FAQ, risk." | `positioning/one-liner/tagline`, `channel/email/blog/announce`, `FAQ/question/answer`, `risk/concern/watch/mitigation` | `Agent` invocations for `growth-marketer`, `technical-writer`, `customer-support-specialist`, `product-manager` |
| T4 | `code-review-team — T live coordination + content synthesis` | parallel, 4 members | "Review 3-line Python diff with deliberate SQL-injection bug (f-string into SELECT). Flag every must-fix." | `injection/sqli/parameterized/sanitize/prepared/escape`, `must-fix/priority/blocker/critical/severe/high` | `Agent` invocations for `security-engineer`, `frontend-engineer`, `backend-engineer`, `full-stack-engineer` |
| T5 | `App Build Team handles the canonical Claude Code agent-teams CLI prompt` | sequential, 5 members (≥3 engaged) | The verbatim use-case from [code.claude.com/docs/en/agent-teams#use-case-examples](https://code.claude.com/docs/en/agent-teams#use-case-examples): a CLI tool to track TODO comments — "one teammate on UX, one on technical architecture, one playing devil's advocate." | UX angle (UX/usability/workflow), technical/architecture angle, devil's-advocate / risk angle | ≥3 distinct member subagents engaged via the `Agent` tool. Coordinator picks which 3 of the 5 members map onto the requested angles (naturally: product-designer, full-stack-engineer, security-engineer). |

#### Live test design notes

- **No model pinning.** Cerebro chat uses the Claude Code subprocess (per CLAUDE.md), which uses whatever model Claude Code is configured to use under the operator's `claude login`. The suite does not push a `selected_model` setting.
- **All toolCalls accumulate on one assistant bubble.** The renderer pushes every `tool_use` event from the run into a single `Message.toolCalls[]` array (see `src/context/ChatContext.tsx:419`). So both sequential and parallel coordination produce a single bubble with N Agent calls — we assert presence of every expected member, not turn-grouping.
- **Subagent name matching.** The installer writes each member as `<slugify(displayName)>-<6charHash>.md`. `assertAgentInvocations` matches `subagent_type` by `startsWith(prefix)` where the prefix is the slugified display name.
- **Non-goals.** This suite does NOT assert on contributor-bubble UI ordering, file-write side effects from members, or per-member sub-agent invocation order on the wire. Those would be brittle and aren't part of the user-facing contract.

---

## Test Infrastructure

- **Backend**: pytest + FastAPI TestClient (httpx transport), temp SQLite per test
  - Config: `backend/pyproject.toml` — sets `testpaths` and `pythonpath`
  - Tests: `backend/tests/test_teams.py`
  - Fixtures: `backend/tests/conftest.py` — `client` fixture provides fresh DB + lifespan-seeded teams per test
- **E2E**: Playwright via CDP attach to a running Electron instance
  - Config: `playwright.config.ts` — `testDir: e2e`, `workers: 1`, 10-minute global per-test timeout (live team tests bump to 6 minutes via `test.setTimeout`)
  - Helpers: `e2e/helpers.ts` (additions listed above)
  - Start app first: `CEREBRO_E2E_DEBUG_PORT=9229 npm start`
- **Renderer testability surface**: `src/components/chat/ToolCallCard.tsx` exposes stable `data-testid="tool-call-card"`, `data-tool-name`, `data-tool-status`, and `data-subagent-type` attributes for DOM-based coordination assertions.

## Directory Structure

```
backend/
  experts/
    seed.py             # VERIFIED_TEAMS + seed_verified_teams
    router.py:125-133   # is_verified edit-protection gate
  tests/
    conftest.py         # `client` fixture (lifespan-seeded)
    test_teams.py       # tests 1-10 above

src/
  context/
    FeatureFlagsContext.tsx     # `beta:teams` registry
    ExpertContext.tsx:188       # flag-gated team filter
  components/
    chat/
      ToolCallCard.tsx          # exposes data-testid + data-tool-name + data-subagent-type
    screens/experts/messages/
      MessagesTab.tsx           # default selection + reactive flag-flip safety
      ExpertListRail.tsx        # Groups section renderer
      ThreadHeader.tsx          # Group + strategy chips, Profile button
      ExpertProfileDrawer.tsx   # member rows, strategy, coordinator
      ExpertThreadView.tsx      # team-specific composer placeholder
  claude-code/
    installer.ts                # writes <slugified-name>-<hash>.md subagent files

e2e/
  helpers.ts                    # VERIFIED_TEAMS + team-aware helpers
  teams-messages.spec.ts        # U1-U8 + T1-T4 + CT1
```

## Known Bugs Currently Caught by This Suite

Bugs surfaced by this suite are fixed in product code rather than worked around in the tests. Each row links the failing test to the file we changed.

| Bug | Caught by | Fix |
|-----|-----------|-----|
| Clicking a member row inside a team's profile drawer navigated the user out to the Hierarchy editor instead of re-targeting the drawer to the member's profile. | U6 | `src/components/screens/experts/messages/ExpertProfileDrawer.tsx` now accepts an `onSelectMember` callback. `MessagesTab.tsx` wires it to `setProfileExpertId` and remounts the drawer (`key={profileExpert.id}`) so internal state resets cleanly. |
| `dismissModals` did not recognize the team profile drawer (`aside[role="dialog"][aria-label="Profile"]`), so when one test left it open the absolute-positioned backdrop intercepted clicks in the rail and stalled subsequent tests for ~2 minutes. | U5 (under serial run) | `e2e/helpers.ts::dismissModals` now also checks for the profile drawer locator and dismisses it via the close button or `Escape`. |
| The renderer's Vite dev server was performing a silent port-walk: when 5173 was occupied by another local Vite, the binding race could leave the renderer at `chrome-error://chromewebdata/`. The e2e suite hung waiting for the app to come up. | All e2e tests (test fixture failure) | `vite.renderer.config.ts` pins `port: 5180, strictPort: true` so a port collision fails loudly instead of resolving to an unbound port. |
| The renderer's Vite dev server watched the entire repo root, including `.claude/`, `backend/`, `e2e/`, and `docs/`. Claude Code rewrites `.claude/settings.local.json` mid-LLM-run, which triggered a renderer page reload that killed any in-flight chat. This affected real users running long Cerebro sessions, not just the e2e suite. | T1 (live coordination tests; original failure mode was "Target page, context or browser has been closed" mid-run) | `vite.renderer.config.ts` now sets `server.watch.ignored` to exclude every directory the renderer build does not depend on. |
| `expertThreadComposer` helper only matched the expert placeholder ("Send a message…"), so the helper that *sends* messages on team threads couldn't find the textarea — every team-message attempt timed out at 6 minutes. | T1 (every live team test) | `e2e/helpers.ts::expertThreadComposer` now combines both placeholder locators with Playwright's `.or()`. |
| **Team coordinator silently skipped delegation for "small-looking" prompts.** Even though the seed coordinator instructions said "delegate via Agent tool", the model treated short user prompts as too small to justify sub-agent calls and answered in a single voice — silently degrading every team to a single-expert experience. Affected ALL users sending short messages to ANY verified team. | T1, T5 (coordination signal: `assertAgentInvocations` returned `Saw subagents: [none]` despite a high-quality reply) | `src/claude-code/installer.ts::buildTeamBody` now emits a "Mandatory Delegation Policy" block at the top of every team body, which forbids the coordinator from skipping any member on any turn — instead it must scope work *per-member* small for tiny asks. Materialized into every team's `.md` file in `~/Library/Application Support/Cerebro/.claude/agents/`. |
| Live test content markers were too lexical (asserted on specific words like "problem"). Real LLM replies described problems eloquently without using the literal vocabulary, producing false-negative failures that masked whether coordination actually worked. | (test design issue surfaced by T1 first run) | Markers in `e2e/teams-messages.spec.ts::LIVE_TEAM_CASES` are now semantic — they prove the reply is on-topic for *this* app/feature, not lexical. Coordination is the load-bearing assertion (and runs first); content markers only catch egregious off-topic / empty replies. |
