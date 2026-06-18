## Navigation map

- Launch: `CEREBRO_E2E_DEBUG_PORT=9229 tail -f /dev/null | CEREBRO_E2E_DEBUG_PORT=9229 npm start`; renderer on http://localhost:518x; connect Playwright via `chromium.connectOverCDP('http://127.0.0.1:9229')`, pick the page whose url starts with http://localhost. Build+window ready ~70s after start.
- Primary nav buttons live in the left rail; "Experts/Tasks/Routines/Files" are direct, "Calendar/Knowledge Base/News" are children of the "Apps" expander, and "Approvals"/"Settings" sit at the bottom (outside `<nav>`).
- "Settings > X": click `Settings`, then inner-panel item: Memory, Integrations, Skills, Activity, Sandbox, Voice, Backup, Appearance, Beta Features, About.
- "Settings > Integrations" has its own sub-tabs: Engine, Connected Apps, Channels, Remote Access.
- Experts default tab = Messages (ExpertThreadView opens on selecting an expert); second tab = Hierarchy (org chart + "New Expert" button top-right).

## Selectors

- Sidebar nav items are `<button>`s; match by exact innerText, constrain to x<200 to avoid conversation rows. Settings/Approvals/Apps children are buttons too but some sit at x~31 (indented).
- Sidebar collapse toggle: `button:has(svg.lucide-panel-left-close)`; expand: `button:has(svg.lucide-panel-left-open)`. Collapsed rail = 56px, expanded = 259px.
- Routine card opens editor by clicking its title text (`text="<name>"`). Create Expert: Hierarchy → "New Expert".

## App shell

- App runs against the real Cerebro DB (~/Library/Application Support/Cerebro/cerebro.db) — NOT a fresh userData; it has ~25 experts/teams, several routines, 402 activity runs, connected Telegram. Engine = Claude Code (detected), Codex also detected.
- Chat conversation history occupies the left rail on every screen; feature screens add their own secondary sidebar (Files, KB, Settings) → up to 4 stacked panels.
- Tasks board columns: Backlog/In Progress/To Review/Completed; empty columns show "All Clear". Task cards show doc-count + comment-count icons (not ambiguous at full res).

## Audited surfaces

- "Experts > Hierarchy": org chart; FILED — nested <button> in <button> (DepartmentCard) fires a React DOM/hydration console error on render.
- "Experts > New Expert": FILED — optional emoji AvatarPicker dominates the dialog.
- "Routines": FILED — Run Now stays active despite "N fixes needed"; enabled toggle vs unrunnable is contradictory.
- "Settings > Memory": FILED — agent dirs shown as raw hashed slugs, no search.
- Clean, no findings: Approvals (empty state good), Knowledge Base (empty state good), Calendar (week view), New Task dialog (well-structured, only Title required), Connected Apps & Channels (clear cards), Activity list (3 filter rows but readable), chat thread (document-style, markdown renders).

## Known non-issues

- C35 is stale: Tavily/web-search-key flow no longer exists — web search is built into Claude Code; Connected Apps says so explicitly. Don't file "add Tavily".
- Slack is now correctly a Channel (Settings > Integrations > Channels), not a Connected App — the prior misclassification is resolved.
- Tasks empty columns all reading "All Clear" and the deep Settings panel nesting are intentional design, not findings.
