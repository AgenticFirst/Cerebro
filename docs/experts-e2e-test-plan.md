# Experts Messages — E2E Test Plan

This document is the QA spec for `e2e/experts-messages.spec.ts`. It defines what
quality means for the **Experts → Messages** feature, which workflows we
exercise against each verified expert, and how to run and interpret the suite.

---

## 1. Purpose

The Experts Messages tab lets a user DM any verified expert (11 today) in a
thread-based UI. Coverage today (`e2e/expert-chat.spec.ts`) only tests a
regression in the global Chat screen — nothing exercises the per-expert
Messages tab end-to-end. This suite fills that gap.

We test at the e2e layer (not unit/integration) because the feature crosses
multiple process boundaries that mocks cannot reproduce faithfully:

- Renderer React state in `MessagesTab` / `ExpertListRail` / `ExpertThreadView`
- `ChatContext` → `window.cerebro.agent.run` IPC → Electron main → Claude
  Code subprocess → SSE stream back into the renderer
- `Write`/`Edit` tool calls producing on-disk files → `parseTrailingFileRefs`
  → `AttachmentChip` → `window.cerebro.shell.*` round-trips

If any of those links breaks, only an e2e test will notice.

### Out of scope for this suite

- Hierarchy tab (`src/components/screens/experts/hierarchy/`)
- Expert profile drawer interactions (open, edit, close)
- Tool-call visibility toggle in Settings → Appearance
- Performance / latency / memory assertions
- Running in CI (the rest of the e2e suite is also out of CI — see
  `.github/workflows/test.yml`)

---

## 2. Test environment

**Prerequisites** (same as every other e2e in the repo):

1. Node ≥20, Python 3.12 for the backend venv.
2. Claude Code CLI installed and logged in.
3. At least one cloud provider API key configured in Integrations
   (Anthropic is fastest; any will work). `GET /cloud/status` should
   return `has_key: true` for at least one provider.
4. Cerebro app launched in dev mode with the CDP port open:

   ```
   CEREBRO_E2E_DEBUG_PORT=9229 npm start
   ```

5. Verified experts auto-seeded on startup — `GET /experts` returns 11 rows
   with `is_verified: true` (see `backend/experts/seed.py`).

**Non-prerequisites** (intentional):

- The suite does **not** launch Electron — it attaches over CDP to the
  already-running instance. This matches `e2e/tasks.spec.ts`,
  `e2e/expert-chat.spec.ts`, and `e2e/sidebar-nav.spec.ts`.
- The suite does **not** use a separate DB. Cleanup is prefix-based
  (`E2E-MSG-` for conversation titles; `/tmp/cerebro-e2e/` for workspaces).
- The suite does **not** stub the LLM. It makes real requests against the
  connected provider — that is the whole point of e2e coverage here.

---

## 3. Workflow definitions

Every verified expert is graded against these workflows. The matrix in §5
marks which workflows apply to which expert.

### W1 — Identity

**What it proves.** The expert is visible and correctly attributed in the
Messages list rail.

**Assertions.**
- A row for the expert exists in `ExpertListRail`.
- The row's display name matches the seed file (`backend/experts/seed.py`).
- The row contains a `BadgeCheck` (lucide `svg.lucide-badge-check`) icon.
- The row shows the expert's domain label, capitalized
  (`engineering`, `creative`, `research`, `productivity`).
- The green "enabled" indicator dot is present.

### W2 — Single-turn reply

**What it proves.** Sending a domain-appropriate greeting yields a coherent
reply without subprocess errors.

**Prompt template.** "Introduce yourself in 2 sentences and list the 2 most
common tasks you help with."

**Assertions.**
- The last assistant message's rendered text is non-empty.
- Does not match `GENERIC_EXIT_ERROR` (see `e2e/helpers.ts`).
- Does not match `STRUCTURED_ERROR` — if it does, the provider key isn't
  configured and the test is effectively useless; fail loudly so the
  operator fixes the env before trusting the suite.
