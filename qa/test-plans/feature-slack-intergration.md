---
id: feature-slack-intergration
name: Slack Integration sweep
scope: feature
feature: Slack Intergration
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
generatedAt: 2026-06-01T04:51:06.573Z
generatedBy: claude
version: 2
---

## Smoke

- [ ] App boots and renders Integrations screen severity:P0 scope:smoke
  <!-- obelisk:id=01KT0NC44H8F4ER09ZV3KXDSB3 -->
  - **Expected:** Electron window opens, no uncaught errors in console, Integrations nav item routes to ConnectedAppsSection without crash.
  - **Repro:** tail -f /dev/null | npm start &, wait for health check, click Connections in sidebar.
- [ ] SlackSection mounts with offline status severity:P0 scope:smoke,slack-ui
  <!-- obelisk:id=01KT0NC44H80D0SZ9PJYPN22TG -->
  - **Expected:** SlackSection renders token inputs, allowlist fields, and an 'Offline' status pill (status.running=false) with no thrown error.
  - **Repro:** Open Connections, scroll to Slack panel before any tokens are configured.
- [ ] Status poll loop does not leak on unmount severity:P2 scope:smoke,slack-ui
  <!-- obelisk:id=01KT0NC44HFW4RN7S29S6X0X4A -->
  - **Expected:** refreshStatus 5s interval clears on navigate-away; no setInterval warnings, status IPC stops firing.
  - **Repro:** Open SlackSection, navigate to another screen, watch IPC traffic for slack.status calls.
- [ ] Connect modal opens and loads manifest severity:P1 scope:smoke,slack-onboarding
  <!-- obelisk:id=01KT0NC44HY57R5ESY4T8RD1PB -->
  - **Expected:** SlackConnectModal renders step 1 of 6, manifest textarea populated from slack.getManifest(), no empty-yaml crash.
  - **Repro:** Trigger Slack connect tour; assert STEP_COUNT indicator and non-empty manifest.yaml textarea.

## Slack Connection & Token Verification

- [ ] Verify accepts valid bot+app token pair severity:P0 scope:slack-connect,slack-api
  <!-- obelisk:id=01KT0NC44HAJ40K3YT9802604F -->
  - **Expected:** slack.verify(botDraft,appDraft) returns ok with teamName; UI shows 'verified as <team>' green check (verify.kind='ok').
  - **Repro:** In SlackSection enter valid xoxb- and xapp- tokens, click Verify; auth.test + apps.connections.open succeed.
- [ ] Verify button disabled until both tokens present severity:P1 scope:slack-connect,slack-ui
  <!-- obelisk:id=01KT0NC44H78V2A95EJXQ2RTB7 -->
  - **Expected:** draftReady=false when either field empty; Verify button is disabled (opacity-50, cursor-not-allowed).
  - **Repro:** Type only the bot token, leave app token blank; assert Verify stays disabled.
- [ ] Invalid bot token surfaces scrubbed error severity:P0 scope:slack-connect,slack-api
  <!-- obelisk:id=01KT0NC44HN0QGP31NARN228BY -->
  - **Expected:** verify.kind='err' with red XCircle; error string has no xoxb-/xapp- substring (scrubTokenish applied).
  - **Repro:** Enter a malformed bot token, click Verify; SlackApi.authTest throws invalid_auth.
- [ ] Enabling bridge with good tokens starts Bolt severity:P0 scope:slack-connect,slack-bridge
  <!-- obelisk:id=01KT0NC44H0SKP84E90BPSDYWB -->
  - **Expected:** slack.enable() returns ok, status.running=true, statusRunning label shows last-event time, teamName + botUserId rendered.
  - **Repro:** Save verified tokens, toggle ToggleSwitch on; bridge.start() probes auth.test then app.start() succeeds.
- [ ] Enable fails gracefully when app.start throws severity:P0 scope:slack-connect,slack-bridge
  <!-- obelisk:id=01KT0NC44H4AQY64VHJ016TFES -->
  - **Expected:** enable() returns ok:false, enabled rolled back to false in settings, status.lastError set, toggle returns to off.
  - **Repro:** Provide a bot token that passes auth.test but an app token that fails Socket Mode open; toggle enable.
- [ ] Clear tokens stops bridge and wipes booleans severity:P1 scope:slack-connect,slack-bridge
  <!-- obelisk:id=01KT0NC44HK2M74ZNAEHDCH8QV -->
  - **Expected:** clearTokens() persists empty values, status.hasBotToken/hasAppToken=false, bridge.running=false, token inputs reappear.
  - **Repro:** With tokens configured, click Clear; assert setTokens({null,null}) path runs stop().
