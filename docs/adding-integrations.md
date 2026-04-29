# Adding a New Integration to Cerebro

This is the **single source of truth** for every step required when wiring a new external service (Slack, Gmail, Notion, GitHub, …) into Cerebro. Work through it top-to-bottom — skipping a section means the integration won't show up in chat, in routines, or in the Settings UI.

The document is organized so a contributor (human or AI) can follow it linearly and stop after each section to verify before moving on. The three already-implemented integrations — **Telegram**, **HubSpot**, **WhatsApp** — are the reference examples; copy from whichever is closest to the auth model you need.

| Auth model | Reference | Notes |
|---|---|---|
| Bot token / API key | `src/telegram/`, `src/hubspot/` | Simple: paste, verify, encrypt at rest. |
| QR pairing / device link | `src/whatsapp/` | No token field; modal owns the live handshake. |
| OAuth | _none yet_ | When the first OAuth integration lands, add a section here. |

---

## 0 · Decide before coding

Pin these answers in a paragraph before touching files. Adding an integration without these decisions causes rework.

- **`id`** — short snake_case identifier (`slack`, `gmail`, `notion`). Used everywhere: file paths, IPC channel prefixes, manifest id, the `setup_integration` argument, the routine `requiredConnections` value.
- **Auth model** — `token` / `api_key` / `qr_pairing` / `oauth`. Drives whether you need a custom modal or can rely on `GenericConnectModal`.
- **What credentials does the user paste?** — name, format, where they get them. This becomes the BotFather-style walkthrough prose.
- **What nodes/actions does it expose for routines?** — list them up front (e.g. `slack_send_message`, `slack_create_channel`). Every routine-callable action also needs a chat-callable variant unless it's purely inbound.
- **Inbound trigger?** — does the integration push events into Cerebro (Telegram message arrived, Slack mention)? If yes, you're also adding a webhook/poller on the bridge side and a routine trigger type.

---

## 1 · Bridge & credentials  *(backend / IPC plumbing)*

The bridge is the long-lived object in the Electron main process that owns the integration's lifecycle (login, polling, sending). Credentials live in the `settings` table, encrypted via `secure-token.ts` when the OS supports it.

### 1.1 Create `src/<id>/`
- `src/<id>/types.ts` — `<ID>_SETTING_KEYS` constant (one key per persisted field), the `<Id>Settings` interface.
- `src/<id>/holder.ts` (for outbound-only integrations like HubSpot) **or** `src/<id>/bridge.ts` (for bidirectional like Telegram, WhatsApp). Methods:
  - `init()` / `start()` — load creds from settings, open connections.
  - `verify(...)` — hit the provider's "whoami" endpoint with a candidate credential. Return `{ ok, ...details, error? }`.
  - `setToken(...)` / `saveCredentials(...)` — encrypt via `encryptForStorage` and `backendPutSetting`.
  - `clearToken()`.
  - `status()` — synchronous-ish snapshot of `{ hasToken, ..., tokenBackend: 'os-keychain' | 'plaintext-fallback' }`.
- `src/<id>/api.ts` — provider HTTP client (thin wrapper over fetch).

### 1.2 Add IPC channels in `src/types/ipc.ts`
- Add `<ID>_VERIFY`, `<ID>_SET_TOKEN`, `<ID>_CLEAR_TOKEN`, `<ID>_STATUS`, plus enable/disable/reload as needed (mirror `TELEGRAM_*`).
- Add a `<Id>API` interface and append `<id>: <Id>API` to the `CerebroAPI` interface.
- Add typed status/verify response interfaces.

### 1.3 Wire the main process in `src/main.ts`
- Instantiate the holder/bridge once during startup.
- Register an `ipcMain.handle()` for every channel.
- If the credential should be pushed as an env var to the Python backend (e.g. for routines that call backend-side APIs), add the mapping to `CREDENTIAL_ENV_KEYS` and call `pushCredentialToBackend()` in the setToken handler.
- Hook the bridge's `start()` into `app.whenReady` and shutdown into the `before-quit` handler.

