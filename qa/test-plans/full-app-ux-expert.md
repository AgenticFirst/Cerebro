---
id: full-app-ux-expert
name: Full app sweep
scope: whole-app
feature: null
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
  - ux-expert
generatedAt: 2026-06-04T21:59:48.672Z
generatedBy: claude
version: 1
---

## Smoke

- [ ] App boots without uncaught errors severity:P0 scope:smoke
  <!-- obelisk:id=01KTAACMNZH1D1JSCK2BDS5FWF -->
  - **Expected:** Electron window renders the sidebar + chat welcome; Python /health returns 200; no red errors in devtools console.
  - **Repro:** Run `tail -f /dev/null | npm start &`; wait for window; open devtools console.
- [ ] Sidebar nav routes to every screen severity:P0 scope:smoke
  <!-- obelisk:id=01KTAACMNZ6GA488340A58ZD06 -->
  - **Expected:** Clicking each nav item swaps the main pane and highlights the active item; no blank panes.
  - **Repro:** Click nav-experts, nav-tasks, nav-routines, nav-files, nav-approvals, nav-settings in the Sidebar.
- [ ] App opens when Python backend fails severity:P1 scope:smoke
  <!-- obelisk:id=01KTAACMNZY92PH5K2N9MR8FA5 -->
  - **Expected:** Window still renders; chat shows engine-idle fallback instead of crashing.
  - **Repro:** Block the backend port or kill the Python child after launch; observe app shell stays usable.
- [ ] Cold-start empty states render severity:P1 scope:smoke
  <!-- obelisk:id=01KTAACMNZT0MFVZ41FGFKVZZK -->
  - **Expected:** Conversation list shows 'No conversations yet'; Tasks/Files/Experts show their empty placeholders, not spinners stuck forever.
  - **Repro:** Launch against a fresh userData dir; visit each primary screen.
- [ ] Sidebar collapse toggles rail width severity:P2 scope:smoke
  <!-- obelisk:id=01KTAACMNZT26P5247SDBGWSQH -->
  - **Expected:** Rail animates from 260px to 56px showing icons-only; tooltips appear on hover; toggle restores width.
  - **Repro:** Click the PanelLeftClose toggle in the Sidebar header, then PanelLeftOpen.

## Chat

- [ ] Send message streams assistant reply severity:P0 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZSKDD6C9SDG5YBP5D -->
  - **Expected:** Assistant tokens stream into MessageList via SSE; ThinkingIndicator clears when the first token arrives.
  - **Repro:** Click New Chat, type into ChatInput, press Enter with a configured engine.
- [ ] First message persists conversation across reload severity:P0 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZ824JTD0C4VPF5DVV -->
  - **Expected:** A new row appears under 'Today'; after app restart the thread and its messages reload.
  - **Repro:** Send one message in a draft chat, confirm sidebar row, then restart the app.
- [ ] Rename conversation via inline edit severity:P1 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZD98C0ZWNEGA8PPPS -->
  - **Expected:** Double-click opens an input pre-filled with title; Enter commits new title (max 200 chars); Escape cancels.
  - **Repro:** Double-click a ConversationRow in the sidebar, edit text, press Enter.
- [ ] Reset session clears Claude Code context severity:P1 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZCT3Q1WYQP67J75D2 -->
  - **Expected:** chatActions.resetSession fires; the next reply has no memory of prior turns in that thread.
  - **Repro:** Hover a ConversationRow, click the RotateCcw (reset) button, then ask a follow-up referencing earlier text.
- [ ] Engine idle shows no-model fallback severity:P1 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZJ2QPA9CC6THVG857 -->
  - **Expected:** Instead of a hang/crash, an engine-idle message is shown prompting model setup.
  - **Repro:** With no engine/model configured, send a chat message.

## Voice Call

- [ ] Start call opens CallScreen with expert avatar severity:P1 scope:chat-voice,experts
  <!-- obelisk:id=01KTAACMNZVC4T5NCKB97G72A3 -->
  - **Expected:** CallScreen renders the expert ExpertAvatar, timer at 00:00, and 'Hold Space or press the mic to talk' hint.
  - **Repro:** From an expert, start a voice call; observe the call view.
- [ ] Hold Space push-to-talk records mic severity:P0 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZHE15254Q2D2B1SZT -->
  - **Expected:** Status shows 'Recording...'; mic unmutes; WaveformVisualizer animates from mic analyser.
  - **Repro:** On an active call, press and hold the Space key.
- [ ] Release Space yields spoken reply severity:P0 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZNMTSHD6B92KAHT53 -->
  - **Expected:** State transitions listening→processing→speaking; TTS audio chunks play back through the speaker.
  - **Repro:** Hold Space, speak, release Space; wait for the expert response.