- [ ] Changing tokens while running requires re-enable severity:P2 scope:slack-connect,slack-bridge
  <!-- obelisk:id=01KT0NC44HGS415W1DJ3S8B84X -->
  - **Expected:** reloadSettings() returns ok:false with 'disable and re-enable Slack to apply' when bot/app token differs at runtime.
  - **Repro:** Bridge running, replace token, click Save which calls slack.reload(); assert warning returned.

## Inbound Message Dispatch

- [ ] Allowlisted @mention starts one agent run severity:P0 scope:slack-inbound,slack-bridge
  <!-- obelisk:id=01KT0NC44H44EH2YM9CZKWS73C -->
  - **Expected:** app_mention strips bot id, ensureConversation maps threadKey, startRun fires, placeholder '_Cerebro is thinking…_' posted in-thread.
  - **Repro:** From an allowlisted user/channel, @mention the bot; assert single activeRuns entry and conversation created.
- [ ] Non-allowlisted user gets ID ephemeral once/hour severity:P0 scope:slack-inbound,slack-allowlist
  <!-- obelisk:id=01KT0NC44HWVCW33B8DB5JGKPJ -->
  - **Expected:** isAllowlisted false → chatPostEphemeral with 'Your Slack ID is U…'; repeat within 60min suppressed via unknownLastReply.
  - **Repro:** DM the bot from a user not on allowlist twice; assert only first reply posts.
- [ ] Empty allowlists block everything (closed-by-default) severity:P0 scope:slack-inbound,slack-allowlist
  <!-- obelisk:id=01KT0NC44HAKPMG93N42QYX839 -->
  - **Expected:** isAllowlisted returns false when both channel and user lists are empty; no inference dispatched.
  - **Repro:** Clear allowlists, send an inbound mention; assert handleInbound returns before startRun.
- [ ] Duplicate event_id is dropped (dedupe) severity:P1 scope:slack-inbound,slack-dedupe
  <!-- obelisk:id=01KT0NC44HS37P4GHE8ZKA7FNF -->
  - **Expected:** EventDedupe.observe returns false on replay; handler returns early, no second conversation/run.
  - **Repro:** Replay the same Socket Mode envelope (same body.event_id); assert single dispatch.
- [ ] Second message on busy thread replies 'still working' severity:P0 scope:slack-inbound,slack-concurrency
  <!-- obelisk:id=01KT0NC44H7QAGEPRDE5CCQXQE -->
  - **Expected:** activeRuns has the threadKey → chatPostMessage hourglass note with elapsed label; no second startRun.
  - **Repro:** Send a follow-up mention in the same thread while the first run is in-flight.
- [ ] Per-user rate limit returns ephemeral after 20/min severity:P1 scope:slack-inbound,slack-ratelimit
  <!-- obelisk:id=01KT0NC44HG5KZ2BBFNEDBWAMJ -->
  - **Expected:** authorizedRateLimiter.allow false on 21st message in a minute → 'Rate limit exceeded' ephemeral, no run started.
  - **Repro:** Fire 21 inbound messages from one allowlisted user within 60s.
- [ ] Bot/subtype DM messages are ignored severity:P1 scope:slack-inbound,slack-bridge
  <!-- obelisk:id=01KT0NC44HDTGH6G67PYB5K4TR -->
  - **Expected:** message handler returns early when channel_type!=='im', subtype present, bot_id set, or user===botUserId; no run.
  - **Repro:** Emit a message_changed edit and a bot_message into the DM channel.
- [ ] Matching routine trigger fires and skips AI reply severity:P1 scope:slack-inbound,slack-routines
  <!-- obelisk:id=01KT0NC44HZ2ARYPY13V8G6T3Z -->
  - **Expected:** matchSlackTriggers returns a routine → dispatchRoutine runs with __trigger__ context, handleInbound returns before startRun.
  - **Repro:** Configure a trigger_slack_message routine for the channel; send a matching message.

## Slash Command & Expert Pinning

- [ ] /cerebro ack fires within 3 seconds severity:P0 scope:slack-slash
  <!-- obelisk:id=01KT0NC44H4JC93VYZSN329J3B -->
  - **Expected:** app.command('/cerebro') calls ack() before handling; Slack shows no 'failed with operation_timeout'.
  - **Repro:** Invoke /cerebro help from an allowlisted channel; observe immediate ephemeral.