### 1.4 Expose on the renderer in `src/preload.ts`
- Add a `<id>: { ... }` namespace under the `cerebro` API. Each method is `ipcRenderer.invoke(IPC_CHANNELS.<ID>_FOO, ...)`.
- For event channels (`<ID>_STATUS_CHANGED`, etc.), expose `on<Foo>(callback)` that returns an unsubscribe function. Mirror `onExpertsChanged` / `onConversationUpdated`.

**Verify:** `npx tsc --noEmit` clean. Boot the app, run `await window.cerebro.<id>.status()` in DevTools — should return without throwing.

---

## 2 · Settings UI  *(per-provider section + optional modal)*

The Connections / Integrations screen is where the user manages the integration outside chat. It's still important even with chat-driven setup — users edit credentials, see live status, disable.

### 2.1 Section card
`src/components/screens/integrations/<Id>Section.tsx` — expandable card with:
- Live status (driven by `window.cerebro.<id>.status()`).
- Token replace / clear buttons.
- Configuration knobs (allowlists, default pipelines, etc.).
- Open the connect modal on first connection.

Reference: `TelegramSection.tsx`, `HubSpotSection.tsx`, `WhatsAppSection.tsx`.

### 2.2 Connect modal *(only if `customModalId` is set)*
`src/components/screens/integrations/<Id>ConnectModal.tsx` — multi-step walkthrough.
- Use `STEP_COUNT = N` and a `step` state variable.
- Each step persists immediately via IPC so the user can close mid-flow without losing data.
- Match the prop shape `{ onClose: () => void; onPersisted?: () => void }` exactly — `IntegrationSetupCard` uses these.

If your integration's setup is "paste token + maybe a default" and nothing more, **skip this** and let `GenericConnectModal` handle it.

### 2.3 Hook into the screen
- `ConnectedAppsSection.tsx` for productivity / CRM tools, or
- `ChannelsSection.tsx` for messaging platforms.

Add an entry next to the existing rows. Don't delete anything in `COMING_SOON_SERVICES` — promote it from there if applicable.

---

## 3 · Manifest registration  *(makes chat-driven setup work)*

This is the piece that lets `"set up <integration>"` in chat open the inline card.

### 3.1 Create `src/integrations/manifests/<id>.ts`
Copy `telegram.ts` (custom modal) or write fresh. Required fields:
- `id`, `nameKey`, `descriptionKey`, `iconKey`, `authMode`.
- `fields` — empty for `qr_pairing`, otherwise one `IntegrationFieldSchema` per credential the user pastes. `password` for sensitive values.
- `setupStepKeys` — i18n keys for the walkthrough prose. The chat agent reads these so it can answer follow-ups without making things up.
- `docsUrl` — official provider docs link, opened from the card's "Learn more" button.
- `ipc` — typed wrappers over `window.cerebro.<id>.*` for `verify`, `status`, `saveCredentials`, optional `clear`.
- `customModalId` — set if section 2.2 was needed.

### 3.2 Register in `src/integrations/registry.ts`
- Import the manifest.
- Add `[<id>Manifest.id]: <id>Manifest` to `INTEGRATION_REGISTRY`.

### 3.3 Whitelist the id in `src/integrations/ids.ts`
- Append `'<id>'` to `KNOWN_INTEGRATION_IDS`.

This is what the loopback `/chat-actions/propose-integration` endpoint validates against. Forgetting it means the chat agent calls the script and gets `unknown_integration:<id>`.

### 3.4 Wire the modal into `IntegrationSetupCard`
If you added a custom modal in 2.2, edit `src/components/chat/IntegrationSetupCard.tsx`:
- Import the modal lazily next to the existing three.
- Add the `customModalId === '<id>'` branch.
- Add `'<id>'` to the `CustomModalId` union in `src/types/integrations.ts`.

---

## 4 · i18n strings

Add keys in **both** `src/i18n/locales/en.ts` and `src/i18n/locales/es.ts`, under the `integrations.<id>` namespace:

