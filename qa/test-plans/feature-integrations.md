---
id: feature-integrations
name: Integrations sweep
scope: feature
feature: integrations
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-06-01T07:54:02.006Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] App boots integration bridges severity:P0 scope:integrations,smoke
  <!-- obelisk:id=01KT12STCNTK6RDR7XDED6E4AK -->
  - **Expected:** Electron starts, backend /health returns ok, Settings > Integrations renders, and no uncaught errors appear while preload exposes telegram, slack, whatsapp, hubspot, github, ghl, and supabase APIs.
  - **Repro:** Run `tail -f /dev/null | npm start &`, open Settings > Integrations, then check DevTools console and `window.cerebro` keys.
- [ ] Sidebar reaches every integration section severity:P0 scope:integrations,smoke
  <!-- obelisk:id=01KT12STCN3QR7X17R5ESW03V3 -->
  - **Expected:** Engine, Connected Apps, Channels, and Remote Access buttons switch panes without losing layout or throwing renderer errors.
  - **Repro:** Click the left nav items in `IntegrationsScreen`: Engine, Connected Apps, Channels, Remote Access.
- [ ] Connected app cards expand severity:P0 scope:integrations,smoke
  <!-- obelisk:id=01KT12STCNSZJ6V621K2Y1X3R9 -->
  - **Expected:** GitHub, HubSpot CRM, GoHighLevel, and Supabase cards expand and collapse; inline controls are visible and usable.
  - **Repro:** Open Connected Apps and click each `IntegrationCard` header and chevron.
- [ ] Channel cards load status severity:P0 scope:integrations,smoke
  <!-- obelisk:id=01KT12STCNF11TQDX5NRT66GY9 -->
  - **Expected:** Telegram, Slack, and WhatsApp cards render current status without indefinite spinners; Email remains a Coming Soon card.
  - **Repro:** Open Channels and wait one polling interval; observe status pills/descriptions.
- [ ] Backend integration endpoints respond severity:P1 scope:integrations,smoke
  <!-- obelisk:id=01KT12STCNE5VK1E3RHAF6T1S5 -->
  - **Expected:** `/integrations/ghl/config` returns `api_key_set` without the key, and `/cloud-sync/status` returns a disabled or live sync snapshot.
  - **Repro:** Use the renderer `window.cerebro.invoke` GET `/integrations/ghl/config`, then GET `/cloud-sync/status`.

## Credential Setup And Persistence

- [ ] Telegram token verifies before save severity:P0 scope:integrations
  <!-- obelisk:id=01KT12STCNB43WAD9TPTZ98007 -->
  - **Expected:** Verify is disabled for an empty Bot Token, invalid tokens show a red error, and a valid token saves only after verify returns a bot username.
  - **Repro:** Channels > Telegram > Connect; use the Bot Token password field and Verify/Next flow through `telegram:verify` and `telegram:set-token`.
- [ ] Slack requires both tokens severity:P0 scope:integrations
  <!-- obelisk:id=01KT12STCN7D26R435CK3JP245 -->
  - **Expected:** Slack Verify stays disabled until Bot Token and App Token are non-empty; invalid pairs display the API error and are not persisted.
  - **Repro:** Channels > Slack > Connect; leave one token blank, then try bad `xoxb-`/`xapp-` values on step 5.
- [ ] HubSpot saves verified portal severity:P0 scope:integrations
  <!-- obelisk:id=01KT12STCNCSYEKZD99S1Z1X5N -->
  - **Expected:** A verified Private App token shows the portal id, persists encrypted token status, then loads ticket pipelines and stages for default selection.
  - **Repro:** Connected Apps > HubSpot CRM > Connect; verify token, save, then choose a pipeline and stage.
- [ ] GitHub persists watched repositories severity:P1 scope:integrations,routines
  <!-- obelisk:id=01KT12STCNRTT8MJMV7WTJ0699 -->
  - **Expected:** Verified PAT shows connected login, repository list loads, manual `owner/repo` entries dedupe/sort, invalid repo strings are discarded by status.
  - **Repro:** Connected Apps > GitHub; verify a PAT, add `octo/repo`, duplicate it, then add malformed text and reload.
- [ ] GoHighLevel mirrors backend config severity:P1 scope:integrations
  <!-- obelisk:id=01KT12STCNCWB9B47VEW9D8SHR -->
  - **Expected:** Saving API key plus Location ID updates UI config, backend `/integrations/ghl/config`, and never returns the raw key.
  - **Repro:** Connected Apps > GoHighLevel; enter API Key and Location ID, save, then GET `/integrations/ghl/config`.
