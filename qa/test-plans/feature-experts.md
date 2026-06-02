---
id: feature-experts
name: Experts sweep
scope: feature
feature: experts
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-06-01T08:00:16.801Z
generatedBy: codex
version: 1
---

## Smoke

- [ ] Experts screen boots cleanly severity:P0 scope:experts,smoke
  <!-- obelisk:id=01KT1358D002GMW6PYMVS775JQ -->
  - **Expected:** Launching with `npm start` reaches the Experts screen without renderer uncaught errors, backend crash dialogs, or a stuck blank pane.
  - **Repro:** Run `tail -f /dev/null | npm start &`, open the Experts navigation item, and watch Electron devtools plus backend logs during first `/experts?limit=200` load.
- [ ] Messages tab loads roster severity:P0 scope:experts,smoke
  <!-- obelisk:id=01KT1358D0N8MAW6W3QTGWV1JK -->
  - **Expected:** The Messages tab shows enabled experts grouped into teams, starred, and direct-message sections; disabled experts are absent from the rail.
  - **Repro:** Seed one enabled, one disabled, and one pinned expert through `POST /experts`; open Experts > Messages and inspect the left rail search list.
- [ ] Hierarchy tab loads canvas severity:P0 scope:experts,smoke
  <!-- obelisk:id=01KT1358D02NF1R49JBJ8H2M99 -->
  - **Expected:** The Hierarchy tab renders the Cerebro lead node, All/Active/Disabled/Pinned filters, search field, zoom controls, and New Expert button after `/experts?limit=200` returns.
  - **Repro:** Open Experts > Hierarchy with at least one seeded expert and verify the canvas, filter counts, and toolbar are reachable.
- [ ] Backend outage does not hang severity:P0 scope:experts,smoke
  <!-- obelisk:id=01KT1358D0BZ1X8V0P1C6RPQ9H -->
  - **Expected:** If `/experts?limit=200` fails, the loading spinner clears, the app remains navigable, and no stale expert mutations are shown as successful.
  - **Repro:** Start the app, kill the FastAPI child process, navigate to Experts, then restore the backend and click refresh/navigation back to Experts.
- [ ] Experts feed routines dropdown severity:P1 scope:experts,routines
  <!-- obelisk:id=01KT1358D0EJPGJTVRXCTBEAF2 -->
  - **Expected:** Navigating straight to Routines still populates Run Expert selectors from the eagerly loaded ExpertProvider roster, with no `(unavailable)` entries for existing experts.
  - **Repro:** Cold launch, do not open Experts first, open Routines, add or edit a `run_expert` step, and inspect the expert picker.
- [ ] README start path matches app severity:P1 scope:experts,smoke
  <!-- obelisk:id=01KT1358D0V832AH4BJKSZV839 -->
  - **Expected:** The README Getting Started flow launches the current app version and the first-run guidance can reach Experts to create a specialist.
  - **Repro:** From a clean clone, follow README install commands, run `npm start`, and verify Experts is available from the main navigation.

## Roster And Messaging

- [ ] Create expert via dialog severity:P0 scope:experts
  <!-- obelisk:id=01KT1358D0ZKSK247E2YYPQYSN -->
  - **Expected:** Submitting Name, Description, Domain, and Avatar creates one `source=user` expert through `POST /experts`, appends it to Hierarchy, and triggers installer sync.
  - **Repro:** Experts > Hierarchy > New Expert; fill Name `QA Analyst`, Description `Finds release risks`, Domain `engineering`, choose an avatar, submit.
- [ ] Blank expert fields stay blocked severity:P0 scope:experts
  <!-- obelisk:id=01KT1358D0XE11D3MH20YSRMK1 -->
  - **Expected:** The Create Expert submit button stays disabled until trimmed Name and Description are non-empty; whitespace-only input cannot call `POST /experts`.
  - **Repro:** Open New Expert, enter spaces in Name and Description, and monitor `window.cerebro.invoke` calls while pressing Enter.
- [ ] Duplicate slug returns conflict severity:P1 scope:experts
  <!-- obelisk:id=01KT1358D06GA5J3N4RCHB6B8W -->
  - **Expected:** `POST /experts` or `PATCH /experts/{id}` with an existing non-null slug returns HTTP 409 and does not create or rename a second row.
  - **Repro:** Call `POST /experts` twice with body `slug: "qa-analyst"`; then verify `GET /experts?search=qa-analyst` returns one matching slug.
- [ ] Pinned expert selects first severity:P1 scope:experts,chat-voice
  <!-- obelisk:id=01KT1358D0BWQ337727GXQ402W -->
  - **Expected:** Messages default selection chooses pinned team first, then pinned expert, then first enabled expert, matching `MessagesTab` priority.
  - **Repro:** Seed enabled experts and teams with different `is_pinned` values, reload Experts > Messages, and check the active row and thread header.
- [ ] Expert search filters all text severity:P1 scope:experts
  <!-- obelisk:id=01KT1358D0TBPSJ9AJSEHA9GER -->
  - **Expected:** Both Messages rail and Hierarchy search match expert name, domain, and description case-insensitively without changing backend state.
  - **Repro:** Create experts with distinct name/domain/description values; type partial terms in each Experts search input and compare visible cards.