```ts
integrations: {
  ...,
  <id>: {
    name: 'Display name',
    description: 'One-line subtitle.',
    fields: { fieldKey: 'Label' },
    hints: { fieldKey: 'placeholder hint' },
    steps: {
      step1: '...',
      step2: '...',
    },
  },
}
```

Plus any custom modal copy (button labels, error messages). Don't ship English-only — Cerebro is bilingual by default.

---

## 5 · Engine actions  *(routine nodes)*

Each provider operation that can appear in a routine DAG is a separate action. Without this section, **routines can't use the integration**.

### 5.1 Channel adapter
`src/engine/actions/<id>-channel.ts` — implements the `Channel` interface from `src/engine/actions/channel.ts`. Lets the engine talk to the bridge/holder without coupling.

### 5.2 One file per action
- `src/engine/actions/<id>-<verb>.ts` — e.g. `slack-send-message.ts`, `slack-create-channel.ts`.
- Export an `ActionDefinition` with: `type`, `name`, `description`, `inputSchema`, `execute()`.
- For chat-callable actions (the user can ask Cerebro to do this directly): set `chatExposable: true`, plus `chatLabel`/`chatDescription`/`chatExamples` (English + Spanish), `chatGroup`, `availabilityCheck` reading the bridge's status.
- Provide a dry-run stub in `src/engine/dry-run-stubs.ts` so `propose-routine`'s end-to-end test can exercise it without hitting the real provider.

### 5.3 Register the action
- Add to `buildChatExposableDefs()` in `src/engine/engine.ts` with the channel-getter pattern (`createSendXAction({ getChannel: () => this.<id>Channel })`).
- Wire `this.<id>Channel` from the holder/bridge instance during engine construction.
- For non-chat-exposable actions (used only inside routines), register in the relevant action registry — follow whichever existing pattern fits.

**Verify:** Boot the app, open a chat, ask Cerebro to use the action through `run-chat-action`. Or run `bash .claude/scripts/list-chat-actions.sh` and confirm the action appears with `availability: "available"` after credentials are wired.

---

## 6 · Routine support  *(generated DAGs include the new nodes)*

The `propose-routine` chat skill drafts routines. It doesn't know about your new action types until you tell it.

### 6.1 Required-connections type
Append `'<id>'` to `RequiredConnection` in `src/types/routine-templates.ts` (or rely on the `string` fallback, but explicit is better).

### 6.2 Update the propose-routine skill prompt
In `src/claude-code/installer.ts`, find the `propose-routine` skill body (look for the "Common action types include" line in section 1) and add your new action types to the inline list. This is the table the chat agent reads when drafting DAGs.

### 6.3 Approval-gate guidance
If the action is externally-visible (sends messages, writes to a CRM), add it to the approval-gate guidance line in the same skill body so generated routines pause for human approval.

### 6.4 Routine templates *(optional)*
If the integration unlocks a flagship workflow, add a seeded template under `src/routine-templates/<id>-<workflow>.ts`. See `customer-support-whatsapp-hubspot.ts` for the pattern.

---

## 7 · Chat tool calling  *(`run-chat-action` skill)*

Even if section 5 marked the action `chatExposable: true`, the chat agent needs intent-mapping prose so it picks the right `type` from a natural-language request.

In `src/claude-code/installer.ts`, find the `run-chat-action` skill body and:
- Add a row to the "User says (EN / ES) → Action type" table.
- If the integration adds an entirely new category (e.g. "schedule a meeting"), expand the introductory paragraph too.

The skill body is bilingual on purpose — write **both** English and Spanish trigger phrases.

---

## 8 · Connect-integration skill prose

In `src/claude-code/installer.ts`, find the `connect-integration` skill body (the one that calls `propose-integration.sh`). Update:

- The "Currently supported `integration_id` values" sentence — append your id.
- Add a `### <Provider> (<auth method>)` subsection under "Answer follow-up questions conversationally" with the same step-by-step prose your manifest's `setupStepKeys` reference. The chat agent quotes this when the user asks "how do I get the token?".

Also update the **Cerebro main agent** body's "Connecting integrations" section ("Currently supported integrations: …") so the agent's top-level system prompt reflects the new id.

