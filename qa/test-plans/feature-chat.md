---
id: feature-chat
name: Chat sweep
scope: feature
feature: chat
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-05-31T01:28:59.503Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] App boots to chat welcome severity:P0 scope:smoke,chat
  <!-- obelisk:id=01KSXTC2BF32KPYKN053DMW1EW -->
  - **Expected:** Electron starts, backend reports healthy, sidebar renders, and the Chat welcome/input is reachable without uncaught renderer errors.
  - **Repro:** Run `tail -f /dev/null | npm start &`, open the first window, wait for `window.cerebro.getStatus()` to return `healthy`, and assert the chat placeholder is visible.
- [ ] Backend registers chat dependencies severity:P0 scope:backend,routing
  <!-- obelisk:id=01KSXTC2BFK14TFQRXWP29J62D -->
  - **Expected:** `GET /health`, `GET /conversations`, `GET /agent-runs`, `GET /sandbox/config`, `GET /cloud-sync/status`, and `GET /integrations/ghl/config` all return structured responses.
  - **Repro:** Start backend with a temp db, call each route through `window.cerebro.invoke` or HTTP, and verify 2xx responses except intentionally missing resources.
- [ ] Chat navigation loads empty state severity:P1 scope:navigation,chat
  <!-- obelisk:id=01KSXTC2BFJ2SBJ75DNWERSWA6 -->
  - **Expected:** Clicking sidebar Chat after visiting another screen clears the active conversation and shows the welcome state, not a stale thread.
  - **Repro:** Navigate Chat -> Routines -> Chat using sidebar buttons; assert no previous message list is shown until a conversation is selected.
- [ ] Test workflow exercises chat suite severity:P1 scope:ci,chat
  <!-- obelisk:id=01KSXTC2BFW7MJCWR1H0V5S0K8 -->
  - **Expected:** The GitHub workflow installs dependencies with Node 20 and Python 3.12, then runs frontend and backend tests that include chat/conversation coverage.
  - **Repro:** Inspect `.github/workflows/test.yml`; in CI or `act`, verify `npm run test:frontend` and backend `python -m pytest -v` both execute.
- [ ] Lint config parses TypeScript chat severity:P1 scope:lint,chat
  <!-- obelisk:id=01KSXTC2BFE0V65S7FAZCBKZCN -->
  - **Expected:** ESLint loads `.eslintrc.json` and can lint `src/context/ChatContext.tsx` and `src/components/chat/ChatInput.tsx` without config parser failures.
  - **Repro:** Run `npx eslint src/context/ChatContext.tsx src/components/chat/ChatInput.tsx`; fail only on real lint findings, not config resolution.
- [ ] Prettier respects ignore boundaries severity:P2 scope:formatting,tooling
  <!-- obelisk:id=01KSXTC2BFEDMA1BJTV73EMYPT -->
  - **Expected:** Prettier uses `.prettierrc.json`, excludes ignored build/runtime paths, and does not try to format generated `.vite`, `out`, `dist`, or `backend/venv` files.
  - **Repro:** Run `npx prettier --check src/components/chat/ChatInput.tsx package.json`; verify ignored paths from `.prettierignore` stay untouched.
- [ ] Package assets resolve on launch severity:P2 scope:packaging,smoke
  <!-- obelisk:id=01KSXTC2BF2BK0VE9VQ14DDA85 -->
  - **Expected:** The app icon files exist, are readable, and startup/package config references do not produce missing asset warnings.
  - **Repro:** Verify `assets/icon.png`, `assets/icon-rounded.png`, and `assets/icon.icns` exist; launch app and inspect main-process logs for missing icon errors.
- [ ] Contributor docs match chat setup severity:P2 scope:docs,chat
  <!-- obelisk:id=01KSXTC2BFF65EVD4X31MF7KMS -->
  - **Expected:** README, AGENTS, CLAUDE, and CONTRIBUTING describe the same local startup/test commands and do not instruct using unsupported chat inference providers.
  - **Repro:** Static-review `README.md`, `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md`; compare commands against `package.json` scripts and chat runtime code.

## Chat Send And Streaming

