# Cerebro — Claude Code context

Cerebro is an Electron + React + TypeScript desktop app with a Python/FastAPI backend that drives AI workflows from natural-language chat. **Inference runs through the Claude Code CLI** as a subprocess — every chat reply, expert delegation, and routine step that needs reasoning shells out to `claude -p`.

The full project context, layout, and conventions are in [`AGENTS.md`](./AGENTS.md). Read that first when arriving cold.

---

## Read before touching integrations

**[`docs/adding-integrations.md`](./docs/adding-integrations.md)** is the single source of truth for wiring a new connected service (Slack, Gmail, Notion, …). Wiring an integration touches ~15 files across the bridge, IPC, UI, engine actions, routine prompt, and chat skills. Skipping any of them silently breaks part of the surface. Work the playbook top-to-bottom.

Reference implementations: **Telegram** (`src/telegram/`), **HubSpot** (`src/hubspot/`), **WhatsApp** (`src/whatsapp/`). Copy from whichever auth model is closest.

---

## Critical conventions

- **Inference is Claude Code only.** Don't propose routes via the Anthropic SDK / OpenAI / local models for chat — those exist as routine-step backends only.
- **Bilingual (EN + ES) is non-negotiable.** Every user-facing string lives in `src/i18n/locales/{en,es}.ts`. Chat skills also need Spanish trigger phrases.
- **Credentials never enter LLM context.** Bridges encrypt at rest via `src/secure-token.ts`. The chat agent triggers integration setup, but the inline card collects raw tokens through IPC — they never reach the model.
- **Approvals gate external-facing actions.** `run-chat-action` always pauses for human approval. Routine steps that touch external services should set `requiresApproval: true`.
- **Don't delete user data without asking.** Settings, conversations, routines, DB rows you didn't create yourself.
- **For end-to-end tests, launch Cerebro yourself** with `tail -f /dev/null | npm start &`. You launch, you verify, you clean up. Kill spawned Electron + Python processes when done.
- **Memory is auto-managed.** Don't write planning files into the repo — work from conversation context.

---

## Running locally

```bash
npm start              # Electron + Vite + Python backend
npx tsc --noEmit 2>&1 | grep -v node_modules | grep -E "src/"
npx vitest run         # Tests
```

---

## Where to look

- **`src/claude-code/installer.ts`** — writes the Cerebro main agent prompt and skill markdown into `<userData>/.claude/`. Most chat-skill prompt logic lives here.
- **`src/integrations/registry.ts`** — manifest registry for connected services. Header comment links to the playbook.
- **`src/types/ipc.ts`** — IPC contract between main and renderer.
- **`src/chat-actions/server.ts`** — loopback HTTP bridge the chat subprocess calls back into.
- **`docs/tech-designs/`** — architecture references for routines, intelligence, Claude Code integration.

---

## When in doubt

Read the existing implementation before adding new abstractions. Telegram, HubSpot, and WhatsApp are intentionally close in shape so a fourth integration can copy patterns rather than invent them.
