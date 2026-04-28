# Cerebro — agent context

Cerebro is an Electron + React + TypeScript desktop app with a Python/FastAPI backend that drives AI workflows from natural-language chat. Inference runs through the Claude Code CLI as a subprocess; routines, experts, and integrations are persisted in SQLite under the user's `app.getPath('userData')`.

---

## Read before touching integrations

**`docs/adding-integrations.md`** is the single source of truth for wiring a new connected service (Slack, Gmail, Notion, GitHub, …). Adding an integration touches ~15 files across the bridge, IPC, UI, engine actions, routine prompt, and chat skills. Skipping any of them **silently breaks part of the surface** — chat-driven setup works, but the integration never appears in routines, or the chat agent can't tool-call it, etc. Work the playbook top-to-bottom.

The currently-implemented integrations — **Telegram**, **HubSpot**, **WhatsApp** — are the reference examples. Copy from whichever auth model is closest.

---

## Project layout

| Path | Purpose |
|---|---|
| `src/main.ts` | Electron main process. Spawns the Python backend, owns IPC handlers, lifecycle. |
| `src/preload.ts` | Exposes the typed `window.cerebro.*` API to the renderer. |
| `src/types/ipc.ts` | IPC channel constants + API interfaces — the contract between main and renderer. |
| `src/components/` | React UI. Chat lives in `chat/`, settings/integrations in `screens/`. |
| `src/agents/` | Agent runtime that wraps Claude Code subprocesses. |
| `src/claude-code/installer.ts` | Writes the Cerebro main agent prompt and skill markdown into `<userData>/.claude/`. **Where most chat-skill prompt logic lives.** |
| `src/engine/` | Routine DAG executor + actions + dry-run stubs. |
| `src/integrations/` | Central registry for connected services (manifests + IPC wrappers). |
| `src/<service>/` | Per-service bridges/holders (`telegram/`, `hubspot/`, `whatsapp/`). |
| `src/chat-actions/` | Loopback HTTP server the chat subprocess calls back into. |
| `backend/` | FastAPI service. SQLite, conversations, routines, memory, experts. |
| `docs/tech-designs/` | Architecture references (`routines.md`, `cerebro-core-intelligence.md`, …). |
| `docs/adding-integrations.md` | **Integration playbook — read this first.** |
| `docs/roadmap.md` | Implementation status. |

---

## Conventions a fresh agent would otherwise miss

- **Inference is Claude Code only.** Every LLM call goes through `claude -p` as a subprocess (see `src/claude-code/stream-adapter.ts`). Don't propose routes via the Anthropic SDK, OpenAI, Google, or local-model providers for chat — those exist as routine-step backends only.
- **Bilingual (EN + ES) is non-negotiable.** Every user-facing string lives in `src/i18n/locales/{en,es}.ts` under symmetrical keys. The chat skills also include Spanish trigger phrases. Never ship English-only.
- **Credentials never enter LLM context.** Bridges encrypt at rest via `src/secure-token.ts` (OS keychain with plaintext fallback). The chat agent triggers integration setup via `propose-integration.sh`, but the inline card collects raw tokens through IPC — they never reach the model.
- **Approvals gate every external-facing action.** `run-chat-action` always pauses for human approval. Routine steps that touch Telegram/HubSpot/WhatsApp/email should set `requiresApproval: true`.
- **Don't delete user data without asking.** Per project memory: "never delete without asking" extends to settings, conversations, routines, and any DB rows you didn't create yourself.
- **For end-to-end tests, launch Cerebro yourself** with `tail -f /dev/null | npm start &`. Don't ask the user to launch the app — you launch, you verify, you clean up. Kill spawned Electron + Python processes when done.
- **Memory is auto-managed.** Each agent has a `memory/` directory the runtime injects into context. Don't write planning files into the repo — work from conversation context.

---

## Running locally

```bash
npm start              # Electron + Vite + auto-spawned Python backend
npx tsc --noEmit       # Type check (filter node_modules — pre-existing harmless errors)
npx vitest run         # Test suite (mix of node + jsdom)
npx vite build         # Production renderer bundle
```

Type-check command that filters known noise:
```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | grep -E "src/"
```

---

## Critical references

- **Integration playbook:** `docs/adding-integrations.md`
- **Routine DAG architecture:** `docs/tech-designs/routines.md`
- **Cerebro intelligence model:** `docs/tech-designs/cerebro-core-intelligence.md`
- **Claude Code integration:** `docs/tech-designs/claude-code-integration.md`
- **Test plan:** `docs/test-plans/cerebro-master-test-plan.md`
- **Roadmap:** `docs/roadmap.md`

---

## When in doubt

Default to reading the existing implementation before adding new abstractions. Telegram, HubSpot, and WhatsApp are intentionally close in shape so a fourth integration can copy patterns rather than invent them. If you're tempted to add a generic helper for a third occurrence — pause and check whether one already exists in `src/integrations/`, `src/engine/actions/`, or `src/shared/`.