- [ ] Enter sends first chat turn severity:P0 scope:chat,ipc
  <!-- obelisk:id=01KSXTC2BFJ3VJTFWZJJFPZK7C -->
  - **Expected:** Typing text in the chat textarea and pressing Enter creates a conversation, appends a user message, shows a thinking assistant message, and calls `agent:run` with the new conversation id.
  - **Repro:** Mock `window.cerebro.agent.run`, type `Summarize my week` in the chat input, press Enter, and assert one user bubble plus one assistant thinking bubble.
- [ ] Streaming deltas update assistant bubble severity:P0 scope:streaming,persistence
  <!-- obelisk:id=01KSXTC2BFNFSSYFKN2E2ZSSW5 -->
  - **Expected:** `text_delta` events clear the thinking indicator, append text in order, and final `done` persists an assistant message with `agent_run_id`.
  - **Repro:** Stub `agent.onEvent` to emit two `text_delta` events and a `done`; inspect the assistant bubble and POST body for `/conversations/{id}/messages`.
- [ ] Empty prompt cannot send severity:P1 scope:validation,chat
  <!-- obelisk:id=01KSXTC2BF98RQRNYN2D4M1QJJ -->
  - **Expected:** Whitespace-only input keeps the send button disabled and does not create a conversation or call `agent:run`.
  - **Repro:** Type spaces/newlines in the chat textarea; press Enter and click the send icon; assert no new row in the conversation list.
- [ ] Attachment-only prompt sends file refs severity:P1 scope:attachments,chat
  <!-- obelisk:id=01KSXTC2BFHA7BRPBECWBXV2D4 -->
  - **Expected:** Selecting or dropping a file creates an attachment chip and sending produces content containing `@<absolute-path>` without requiring prose.
  - **Repro:** Use file picker or drag/drop a temp `.md` file, click send, and assert the created user message includes the `@/path` reference.
- [ ] Clipboard image rejects invalid bytes severity:P1 scope:attachments,ipc
  <!-- obelisk:id=01KSXTC2BFG53D4FQJ1QAP4PY9 -->
  - **Expected:** Unsupported MIME, oversized image, or mismatched bytes show a paste error toast and do not attach a bogus file.
  - **Repro:** Paste mocked clipboard items through `chat:save-clipboard-image` with `image/png` MIME and invalid bytes, then with a >20 MB buffer.
- [ ] Stop persists partial response severity:P0 scope:streaming,cancel
  <!-- obelisk:id=01KSXTC2BF8MV81MVCY0BSZBSS -->
  - **Expected:** Clicking Stop cancels the active run, marks running tool calls stopped, appends the localized stopped marker, and persists the assistant message.
  - **Repro:** Start a mocked streaming run, emit partial text, click the square stop button, and verify `agent:cancel` plus POST `/conversations/{id}/messages`.
- [ ] Busy conversation shows friendly retry severity:P1 scope:concurrency,chat
  <!-- obelisk:id=01KSXTC2BFMH4BYCXFBDKRP1VA -->
  - **Expected:** A second send while the same conversation is in flight is blocked or resolves to localized friendly retry copy, never a raw session-in-use string.
  - **Repro:** Make `agent.run` reject with `ConversationBusyError`; submit another prompt and assert the assistant bubble contains `chat.busyRetry` copy.
- [ ] Claude unavailable opens integration prompt severity:P0 scope:validation,providers
  <!-- obelisk:id=01KSXTC2BF1SXXNDCQF2TGFH66 -->
  - **Expected:** When Claude Code status is unavailable, sending does not create a message and shows a modal with an Integrations action.
  - **Repro:** Set ProviderContext `claudeCodeInfo.status` to `missing`, submit `hello`, and assert the alert title plus Integrations navigation action.

## Chat Persistence And Failures

- [ ] Conversation reload restores messages severity:P0 scope:persistence,backend
  <!-- obelisk:id=01KSXTC2BFY2RY94FRVDPR25VQ -->
  - **Expected:** Messages saved through `/conversations` reload newest-first with dates, roles, expert id, source, and metadata mapped back into the chat UI.
  - **Repro:** Create a conversation and two messages via API, reload renderer, call `GET /conversations`, and assert the sidebar and message list match persisted content.