- [ ] /cerebro ask late-responds via response_url severity:P0 scope:slack-slash,slack-api
  <!-- obelisk:id=01KT0NC44H6Q0FRSRK6FER2881 -->
  - **Expected:** Ephemeral '_Cerebro is thinking…_' first, then respondToSlashCommand replaces it with the buffered answer.
  - **Repro:** Run /cerebro ask <question>; assert respondLate POST to response_url with replace=true.
- [ ] /cerebro expert <slug> pins accessible expert severity:P1 scope:slack-slash,slack-experts
  <!-- obelisk:id=01KT0NC44H3VGS94A94MGHZ928 -->
  - **Expected:** setThreadExpert matches slug, persists threadExpertMap, confirms pin; unmatched slug returns 'No expert matched'.
  - **Repro:** Run /cerebro expert research, then /cerebro expert bogus; check both responses.
- [ ] Pinning expert without access is refused severity:P1 scope:slack-slash,slack-experts
  <!-- obelisk:id=01KT0NC44H5Y97VV927961FYM6 -->
  - **Expected:** getAccessibleExpertIds excludes id → 'You don't have access to <name>' ephemeral; pin not written.
  - **Repro:** Restrict user via userExpertAccess, attempt to pin an out-of-scope expert.
- [ ] Slash command from non-allowlisted user refused severity:P1 scope:slack-slash,slack-allowlist
  <!-- obelisk:id=01KT0NC44H1AM9F0KRT8PWG51T -->
  - **Expected:** isAllowlisted false → ephemeral 'Not authorised. Your Slack ID is U…'; no inference run.
  - **Repro:** Invoke /cerebro status from a user not on the allowlist.
- [ ] Lost-access pinned expert falls back to default severity:P2 scope:slack-inbound,slack-experts
  <!-- obelisk:id=01KT0NC44HM4T1V3X8GA1B01Y1 -->
  - **Expected:** Inbound run drops threadExpertMap pin when accessibleExpertIds no longer includes it; expertId becomes null, default agent runs.
  - **Repro:** Pin expert, revoke access via expert-access config, send a new message in that thread.

## Outbound Actions & Streaming Resilience

- [ ] send_slack_message rejects non-allowlisted channel severity:P0 scope:slack-actions,slack-allowlist
  <!-- obelisk:id=01KT0NC44HRB8NAX56N9K2H7SK -->
  - **Expected:** execute throws 'channel <id> is not in the Slack allowlist' before any chat.postMessage call.
  - **Repro:** Run send_slack_message action with a channel id absent from allowlist.
- [ ] send_slack_message errors when bridge disabled severity:P1 scope:slack-actions,slack-bridge
  <!-- obelisk:id=01KT0NC44H2P2SEMB24XEEK8PN -->
  - **Expected:** getChannel null → throws 'Slack bridge is not enabled'; isConnected false returns 'not_connected' availability.
  - **Repro:** Disable Slack, execute the send_slack_message action.
- [ ] Long outbound text chunks at 3500 chars severity:P1 scope:slack-actions,slack-chunking
  <!-- obelisk:id=01KT0NC44HS11J3H1G58G0V1SD -->
  - **Expected:** sendActionMessage splits via chunkSlackText, posts sequential messages, returns first ts; no msg_too_long error.
  - **Repro:** Send a >7000 char body through send_slack_message; assert multiple postMessage calls.
- [ ] Proactive send rate-limited at 30/hour/channel severity:P2 scope:slack-actions,slack-ratelimit
  <!-- obelisk:id=01KT0NC44HTZD5BJHA7STTF3MM -->
  - **Expected:** proactiveRateLimiter.allow false → returns error 'channel <id> rate-limited', no API call made.
  - **Repro:** Fire 31 sendActionMessage calls to one channel within an hour.
- [ ] send_slack_file rejects missing local file severity:P1 scope:slack-actions,slack-files
  <!-- obelisk:id=01KT0NC44HKJJM9F0RTFEDFNQV -->
  - **Expected:** fs.existsSync false → returns {fileId:null, error:'file not found: <path>'} without calling filesUpload.
  - **Repro:** Run send_slack_file action pointing at a nonexistent path.