- [ ] Clearing tokens removes connected state severity:P0 scope:integrations
  <!-- obelisk:id=01KT12STCN8HKWKYRWFJ21BDW0 -->
  - **Expected:** Clear or Disconnect removes stored credentials, resets default selections or watched repos where applicable, and status no longer reports connected.
  - **Repro:** Use clear buttons for Telegram, Slack, HubSpot, GitHub, and GoHighLevel; reload Integrations after each.
- [ ] Secret storage banner is accurate severity:P1 scope:integrations
  <!-- obelisk:id=01KT12STCND8P2CSXHRP28FXP1 -->
  - **Expected:** Each token-backed integration shows encrypted-at-rest when safeStorage is available and plaintext fallback only when OS encryption is unavailable.
  - **Repro:** Check Telegram, Slack, HubSpot, GitHub, Supabase, and GoHighLevel sections after status loads.

## Channels And Cloud Sync

- [ ] Telegram allowlist filters IDs severity:P0 scope:integrations,activity-approvals
  <!-- obelisk:id=01KT12STCNPQBNXEBM5GTBKYHA -->
  - **Expected:** Allowlist input persists only numeric IDs, operator chat id saves separately, and enabling reloads settings without exposing token plaintext.
  - **Repro:** Channels > Telegram; enter `123 abc 456`, operator `789`, save, enable, then reload the card.
- [ ] Slack allowlists normalize mentions severity:P0 scope:integrations,routines
  <!-- obelisk:id=01KT12STCNYVCGSJZZHTA9F9JS -->
  - **Expected:** Channel/user allowlists accept `C`, `G`, `D`, `U`, `W`, and `*`; pasted `<#C...|name>` and `<@U...>` forms are normalized before save.
  - **Repro:** Channels > Slack; enter mention-shaped channel and user values, save, then inspect status/settings.
- [ ] WhatsApp pairing cancel stops socket severity:P0 scope:integrations
  <!-- obelisk:id=01KT12STCNXG0HMRN9S8KDFE4K -->
  - **Expected:** Starting pairing enters pairing state, QR/waiting state renders, and closing or Cancel Pairing returns status to off without leaving a pairing socket.
  - **Repro:** Channels > WhatsApp > Pair Device; cancel before scanning and watch `whatsapp:status-changed` updates.
- [ ] WhatsApp allow-all is explicit severity:P1 scope:integrations
  <!-- obelisk:id=01KT12STCNNVPWT9SKHK4PEZ1K -->
  - **Expected:** The setup tour's allow-any option persists `['*']`; normal allowlist input normalizes phone numbers and rejects too-short or non-numeric values.
  - **Repro:** Use WhatsApp Connect step 4 with allow-any, then repeat with `+1 (415) 555-2671 bad 123`.
- [ ] Bridge start failures surface errors severity:P0 scope:integrations
  <!-- obelisk:id=01KT12STCNF4DEDZXVXR829Y8W -->
  - **Expected:** Telegram/Slack enable failures roll back enabled settings, leave the card configured-not-running, and display lastError instead of hanging.
  - **Repro:** Mock `telegram.enable` or `slack.enable` to return `{ok:false,error:'boom'}` and toggle Enable.
- [ ] Supabase rejects invalid Postgres URL severity:P0 scope:integrations,memory-knowledge
  <!-- obelisk:id=01KT12STCNC8FCR8CGCQ0T0F1V -->
  - **Expected:** Connect is disabled without Database URL; invalid or unreachable URLs show the backend error and do not write `cerebro-backend-mode.json`.
  - **Repro:** Connected Apps > Supabase; leave Database URL empty, then enter `postgresql://bad` and click Connect.
- [ ] Supabase seed excludes local secrets severity:P0 scope:integrations,memory-knowledge
  <!-- obelisk:id=01KT12STCNT8TX6TQCS655ARGF -->
  - **Expected:** First-connect seed enqueues synced tables but excludes local-only settings prefixes `telegram_`, `hubspot_`, `ghl_`, `github_`, `sandbox:`, and `sync:`.
  - **Repro:** Seed local settings with those prefixes, call POST `/cloud-sync/connect` with `seed:true`, inspect `sync_outbox` payload keys.
- [ ] Cloud sync survives offline remote severity:P1 scope:integrations,memory-knowledge
  <!-- obelisk:id=01KT12STCNWCF8A6WBCNFF3VYM -->
  - **Expected:** Worker status becomes offline with last_error, pending outbox rows remain pending, and Sync Now retries without dropping local data.
  - **Repro:** Connect Supabase, block remote DB/network, create a local record, then click Sync Now and check `/cloud-sync/status`.