- [ ] Write chain prevents FK races severity:P0 scope:persistence,agent-runs
  <!-- obelisk:id=01KSXTC2BF1FQ3A2REG8X68AZG -->
  - **Expected:** The conversation insert, user message insert, agent run insert, and assistant message insert commit in order without foreign-key or 404 failures.
  - **Repro:** Throttle backend POST `/conversations` by 500 ms, send first prompt, and inspect logs/DB for successful `conversations`, `messages`, and `agent_runs` rows.
- [ ] Regenerate truncates later messages severity:P1 scope:regenerate,persistence
  <!-- obelisk:id=01KSXTC2BFF9TRF813QGTEARQT -->
  - **Expected:** Editing a prior user message patches its content, deletes all following messages, and starts a fresh assistant response from that pivot.
  - **Repro:** Create a three-turn chat, edit the first user bubble, press Cmd/Ctrl+Enter, then verify `PATCH /messages/{id}` and `DELETE /messages/after/{id}`.
- [ ] Metadata cards survive reload severity:P1 scope:metadata,chat
  <!-- obelisk:id=01KSXTC2BFGR5G9T9YPG28GR76 -->
  - **Expected:** Routine, expert, team, integration proposal, team-run, engine-run, preview-run, and escalation metadata rehydrate into their chat cards after reload.
  - **Repro:** Seed assistant messages with each metadata shape through `/conversations/{id}/messages`, reload, and assert the corresponding card components render.
- [ ] Backend outage leaves UI usable severity:P0 scope:backend,failure
  <!-- obelisk:id=01KSXTC2BFEZZC52YYQAPTJPZW -->
  - **Expected:** If startup conversation loading or a backend write fails, the app logs the error, stops loading, and the chat shell remains interactive.
  - **Repro:** Launch renderer with backend status stuck unhealthy or make `GET /conversations` return 500; assert no crash and New Chat/input are still reachable.
- [ ] Auth error renders login card severity:P0 scope:auth,chat
  <!-- obelisk:id=01KSXTC2BFGP6AA9D6K4EY0VSY -->
  - **Expected:** An agent `error` event with `errorClass: auth` suppresses raw error text, renders the Claude Code login card, and forces an auth probe refresh.
  - **Repro:** Emit `{type:'error', errorClass:'auth'}` from `agent.onEvent`; assert `ClaudeCodeLoginCard` appears and `claudeCode.probeAuth({force:true})` is called.
- [ ] Agent memory rejects traversal severity:P1 scope:memory,security
  <!-- obelisk:id=01KSXTC2BFDM389SDQ5GK1WEQ1 -->
  - **Expected:** Agent memory file routes reject absolute paths, `..`, hidden slugs, and non-markdown writes so chat subagent memory cannot escape its root.
  - **Repro:** Call `/agent-memory/../files`, `/agent-memory/.secret/files`, and `PUT /agent-memory/cerebro/files/x.txt`; assert 400 responses.
- [ ] Sandbox defaults after first chat severity:P1 scope:sandbox,persistence
  <!-- obelisk:id=01KSXTC2BFNAFWXM03N8V1BY69 -->
  - **Expected:** Before any conversation, sandbox config defaults enabled for fresh installs; after creating a chat, subsequent config reads reflect persisted settings without deleting data.
  - **Repro:** Use a fresh temp db, call `/sandbox/config`, create a conversation, patch sandbox values, restart backend, and verify values persist.
- [ ] Cloud sync never blocks chat severity:P1 scope:sync,chat
  <!-- obelisk:id=01KSXTC2BF08ZPQKP1P9D6N9E5 -->
  - **Expected:** Cloud sync status/test/connect failures return clear status/error objects and do not prevent creating conversations or sending chat messages.
  - **Repro:** Configure `/cloud-sync/test` with an invalid db URL, then create a chat conversation and message; assert chat API still succeeds.
- [ ] GHL config hides API key severity:P1 scope:integrations,security
  <!-- obelisk:id=01KSXTC2BFD3YGXDNCXR3H0JRN -->
  - **Expected:** `GET /integrations/ghl/config` returns only `api_key_set` and `location_id`; chat integration setup cannot expose raw API keys in model-visible data.
  - **Repro:** PUT a fake GHL API key, GET the config, and assert the response omits the key value while `api_key_set` is true.