- [ ] Missing voice models shows ModelSetupView severity:P1 scope:chat-voice
  <!-- obelisk:id=01KTAACMNZKDC0MPG4EJFYTS61 -->
  - **Expected:** When callError contains 'not found' and no session, ModelSetupView renders with a working Back button to Experts.
  - **Repro:** Start a call with voice models absent from the models dir.
- [ ] Escape ends call and stops capture severity:P1 scope:chat-voice
  <!-- obelisk:id=01KTAACMP0H443TGMRP8440Z8N -->
  - **Expected:** endCall fires; mic capture and playback stop; timer resets; call view tears down cleanly.
  - **Repro:** During an active call, press the Escape key.

## Experts & Teams

- [ ] Create expert via dialog saves to roster severity:P0 scope:experts
  <!-- obelisk:id=01KTAACMP0HNDC8B278F8A7Q2X -->
  - **Expected:** After filling name/domain/system prompt in CreateExpertDialog and saving, the new expert appears in the Experts roster and survives reload.
  - **Repro:** Experts screen → New Expert → complete CreateExpertDialog → Save.
- [ ] Expert detail edits persist severity:P1 scope:experts
  <!-- obelisk:id=01KTAACMP03VJSQYRN8R4GDD51 -->
  - **Expected:** Editing system prompt, skills, and context files in ExpertDetailPanel saves; values reload after restart.
  - **Repro:** Open an expert, edit fields in ExpertDetailPanel, save, restart app.
- [ ] delegate_to_team renders TeamRunCard severity:P0 scope:experts
  <!-- obelisk:id=01KTAACMP089G4N04GNGQ1B7H3 -->
  - **Expected:** TeamRunCard shows per-member status (queued→started→completed) and a synthesized result; run metadata survives reload.
  - **Repro:** In chat, ask a multi-part task that triggers delegate_to_team.
- [ ] propose_team saves team and members severity:P1 scope:experts
  <!-- obelisk:id=01KTAACMP0K5NRQGH08X4C1S4F -->
  - **Expected:** TeamProposalCard Save creates the member experts and the team; Dismiss removes the card without writes.
  - **Repro:** Trigger propose_team in chat; click Save on TeamProposalCard.
- [ ] Delete expert asks before removing severity:P1 scope:experts
  <!-- obelisk:id=01KTAACMP0HVPSJW25N3H66V78 -->
  - **Expected:** ExpertContextMenu delete requires confirmation; cancel leaves the expert intact.
  - **Repro:** Open an expert's context menu, choose Delete, observe confirmation.
- [ ] Expert Messages tab opens thread view severity:P2 scope:experts
  <!-- obelisk:id=01KTAACMP0HMH9FVTVXXHESR5S -->
  - **Expected:** Selecting an expert in the Messages tab opens ExpertThreadView with its prior messages.
  - **Repro:** Experts → Messages tab → pick an expert from the rail.

## Routines

- [ ] Save routine from proposal card severity:P0 scope:routines
  <!-- obelisk:id=01KTAACMP0PQ2XY8F3JVV7FETA -->
  - **Expected:** RoutineProposal Save creates a routine listed on the Routines screen with its steps and required connections.
  - **Repro:** Trigger a routine proposal in chat; click Save on the proposal card.
- [ ] Preview run executes steps in order severity:P1 scope:routines
  <!-- obelisk:id=01KTAACMP0N66WDMY33454ZS4S -->
  - **Expected:** Preview launches a previewRunId run; steps execute sequentially and progress is visible in Activity.
  - **Repro:** From a saved/proposed routine, click Preview.
- [ ] Cron trigger schedules next run severity:P1 scope:routines
  <!-- obelisk:id=01KTAACMP08R5AMWZVNE46QSCP -->
  - **Expected:** Selecting cron triggerType with a valid expression stores it and shows the computed next-run time.
  - **Repro:** Edit a routine, set trigger to cron, enter a cron expression, save.
- [ ] Approval-gated step pauses the run severity:P0 scope:routines,activity-approvals
  <!-- obelisk:id=01KTAACMP0075A5DAZ5V2JTRAW -->
  - **Expected:** A step with requiresApproval pauses execution and creates a pending approval rather than acting.
  - **Repro:** Run a routine whose step touches an external service with requiresApproval set.
- [ ] Step failure with on_error fail aborts pipeline severity:P1 scope:routines
  <!-- obelisk:id=01KTAACMP0FE27FE65CYHEF7D4 -->
  - **Expected:** A failing step with on_error=fail halts the routine; run is marked failed and remaining steps are skipped.
  - **Repro:** Run a routine whose first step errors with on_error set to fail.

## Tasks