- [ ] Stream sink posts fresh final message for notification severity:P0 scope:slack-stream
  <!-- obelisk:id=01KT0NC44HBH300HR86CBEYGTC -->
  - **Expected:** On 'done' finalize() deletes placeholder then chat.postMessage final text, so Slack rings the client (edits don't notify).
  - **Repro:** Complete an inbound run; assert chatDelete(placeholder) followed by chatPostMessage(final).
- [ ] chat.update failure during stream is non-fatal severity:P1 scope:slack-stream,slack-api
  <!-- obelisk:id=01KT0NC44HHQMXQDHCR9KK4B0G -->
  - **Expected:** flushEdit catches not_found/error, logs scrubbed message, run still finalizes with a posted answer.
  - **Repro:** Make chatUpdate reject mid-stream (e.g. message_not_found); assert finalize still posts.
- [ ] Auth-class error routes recovery to operator DM severity:P1 scope:slack-stream,slack-auth-recovery
  <!-- obelisk:id=01KT0NC44H4RCSK92JK9MK52T0 -->
  - **Expected:** errorClass 'auth' → onAuthFailure handled, brief 'reconnecting to Claude' posted, raw 'lost session' text suppressed.
  - **Repro:** Force the run to emit error with errorClass='auth' while operatorUserId is set.

## Persistence & Secure Storage

- [ ] Tokens persist encrypted across restart severity:P0 scope:slack-persistence,secure-token
  <!-- obelisk:id=01KT0NC44J2AWFYVMHP12XCXNH -->
  - **Expected:** setTokens writes encryptForStorage blob to settings; after reload loadSettings decrypts, status.hasBotToken=true, plaintext never in DB.
  - **Repro:** Configure tokens, restart app, inspect settings rows for slack token keys.
- [ ] Renderer never receives raw token plaintext severity:P0 scope:slack-persistence,secure-token
  <!-- obelisk:id=01KT0NC44JYEMCZHAK0SD791FK -->
  - **Expected:** slack.status() exposes only hasBotToken/hasAppToken booleans; no xoxb-/xapp- value crosses IPC.
  - **Repro:** Inspect the SlackStatusResponse payload returned to SlackSection.
- [ ] Allowlist saved and reloaded from settings severity:P1 scope:slack-persistence,slack-allowlist
  <!-- obelisk:id=01KT0NC44J6T9YXWVRAV514KC9 -->
  - **Expected:** handleSave persists parsed channel/user ids; SlackSection re-mounts and repopulates allowChans/allowUsers from settings.
  - **Repro:** Enter 'C01ABCDE, U01ABCDE', Save, reopen Connections; fields show same ids.
- [ ] Allowlist parser strips mention wrappers severity:P2 scope:slack-persistence,slack-allowlist
  <!-- obelisk:id=01KT0NC44JGV5V1J1K5SF1C09C -->
  - **Expected:** parseList converts <#C01ABCDE|general> to C01ABCDE and drops tokens shorter than 7 chars or wrong prefix.
  - **Repro:** Paste '<#C01ABCDE|general>, foo, *' into channels field, Save; assert cleaned array.
- [ ] Thread→conversation map survives reload severity:P1 scope:slack-persistence,slack-inbound
  <!-- obelisk:id=01KT0NC44JHTC786Q2B6Y7KNQZ -->
  - **Expected:** threadConversationMap persisted; a repeat message in the same thread resumes (resume=true) rather than creating a new conversation.
  - **Repro:** Send two messages in one thread across a bridge restart; assert same conversationId reused.
- [ ] Stale conversation mapping self-heals on 404 severity:P1 scope:slack-persistence,slack-inbound
  <!-- obelisk:id=01KT0NC44JB1ASXS8NB6ZKY9VK -->
  - **Expected:** postUserMessageWithRecovery deletes stale threadKey, recreates conversation, re-posts the user message successfully.
  - **Repro:** Delete the mapped conversation row in DB, then send a message in that thread.
- [ ] Operator user id persists for auth recovery severity:P2 scope:slack-persistence,slack-auth-recovery
  <!-- obelisk:id=01KT0NC44JQ4KT62CK9R0ZVNQ3 -->
  - **Expected:** setOperatorUserId trims and stores value; getOperatorUserId returns it after reload, used to route re-auth DM.
  - **Repro:** Set operator U01ABCDE in SlackSection, Save, restart, verify persisted.
- [ ] Plaintext-fallback storage shows warning banner severity:P2 scope:slack-persistence,slack-ui
  <!-- obelisk:id=01KT0NC44J1K6CD9YQ0G9Z00MK -->
  - **Expected:** When tokenBackend!=='os-keychain', SlackSection renders the amber ShieldAlert plaintext-fallback banner instead of the encrypted lock banner.
  - **Repro:** Run where OS keychain is unavailable; open SlackSection and check banner variant.