- The reply text contains at least one of the expert's domain keywords
  (case-insensitive regex in `VERIFIED_EXPERT_NAMES`).

### W3 — Flagship artifact

**What it proves.** The expert can produce the kind of artifact the product
brochure promises: a file for file-producing experts, a specific content
structure for content-only experts.

**Prompt.** One carefully crafted, workspace-scoped prompt per expert (see
§5). File-producing prompts include the absolute workspace path explicitly so
the LLM doesn't have to guess.

**Assertions.**
- File-producing experts (8 of 11): `AttachmentChip` with the expected
  extension is rendered, and `window.cerebro.shell.statPath` confirms the
  file exists on disk.
- Content-only experts (3 of 11): the rendered markdown contains a
  specific structural marker (markdown table, PRD headings, ticket
  classification language).

### W4 — Follow-up with context

**What it proves.** Thread state carries between turns and the expert
responds to a follow-up that only makes sense given the prior artifact.

**Prompt.** Depends on the expert; always a short directive that refers
back to the previous turn ("Add a dark-mode variant." / "Add a rollback
section." / etc.).

**Assertions.**
- Reply is non-empty and does not match `GENERIC_EXIT_ERROR` /
  `STRUCTURED_ERROR`.
- For file-producing experts: either the original file's modified time
  has increased (in-place edit) **or** a new attachment chip appears.
- For content-only experts: the reply contains a marker appropriate to
  the follow-up (e.g., "price" for the growth-marketer follow-up,
  "Risks" heading for the PM follow-up).

### W5 — Attachment interactions

**What it proves.** The Slack-style file-flow contract works end-to-end:
Download copies the file to `~/Downloads` and shows the toast; Reveal
fires the shell IPC without throwing.

**Applies to** the 8 file-producing experts.

**Assertions.**
- Clicking the Download button on a fresh chip shows the toast
  `t('experts.downloadedToDownloads', { name })` within 4s (toasts
  auto-dismiss after 4s — see `src/context/ToastContext.tsx`).
- `app.getPath('downloads')` now contains a file whose basename matches
  the chip's `fileName` (or `<stem>-N.ext` if deduped).
- Clicking the Reveal button resolves the `shell:reveal-path` IPC
  without error. We do not assert on a Finder/Explorer window because
  that's out-of-process and racy. The IPC-level success is what we own.

---

## 4. Cross-cutting infrastructure tests

### C1 — Roster integrity

The Messages tab renders exactly 11 verified expert rows, each with a
`BadgeCheck`. Guards against seed regressions and badge-gating bugs.

### C2 — Thread isolation between experts

Send a message in expert A's thread. Switch to expert B. Expert B's pane
shows zero messages from A. Switch back to A. A's message is still there.
Guards against cross-expert message bleed from shared-state bugs in
`ChatContext`.

### C3 — In-flight stream survives navigation

Start a long-ish prompt with expert A. While it's still streaming,
navigate via sidebar to Tasks, back to Experts, back into A's thread.
The reply finalizes without `GENERIC_EXIT_ERROR` and is non-empty. This
is the "if the user leaves, the process should continue regardless"
contract from the recent chat-UX refactor.

### C4 — Multi-thread per expert

With one expert, create two threads via the Clock-icon dropdown. Send a
distinct message in each. Switching the dropdown updates
`activeConversationId` and renders the correct messages without bleed.

### C5 — Folder attachment chip renders and opens

Ask an engineering expert (backend) to create a directory via `Bash`
(`mkdir -p`) inside the workspace and reference it with `@/path/to/dir`.
The rendered chip uses the folder branch of `AttachmentChip.tsx:92-114`:
single "Open folder" button, `Folder` icon, no `Download` button.
Clicking it fires `shell.openPath` without error.

---

## 5. Experts × Workflows matrix

All 11 verified experts in `backend/experts/seed.py`.

| # | Slug | Name | Domain | W1 | W2 keywords | W3 flagship | W4 follow-up | W5 |
|---|---|---|---|---|---|---|---|---|
| 1 | `full-stack-engineer` | Principal Full-Stack Engineer | engineering | ✓ | api \| migration \| endpoint | FastAPI handler + markdown spec for `/invoices` → `py`/`md` chip | "Add OpenAPI docs inline." | ✓ |
| 2 | `product-designer` | Staff Product Designer | creative | ✓ | visual \| layout \| color | Cerebro wordmark logo `logo.svg` → `svg` chip containing `<svg` | "Add a dark-mode variant." | ✓ |
| 3 | `frontend-engineer` | Principal Frontend Engineer | engineering | ✓ | component \| accessible \| state | Accessible `<Button>` + vitest test → ≥2 chips, one `tsx`/`ts` | "Add a disabled state and update the test." | ✓ |
| 4 | `technical-writer` | Senior Technical Writer | creative | ✓ | section \| audience \| example | README for fictional CLI `crtl` → `md` chip with `Usage`/`Installation` | "Add a Troubleshooting section." | ✓ |
| 5 | `ios-engineer` | Principal iOS Engineer | engineering | ✓ | SwiftUI \| view \| state | SwiftUI list with pull-to-refresh `ContentView.swift` → `swift` chip | "Add a loading state while refreshing." | ✓ |
| 6 | `growth-marketer` | Growth Marketing Lead | creative | ✓ | positioning \| audience \| cta | 3 cold-outreach subject lines as markdown table | "Give me 3 more variants that test price-anchoring." | — |
| 7 | `security-engineer` | Security Engineer | engineering | ✓ | threat \| mitigation \| attacker | `/invites` threat model `threat-model.md` → `md` chip with `STRIDE`/`Threat` | "Add a section on rate-limiting controls." | ✓ |
| 8 | `backend-engineer` | Principal Backend Engineer | engineering | ✓ | migration \| backfill \| index | `is_archived` Postgres migration `001_archive.sql` → `sql` chip | "Add a rollback script." | ✓ |
| 9 | `data-analyst` | Senior Data Analyst | research | ✓ | groupby \| aggregate \| channel | pandas weekly channel-share `analysis.py` → `py` chip with `groupby`/`resample` | "Also emit a CSV of the weekly shares." | ✓ |
| 10 | `product-manager` | Senior Product Manager | productivity | ✓ | problem \| metric \| scope | Shared-Inbox PRD, inline — headings `Problem`, `Success Metrics` | "Add a risks-and-mitigations section." | — |
| 11 | `customer-support-specialist` | Customer Support Specialist | productivity | ✓ | classify \| escalate \| reply | Triage draft for "Getting 500s when exporting invoices" | "Draft the internal escalation note for the engineering on-call." | — |

**Test packaging.** W1+W2 collapse into one fast per-expert test (~20s each).
W3+W4+W5 collapse into one slow per-expert test (~90–150s each). Total: 11 × 2
= 22 per-expert tests.

**What each test does NOT assert.** Exact LLM prose, exact SVG markup, tool
invocation counts, specific tool names invoked, token counts, or heading
capitalization. Those are flaky signals. Assertions are restricted to
structural, deterministic markers (file extension, chip count, case-insensitive
keyword regex, DOM element presence).

---

## 6. Bug-catching philosophy

When a test fails, **investigate product code first**. This suite exists to
catch real bugs, not to write around them. Specifically:

- **Never add retries to paper over a flake.** If a test passes 9/10 times, the
  1/10 failure is a real race in the product. Fix it.
- **Never loosen an assertion to match buggy output.** If an SVG chip fails to
  render because the LLM used `\r\n` line endings and `parseTrailingFileRefs`
  only handles `\n`, fix the parser — don't weaken the assertion.
- **Never gate a test behind a conditional skip.** Either it applies to this
  expert or it doesn't; make that decision at plan time, not at runtime.

### Classes of bug this suite is designed to catch

| Symptom | Likely root cause | Fix location |
|---|---|---|
| Assistant text is the generic exit error | Subprocess race / missing expert file | `src/engine/stream-adapter.ts`, installer sync |
| Trailing file refs dropped on some turns | `\r\n` in LLM output | `src/components/chat/ChatMessage.tsx:parseTrailingFileRefs`, mirrored writer in `src/context/ChatContext.tsx` |
| Unknown extension shows as `?` | `EXT_LABELS` missing entry | `src/components/chat/AttachmentChip.tsx:8-15` |
| Stream truncates mid-reply on thread switch | `onEvent` unsub on the wrong transition | `src/context/ChatContext.tsx` |
| `/conversations/{id}` DELETE leaves subprocess running | DELETE doesn't cancel agent run | `backend/main.py:259` |
| Folder chip renders as file chip | Stat result race in `AttachmentChip` | `src/components/chat/AttachmentChip.tsx:44-63` |

These are hypotheses. Let the tests surface truth; fix what they find.

---

## 7. Runbook

### Running the suite

```bash
# Terminal 1 — start the app with CDP open
CEREBRO_E2E_DEBUG_PORT=9229 npm start

# Terminal 2 — run the suite
npm run test:e2e -- experts-messages.spec.ts
```

The `test:e2e` script already points at `e2e/` per `package.json`.

### Expected runtime

- C1 roster: ~3s
- W1+W2 per-expert: ~20s × 11 = ~3.5 min
- W3+W4+W5 per-expert: ~90–150s × 11 = ~25–30 min
- C2–C5 cross-cutting: ~5 min combined
- **Total budget: ≤45 min wall-clock**

### Interpreting failures

1. Playwright saves screenshots on failure under `e2e/screenshots/`. Check
   there first.
2. If the failure message contains `GENERIC_EXIT_ERROR`, the subprocess
   failed — check `%APPDATA%/Cerebro/.claude/agents/` (or
   `~/Library/Application Support/Cerebro/.claude/agents/` on macOS)
   for the expert's `.md` file. Missing/stale = installer sync bug.
3. If the failure is "expected a `.svg` chip, got nothing", the file
   probably wasn't written. Inspect `/tmp/cerebro-e2e/<slug>/` — if the
   file is there, `parseTrailingFileRefs` dropped the `@/path`; if not,
   the LLM ignored the workspace path hint (rewrite the prompt).
4. If a test hangs past the 180s per-test timeout, check the Electron
   console for backend errors and `ps aux | rg claude` for stuck
   subprocesses.

### Flakiness policy

If a test flakes, the flake is a bug. Fix the root cause. Never:

- Add `retries` to `playwright.config.ts`.
- Wrap assertions in `expect.poll` just to let slow state catch up
  unless the assertion itself is inherently poll-based (status change).
- Mark a test `.skip()` or `.fixme()` to get CI green.

If the root cause is "the LLM is non-deterministic," the assertion is wrong
— tighten it to a structural marker, not a content match.

### Cleanup

After the suite, verify cleanup:

```bash
# From the renderer console (Electron DevTools):
window.cerebro.invoke({ method: 'GET', path: '/conversations' })
# → conversations array must contain zero items with title starting "E2E-MSG-"

ls /tmp/cerebro-e2e/      # should be empty or non-existent
ps aux | rg claude | rg -v 'rg claude'
# → no orphaned Claude Code subprocesses
```

If cleanup is incomplete, the `afterEach` / `afterAll` hooks in the spec
failed partway through — make them idempotent, don't add a second cleanup
script.

---

## 8. Deferred / not covered

- Hierarchy tab tests — separate spec.
- Expert profile drawer — read-only for verified experts; a thin spec can
  cover open/close + system-prompt visibility.
- Tool-call visibility toggle — interacts with `ChatMessage` in both Chat
  and Messages screens; deserves its own small spec rather than bolted on.
- CI integration — e2e suite is intentionally not in CI today. A future
  plan will address stubbed providers / recorded cassettes.