- [ ] Create task persists across reload severity:P0 scope:tasks
  <!-- obelisk:id=01KTAACMP0T8WEVTBXDJJ7SQM6 -->
  - **Expected:** A newly created task appears on the Tasks screen and remains after app restart.
  - **Repro:** Tasks screen → create a task → restart the app.
- [ ] Sidebar Tasks badge counts active work severity:P1 scope:tasks
  <!-- obelisk:id=01KTAACMP0GZJ8B4G35GH5RGW3 -->
  - **Expected:** nav-tasks badge equals in_progress + to_review counts and updates live as tasks change.
  - **Repro:** Create a task in in_progress; observe the Sidebar Tasks badge.
- [ ] Status change moves task and updates badge severity:P1 scope:tasks
  <!-- obelisk:id=01KTAACMP0TZ7MDVK1BTMY2RGQ -->
  - **Expected:** Setting a task to to_review moves it to that group and recomputes the sidebar badge.
  - **Repro:** Change a task's status to to_review on the Tasks screen.
- [ ] Tasks grouped by status with badges severity:P1 scope:tasks
  <!-- obelisk:id=01KTAACMP00KBYT5TK9H22VPRH -->
  - **Expected:** Tasks render grouped by status with correct counts; no task appears in two groups.
  - **Repro:** Create several tasks across statuses, open the Tasks screen.
- [ ] Empty Tasks shows placeholder severity:P2 scope:tasks
  <!-- obelisk:id=01KTAACMP0A8BRVDW48FBC91WW -->
  - **Expected:** With no tasks, the Tasks screen shows its empty state, not a spinner.
  - **Repro:** Launch against fresh userData and open Tasks.

## Integrations & Connections

- [ ] Connect Telegram stores encrypted token severity:P0 scope:integrations
  <!-- obelisk:id=01KTAACMP0BNS4W2H43C4MGZJ3 -->
  - **Expected:** Entering a bot token in TelegramConnectModal sets TelegramSection status to connected; token is encrypted at rest and never sent to the model.
  - **Repro:** Settings → Integrations → Telegram → Connect → paste bot token → Save.
- [ ] Invalid token surfaces verification error severity:P0 scope:integrations
  <!-- obelisk:id=01KTAACMP0FNJRR13AJ4FE0S6S -->
  - **Expected:** A bad token fails verification with an inline error and the section stays disconnected.
  - **Repro:** Open any connect modal (e.g. HubSpot), enter an invalid key, submit.
- [ ] Replace existing Slack token severity:P1 scope:integrations
  <!-- obelisk:id=01KTAACMP0JPXS8GYW7GQMW5TM -->
  - **Expected:** Re-opening SlackConnectModal and entering a new token replaces the stored credential; status stays connected.
  - **Repro:** Connect Slack, reopen the modal, paste a new token, save.
- [ ] Verify Tavily key enables web search severity:P1 scope:integrations
  <!-- obelisk:id=01KTAACMP04QK4J84N510X984Q -->
  - **Expected:** ConnectedAppsSection Tavily verify hits /search/verify successfully; the web_search tool becomes available to experts.
  - **Repro:** Settings → Integrations → Connected Apps → enter Tavily key → Verify.
- [ ] Disconnect removes stored credential severity:P1 scope:integrations
  <!-- obelisk:id=01KTAACMP0JF78MJN79BF5A340 -->
  - **Expected:** Disconnecting deletes the secure token and flips the section to disconnected.
  - **Repro:** Disconnect a connected integration (e.g. Telegram) and confirm.
- [ ] Connect Calendar shows connected state severity:P2 scope:integrations
  <!-- obelisk:id=01KTAACMP0P3SGWPD5HB0KKBCT -->
  - **Expected:** Completing CalendarConnectModal flips CalendarSection to connected and surfaces calendar in the Calendar app.
  - **Repro:** Settings → Integrations → Calendar → Connect.

## Memory & Knowledge Base

- [ ] Add context file in Settings persists severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAACMP0ZXZ3P43K0VZ8BMZV -->
  - **Expected:** A context file created in Settings → Memory is stored and included in the assembled system prompt; it reloads after restart.
  - **Repro:** SettingsScreen → Memory → create a context file → save → restart.
- [ ] Learned facts auto-extracted after reply severity:P1 scope:memory-knowledge,chat-voice
  <!-- obelisk:id=01KTAACMP0KF42WK0JSDFAY9BH -->
  - **Expected:** After a factual chat exchange, the extracted fact appears in the Memory items list (fire-and-forget extraction).
  - **Repro:** Send a message stating a durable fact; open Settings → Memory items.