---

## 9 · Brand icon

Add an SVG component to `src/components/icons/BrandIcons.tsx`. Match the export style (`<Provider>Icon`) and let the rest of the UI pick it up via `manifest.iconKey`.

---

## 10 · Tests

- **Registry parity** — already covered by `src/integrations/__tests__/registry.test.ts`. It auto-asserts the new manifest matches `KNOWN_INTEGRATION_IDS` and has the right shape; if you forget to add the id to `ids.ts` the test fails.
- **Bridge / holder** — unit-test verify(), setToken(), status(). See `src/hubspot/__tests__/integration.test.ts`.
- **Engine action(s)** — at minimum, a dry-run-stub test for each action. See `src/engine/__tests__/dry-run-stubs.test.ts`.
- **Skill prompt regression** — if you have prompt snapshot tests, refresh them.
- **End-to-end** — see section 11.

---

## 11 · End-to-end verification *(do this every time)*

Per project memory, launch Cerebro yourself with `tail -f /dev/null | npm start &` (don't ask the user to launch). Then:

1. **Boot is clean** — no errors in stderr, the bridge starts, the chat-actions server prints its port.
2. **Skill files installed** — `<userData>/.claude/skills/connect-integration/SKILL.md` mentions the new id, `<userData>/.claude/agents/cerebro.md` lists it under "Connecting integrations".
3. **Endpoint accepts the id** —
   ```bash
   bash "<userData>/.claude/scripts/propose-integration.sh" <id>
   ```
   Expect `SUCCESS: Setup card opened for <id>`. If you get `unknown_integration`, you forgot section 3.3.
4. **Chat-driven setup** — open Cerebro, type *"set up <provider>"*. Expect the agent to call `connect-integration`, the inline `IntegrationSetupCard` to render, and clicking Connect to open your modal (or the generic one).
5. **Live verify** — paste a real credential, watch the verify call hit the provider, see the card flip to `connected`.
6. **Routine drafting** — type *"every Monday at 9am, do X with <provider>"*. Expect the agent to draft a routine that includes the new action node. Run the dry-run; every step should pass with stubs.
7. **Chat tool calling** — ask Cerebro to perform a one-shot action ("send <provider> a message saying hi"). Expect the approval card, then a successful run.
8. **Persistence** — restart the app. Card status, routine, and credentials should all survive.
9. **No-leak check** — query the message metadata in SQLite. The proposal row should contain `integration_id` + `status`, never the raw token.

If any step fails, **fix the bug before merging**. Pollution from your own testing (test proposals, half-saved routines) must be cleaned out of the user's DB before you hand the work back.

---

## 12 · Media handling  *(inbound + outbound)*

If your integration carries anything beyond text — voice notes, photos, documents, audio, video — route every file through the shared **MediaIngestService** (`src/files/media-ingest.ts`) and the unified **IntegrationStaging** dir (`src/files/staging.ts`). Reference implementations: Telegram (`src/telegram/bridge.ts`) and WhatsApp (`src/whatsapp/bridge.ts`).

### Inbound (provider → Cerebro)

1. Download the bytes to `IntegrationStaging.pathFor('<id>', '<uuid>.<ext>')` and call `staging.scheduleCleanup(absPath)` so the file self-deletes after the 30-min TTL.
2. Hand the path to `mediaIngest.ingest({ filePath, source: '<id>-inbound' })`. The service hashes, registers a `FileItem` row, dispatches to the parsing layer (office/PDF → markdown sidecar) or STT (`/voice/stt/transcribe-file`) for audio, and returns a `ResolvedAttachment`.
3. Concatenate `resolved.promptInjection` ahead of any caption text. Never inline the raw `@/path/to/file.docx` into the prompt — Claude Code's `Read` tool crashes on binary office docs.
4. Voice notes get an `inlineText` short transcript that's safe to echo back to the user as a "🎙️ Heard: …" confirmation (see Telegram's `composePromptFromResolved`).

### Outbound (Cerebro → provider)