- [ ] Expert thread stores expert id severity:P0 scope:experts,chat-voice
  <!-- obelisk:id=01KT1358D0DG5H936KQQQ910M5 -->
  - **Expected:** Sending a message from an expert thread creates a conversation and messages with `expert_id` set, and the thread reappears only under that expert after reload.
  - **Repro:** Experts > Messages, select `QA Analyst`, send `Draft a risk list`, reload the app, and inspect `/conversations` plus the selected expert thread list.
- [ ] Disabled expert leaves messages severity:P1 scope:experts
  <!-- obelisk:id=01KT1358D0MD3CZVT8K19S69BM -->
  - **Expected:** Toggling an expert off removes it from Messages selection, shows it under Hierarchy Disabled, and preserves its existing database row.
  - **Repro:** Open an enabled expert profile drawer or detail panel, toggle Enabled off, then verify Messages rail and Hierarchy Disabled filter.
- [ ] Rapid toggles settle correctly severity:P1 scope:experts
  <!-- obelisk:id=01KT1358D0YETGQWQQ6ST6DNQV -->
  - **Expected:** Rapid Enabled/Pinned clicks resolve to the last requested state in UI and persisted `GET /experts/{id}` data, without count drift.
  - **Repro:** Click Enabled or Pinned three times quickly in the detail panel, wait for all PATCH calls, then reload and compare counts and row values.

## Configuration Persistence

- [ ] Verified experts are locked severity:P0 scope:experts
  <!-- obelisk:id=01KT1358D0537SX85YHCKCVVJV -->
  - **Expected:** Verified builtin experts reject persona edits and deletes with HTTP 403, while Enabled and Pinned toggles remain allowed.
  - **Repro:** Select a seeded `is_verified=true` expert; attempt `PATCH /experts/{id}` with `description`, `DELETE /experts/{id}`, and `PATCH` with `is_pinned`.
- [ ] Edits survive restart severity:P0 scope:experts
  <!-- obelisk:id=01KT1358D055F20YNMA6WA6QGJ -->
  - **Expected:** Name, Description, Domain, System Context, Avatar, Enabled, and Pinned edits persist in SQLite and reappear after a full Electron/backend restart.
  - **Repro:** Edit each field in ExpertDetailPanel, quit all spawned processes, relaunch with `npm start`, and fetch `GET /experts/{id}`.
- [ ] Delete removes materialized agent severity:P0 scope:experts
  <!-- obelisk:id=01KT1358D0711TYYX8R8HYE9X2 -->
  - **Expected:** Deleting a user expert removes the row, closes the detail panel, decrements totals, and removes its generated `.claude/agents` entry/index mapping.
  - **Repro:** Create a user expert, note its generated agent filename under app userData, delete from Hierarchy, then inspect `GET /experts/{id}` and `.claude` index.
- [ ] Default skills auto-assign severity:P1 scope:experts
  <!-- obelisk:id=01KT1358D0GD9ARHAYK80E90YA -->
  - **Expected:** Creating an expert auto-assigns default skills and domain-matching category skills; `GET /experts/{id}/skills` returns active assignments.
  - **Repro:** Create a `domain=engineering` expert, call `GET /experts/{id}/skills`, and verify default skills plus enabled engineering skills are listed.
- [ ] Duplicate skill assignment blocked severity:P1 scope:experts
  <!-- obelisk:id=01KT1358D05TZF1C4MVYV3Z1QD -->
  - **Expected:** Posting the same `skill_id` twice to `/experts/{id}/skills` returns HTTP 409 and the UI add list does not show already assigned skills.
  - **Repro:** Assign a visible skill from ExpertSkillsSection, reopen Add Skill, then call `POST /experts/{id}/skills` with the same `skill_id`.
- [ ] Reference file attaches cleanly severity:P0 scope:experts,files
  <!-- obelisk:id=01KT1358D0GZCEDCXJWA30RGDK -->
  - **Expected:** Adding a supported document registers `/files/items/from-path`, parses `/files/parse`, attaches `/experts/{id}/context-files`, refreshes the list, and syncs the expert.
  - **Repro:** In ExpertDetailPanel Reference Documents, add a `.md` or `.pdf`; verify filename, size, char count/truncated state, and `GET /experts/{id}/context-files`.
- [ ] Invalid context kind rejected severity:P1 scope:experts,files
  <!-- obelisk:id=01KT1358D0AV0NJYJK6WH087K5 -->
  - **Expected:** `POST` or `PATCH /experts/{id}/context-files` with kind outside `reference` or `template` returns HTTP 400 and leaves existing attachments unchanged.
  - **Repro:** Attach a valid file, then call PATCH on its context id with `{ "kind": "system" }` and compare the next list response.
- [ ] Memory markdown enforces boundaries severity:P0 scope:experts,memory-knowledge
  <!-- obelisk:id=01KT1358D048NDJYKJ1APWQPKE -->
  - **Expected:** Expert memory allows only safe `.md` paths under that expert slug; `.txt`, absolute paths, and `../` traversal return 400 or no file write.
  - **Repro:** Use Expert Memory to create `notes`, then call `/agent-memory/{slug}/files/file.txt` and encoded `../../etc/passwd.md` paths directly.