- [ ] Secret detection blocks storing credentials severity:P0 scope:memory-knowledge
  <!-- obelisk:id=01KTAACMP0KP629TVJBWS6T3HN -->
  - **Expected:** A message containing an API-key-like string is filtered and never written to memory_items.
  - **Repro:** Send a chat message containing a fake API key, then inspect memory items.
- [ ] Create and edit a Knowledge Base page severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAACMP0NE7HFSC75KSPJFJ6 -->
  - **Expected:** A new page appears in the PageTreeSidebar; edits in PageEditor save and reload.
  - **Repro:** Knowledge Base → new page → edit content → navigate away and back.
- [ ] Ask AI answers from KB content severity:P1 scope:memory-knowledge
  <!-- obelisk:id=01KTAACMP034MATB9JDQXPYC8S -->
  - **Expected:** AskAiPanel returns an answer grounded in existing KB pages, with results shown in SearchResults.
  - **Repro:** Click AskAiButton, ask about content present in a KB page.
- [ ] Trash restores a deleted KB page severity:P2 scope:memory-knowledge
  <!-- obelisk:id=01KTAACMP0FDZ7EANY6KM4KJJE -->
  - **Expected:** Deleting a page moves it to TrashModal; Restore returns it to the page tree.
  - **Repro:** Delete a KB page, open TrashModal, click Restore.

## Files

- [ ] Create bucket via modal severity:P1 scope:files
  <!-- obelisk:id=01KTAACMP0GTJAB9VN3DJX4DKA -->
  - **Expected:** CreateBucketModal save adds a new bucket to the FilesSidebar.
  - **Repro:** Files screen → New Bucket → name it → Save.
- [ ] Uploaded file appears in grid severity:P0 scope:files
  <!-- obelisk:id=01KTAACMP0PK0SBHKJCW4GNFPN -->
  - **Expected:** An added file renders in FileGrid/FileList with name and type icon; count updates.
  - **Repro:** Files screen → add a file to a bucket.
- [ ] Preview drawer shows file content severity:P1 scope:files
  <!-- obelisk:id=01KTAACMP0E4Y56YTCA3N1Q395 -->
  - **Expected:** Clicking a file opens FilePreviewDrawer rendering its content/preview.
  - **Repro:** Click a file row/tile in the Files screen.
- [ ] Move/copy file between buckets severity:P1 scope:files
  <!-- obelisk:id=01KTAACMP0THDBC660P1NBN9P2 -->
  - **Expected:** MoveCopyDialog relocates (or copies) the file to the target bucket; source updates accordingly.
  - **Repro:** Open a file's context menu → Move/Copy → pick a destination bucket.
- [ ] Delete file asks before removing severity:P1 scope:files
  <!-- obelisk:id=01KTAACMP0KR8CAR98QA7Q8F79 -->
  - **Expected:** FileContextMenu delete confirms before removing; cancel keeps the file.
  - **Repro:** Open a file's context menu → Delete → observe confirmation.

## Activity & Approvals

- [ ] Pending approval badges the sidebar severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAACMP00GDSQCFZVMZ6YFNJ -->
  - **Expected:** An external-facing action creates a pending approval; nav-approvals badge increments and the Pending tab shows an ApprovalCard with summary.
  - **Repro:** Trigger a run-chat-action that requires approval; open the Approvals screen.
- [ ] Approve resumes the paused run severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAACMP0BRMDDX0E5ZF8C62T -->
  - **Expected:** Clicking Approve on the ApprovalCard resolves the gate and the run continues its step.
  - **Repro:** On the Approvals Pending tab, click Approve on a pending card.
- [ ] Deny with reason cancels the run severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAACMP0W6TVY5RNM4B8WDQ0 -->
  - **Expected:** Submitting the inline deny reason throws StepDeniedError; the run is cancelled (not failed) and the reason is persisted.
  - **Repro:** Click Deny on a pending approval, enter a reason, submit.
- [ ] History tab lists resolved decisions severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAACMP0G2XW1H5WPM105GBN -->
  - **Expected:** After approving/denying, the History tab shows the request with status and decision reason.
  - **Repro:** Resolve an approval, then open the Approvals History tab.
- [ ] Run detail shows step timeline and logs severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAACMP00QDMQAJZFF293C8G -->
  - **Expected:** Opening a RunCard reveals RunDetailPanel with StepTimeline, per-step status, and RunLogs.
  - **Repro:** Settings → Activity → click a run's RunCard.
- [ ] Stale runs recovered on startup severity:P2 scope:activity-approvals
  <!-- obelisk:id=01KTAACMP0D4GSDFH02NT6GTAX -->
  - **Expected:** Runs left running/paused at crash are marked failed and their pending approvals expired after restart.
  - **Repro:** Kill the app mid-run, relaunch, check the run and approval states.