1. Extend the integration's `<id>-channel.ts` interface with the per-media-kind methods: `sendPhotoActionMessage`, `sendDocumentActionMessage`, `sendAudioActionMessage`, `sendVideoActionMessage`, `sendVoiceActionMessage`, `sendStickerActionMessage`, `sendLocationActionMessage`. Each returns `{ messageId, error }` mirroring `sendActionMessage`.
2. Implement them on the bridge using the provider's media API (multipart for HTTP-style providers like Telegram; native message types for socket-style providers like Baileys/WhatsApp). Enforce allowlist + rate-limit + size cap before each send and return a structured `error: 'file_too_large'` rather than throwing.
3. Define one `ActionDefinition` per media kind with `chatExposable: true` and the standard input shape — `{ chat_id|phone_number, file_item_id?, file_path?, caption? }`. Reuse `src/engine/actions/utils/media-resolver.ts`'s `resolveMediaInput()` helper, which prefers `file_item_id` and falls back to `file_path`.
4. Register each action in `engine.ts`'s `createRegistry()` AND in `buildChatExposableDefs()` so the chat-action catalog (`/chat-actions/catalog`) surfaces it. Approval gating is automatic — `engine.runChatAction` hardcodes `requiresApproval: true` for every chat-action regardless of action type, so the user sees an approval card with the file size + recipient before anything leaves the machine.
5. Make sure the action's `summary` describes *what is being sent to whom* — e.g., `"Send 4.2 MB photo (foto.jpg) to Telegram chat 1234567"` — so users approve safely.
6. The Cerebro main-agent prose in `src/claude-code/installer.ts` already enumerates the supported media kinds in EN+ES; if your integration supports a kind that isn't listed there yet, add it (search for "**text or media**").

### What MediaIngestService does NOT do

- Video: passthroughs as a "[video attached]" marker. Claude vision doesn't see frames; ask the user to summarize or transcribe upstream if needed.
- Live location streaming, polls, contact cards, reactions: out of scope for the foundation. Extend the per-bridge `extractInbound` if you wire one up.

---

## 13 · Update this document

If your new integration introduces a wrinkle (first OAuth flow, first webhook trigger, first non-bilingual provider), **add a section here** describing the new pattern so the next person doesn't reinvent it. This file is the only document tracking the full surface area; if it goes stale, the surface area gets messier with every integration.

---

## Quick reference — every file that gets touched

```
src/<id>/                                  # bridge, types, api
src/types/ipc.ts                           # channels, API interface
src/main.ts                                # ipcMain.handle, lifecycle, env push
src/preload.ts                             # window.cerebro.<id> namespace
src/components/screens/integrations/
  <Id>Section.tsx                          # always
  <Id>ConnectModal.tsx                     # only with customModalId
src/components/icons/BrandIcons.tsx        # <Id>Icon
src/components/chat/IntegrationSetupCard.tsx   # custom modal branch
src/integrations/
  manifests/<id>.ts                        # NEW manifest
  registry.ts                              # register
  ids.ts                                   # KNOWN_INTEGRATION_IDS
src/types/integrations.ts                  # CustomModalId union (only if custom modal)
src/types/routine-templates.ts             # RequiredConnection
src/i18n/locales/en.ts, es.ts              # integrations.<id> + modal copy
src/engine/actions/
  <id>-channel.ts                          # Channel adapter
  <id>-<verb>.ts                           # one per action
src/engine/dry-run-stubs.ts                # stubs for new actions
src/engine/engine.ts                       # buildChatExposableDefs, channel wiring
src/claude-code/installer.ts               # cerebro main agent + run-chat-action +
                                           # connect-integration + propose-routine
                                           # skill bodies
src/integrations/__tests__/registry.test.ts # already enforces parity — runs free
src/<id>/__tests__/...                     # bridge tests
src/engine/__tests__/dry-run-stubs.test.ts # stub coverage
```

If you finish a PR and any one of these files is unchanged for a brand-new integration, double-check whether you actually skipped a step or whether the integration genuinely doesn't need it (e.g. inbound-only integrations skip `IntegrationSetupCard`).
