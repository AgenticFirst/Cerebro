---
id: feature-activity-approvals
name: Activity-approvals sweep
scope: feature
feature: activity-approvals
agentNames:
  - qa-hunter
  - manual-qa
  - ios-qa-pilot
  - ux-expert
generatedAt: 2026-06-04T22:06:24.992Z
generatedBy: claude
version: 1
---

## Smoke

- [ ] App boots and Activity screen renders without errors severity:P0 scope:activity-approvals,smoke
  <!-- obelisk:id=01KTAARQPZJ87SSBN63WX3QPJY -->
  - **Expected:** App launches; clicking the Activity sidebar item mounts ActivityScreen, shows the spinner then the runs list or empty state with no uncaught console errors.
  - **Repro:** Launch via `tail -f /dev/null | npm start &`; open DevTools console; click sidebar → Activity.
- [ ] Approvals screen mounts with three tabs severity:P0 scope:activity-approvals,smoke
  <!-- obelisk:id=01KTAARQPZKN43SS2K8QHHQ7DY -->
  - **Expected:** Clicking sidebar → Approvals renders ApprovalsScreen with Pending/History/Auto tabs (data-tour-id='approvals-tabs') and the ShieldCheck header; Pending is the default active tab.
  - **Repro:** Sidebar → Approvals; confirm three tab buttons render and 'pending' has the accent underline.
- [ ] Activity error state reachable when runs fetch fails severity:P1 scope:activity-approvals,smoke
  <!-- obelisk:id=01KTAARQPZCXA0FZHP9545T6KH -->
  - **Expected:** When GET /engine/runs fails on first load, the AlertCircle error block with 'activity.failedToLoad' and a Retry button renders instead of the list.
  - **Repro:** Kill the Python backend, then navigate to Activity; observe error card; click Retry after restart recovers the list.
- [ ] Approvals badge surfaces pending count in sidebar severity:P1 scope:activity-approvals,smoke
  <!-- obelisk:id=01KTAARQPZX1XWK52Y084CCKTA -->
  - **Expected:** With at least one pending approval, the Approvals sidebar nav shows a count badge equal to pendingApprovals.length from ApprovalContext.
  - **Repro:** Trigger an approval-gated run, observe sidebar badge increments to match the pending tab count.

## Activity — runs list, filters & detail panel

- [ ] Runs list loads with total badge and 30-row page severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZ5NNQHGRX74YB76NR -->
  - **Expected:** GET /engine/runs?offset=0&limit=30 populates RunCards; the header 'activity.total' badge shows res.data.total; only up to PAGE_SIZE rows render initially.
  - **Repro:** Seed 40+ runs; open Activity; count cards (≤30) and verify total badge reads 40+.
- [ ] Status/type/trigger filters append correct query params severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZ06YS6MMXZ6Q27YSS -->
  - **Expected:** Selecting status=running adds &status=running, type=routine adds &run_type=routine, trigger=chat adds &trigger=chat; list refetches from offset 0 and selectedRunId clears.
  - **Repro:** Click each filter pill; inspect the /engine/runs request URL in network tab for the expected params.
- [ ] Load more appends next page without dropping rows severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZDBTWHS9D94H0C2A6 -->
  - **Expected:** Clicking 'Load more' calls fetchRuns(runs.length, true), appends the next 30 runs, and the button hides once runs.length >= total.
  - **Repro:** With >30 runs, scroll down, click Load more; verify older rows append below existing ones.
- [ ] Paused run links to Approvals screen severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZ2T30YVA0FPR13G79 -->
  - **Expected:** A run with status 'paused' shows the amber 'activity.awaitingApproval →' button; clicking it calls onNavigateApprovals and switches activeScreen to 'approvals' without toggling card selection.
  - **Repro:** Create an approval-gated paused run; click the amber link on its RunCard; confirm Approvals screen opens.
- [ ] Detail panel opens with Steps/Events/Logs tabs severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZWHHSXNYVABAQNF1B -->
  - **Expected:** Clicking a RunCard opens RunDetailPanel; it fetches /engine/runs/{id}, /events?limit=500, /children via allSettled; Steps tab is active; Children tab only shows when children exist.
  - **Repro:** Click any run; verify panel slides in, run info renders, and switching tabs works.
- [ ] Live polling refreshes running/paused runs every 5s severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZMAXKQYBTHZQAE7ST -->
  - **Expected:** When any run is running/paused, a 5s interval refetches page 0 and merges first-page ids while preserving extra loaded rows; non-live lists do not poll.
  - **Repro:** Open Activity with a running run; watch network for /engine/runs polls every ~5s; confirm completed-only lists stop polling.
- [ ] Detail panel survives partial fetch failure severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZEEDZ5ZDA1XPMSGV7 -->
  - **Expected:** If only one of run/events/children resolves ok, the panel still renders available data; loadError only shows when all three fail.
  - **Repro:** Mock /events to 500 while /runs/{id} succeeds; confirm run info still renders and no error screen.
- [ ] Empty vs no-filter-match states differ severity:P2 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZD378ZET8BWPX3DXZ -->
  - **Expected:** Zero runs with all filters 'all' shows 'activity.noActivityYet' + Start conversation CTA; zero matches under an active filter shows 'activity.noMatchFilters' instead.
  - **Repro:** Fresh DB → see empty CTA; then set status=failed with no failures → see no-match copy.
- [ ] Failed run error is humanized in detail panel severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZMCVP49KFHH2Z41W3 -->
  - **Expected:** A failed run with error 'Step "<uuid>" timed out after 300000ms' renders humanizeRunError output 'Step "<step name>" timed out after 5 min' in the red error box.
  - **Repro:** Seed a failed run whose error references a known step_id; open detail panel; verify friendly name + '5 min'.
- [ ] Server timestamps render as UTC not local severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZERWMFQTW7K3K66KW -->
  - **Expected:** A SQLAlchemy naive timestamp ('2026-04-28 01:53:52.736402') is parsed as UTC by parseServerTimestamp, so durations/timeAgo are never negative.
  - **Repro:** Set OS timezone to UTC-7; open a recent run; confirm 'started' time and elapsed are positive and correct.

## Approvals — pending decisions & validation

- [ ] Approve removes card and decrements pending count severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZ9ZTKM413J3KJS73R -->
  - **Expected:** Clicking Approve on an ApprovalCard calls engine.approve(id); on success refresh() refetches /engine/approvals?status=pending and the card disappears, pendingCount drops by one.
  - **Repro:** Open Pending tab with one approval; click Approve; verify spinner then card removal and badge update.
- [ ] Deny via inline reason form submits reason severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZFR2Z4H5B2BXAGFCD -->
  - **Expected:** Clicking Deny reveals the reason input; typing a reason and confirming calls engine.deny(id, reason); card clears and form resets denyReason to empty.
  - **Repro:** Pending tab → Deny → type 'not now' → Confirm; verify deny call carries the reason and card removed.
- [ ] Empty deny reason sends undefined not empty string severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZGMSVRZN92NN3B18E -->
  - **Expected:** Confirming deny with a blank input passes `denyReason || undefined` so the backend receives no reason rather than an empty string.
  - **Repro:** Pending tab → Deny → leave input blank → Confirm; inspect deny IPC payload has reason undefined.
- [ ] Enter submits deny, Escape cancels the form severity:P2 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZCAPSYTH6NGER7VN9 -->
  - **Expected:** In the deny input, Enter triggers handleDeny; Escape hides the form and clears denyReason without calling deny.
  - **Repro:** Open deny form; press Escape (form closes, no call); reopen, type reason, press Enter (deny fires).
- [ ] Approve failure surfaces inline error message severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZEKHTZP872DCENHH1 -->
  - **Expected:** When engine.approve returns falsy, the thrown 'Approval failed — run may have ended' is caught and rendered as red actionError text; the card stays.
  - **Repro:** Mock engine.approve to resolve null; click Approve; verify red error line appears and card remains.
- [ ] Approve/Deny buttons disable during in-flight action severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZG857JQ2Q8PQFYKAC -->
  - **Expected:** While isApproving/isDenying is true, both action buttons are disabled (opacity-50) and show a spinner, preventing double submission.
  - **Repro:** Throttle the approve IPC; click Approve and immediately attempt Deny; confirm buttons are disabled mid-flight.
- [ ] Empty pending tab shows no-pending placeholder severity:P2 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZHEM3SQGX1DNB2ZFR -->
  - **Expected:** With zero pending approvals the Pending tab renders the ShieldCheck empty state with 'approvals.noPending' copy, not an empty list container.
  - **Repro:** Resolve all approvals; view Pending tab; confirm placeholder copy renders.

## Approvals — history, auto-rules, events & persistence

- [ ] History tab loads only resolved approvals severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZAXW66GKD9RR7ETP8 -->
  - **Expected:** Switching to History calls GET /engine/approvals?limit=100 and filters out status==='pending', showing approved/denied/expired cards with StatusBadge and decision reason.
  - **Repro:** Resolve a few approvals; open History tab; verify only non-pending rows with correct badges appear.
- [ ] Auto-approval rule revoke removes row via DELETE severity:P1 scope:activity-approvals,integrations
  <!-- obelisk:id=01KTAARQPZ3QBXDMQSZ45TQR3J -->
  - **Expected:** On Auto tab, clicking Revoke calls DELETE /engine/auto-approvals/{id}; on ok the rule is filtered out of state and the revoking spinner clears.
  - **Repro:** Create an auto-approval rule via chat; open Auto tab; click Revoke; verify row disappears.
- [ ] Approval events auto-refresh pending list severity:P1 scope:activity-approvals,routines
  <!-- obelisk:id=01KTAARQPZC18VHK46XWA70VRZ -->
  - **Expected:** An onAnyEvent of type approval_requested/granted/denied triggers ApprovalContext.refresh(), updating the pending list without manual reload.
  - **Repro:** With Approvals open, trigger a new approval from a routine; confirm the new card appears within a tick.
- [ ] History tab live-refreshes on grant/deny events severity:P2 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZGT7SG07A2J3K9P5Y -->
  - **Expected:** While the History tab is active, an approval_granted/denied event reloads history; events received on other tabs do not reload it.
  - **Repro:** Open History tab; resolve an approval elsewhere; verify new history row appears; repeat on Pending tab (no reload).
- [ ] Window focus re-syncs pending after missed event severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZAJ4AMF9JCGVNG1FH -->
  - **Expected:** Returning focus to the window calls refresh(), self-healing the badge if an approval_requested IPC was missed while backgrounded.
  - **Repro:** Background Cerebro; create an approval via Telegram-driven chat; refocus window; confirm badge/count corrects itself.
- [ ] Concurrent refresh calls are debounced not stacked severity:P1 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZ6GY9G344SYAQPZBN -->
  - **Expected:** When event listener and manual refresh race, refreshInFlight gates the second call and refreshQueued drains exactly once via queueMicrotask, yielding a single trailing fetch.
  - **Repro:** Fire onAnyEvent and refresh() in the same tick; verify only two /engine/approvals requests max (one in-flight, one queued).
- [ ] Pending approvals persist across renderer reload severity:P0 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZS7DARPGKPZ233DM7 -->
  - **Expected:** After reloading the window, ApprovalProvider's initial refresh re-fetches pending approvals from the backend so the badge and list repopulate.
  - **Repro:** With pending approvals present, Cmd+R reload the renderer; confirm pending cards and count return.
- [ ] Malformed payload_json hides parameters section severity:P2 scope:activity-approvals
  <!-- obelisk:id=01KTAARQPZ5GSRFM162NT8ZS4P -->
  - **Expected:** An ApprovalCard whose payload_json is invalid JSON or an empty object renders no Parameters disclosure (ParametersSection returns null) instead of crashing.
  - **Repro:** Seed an approval with payload_json='{bad' and another with '{}'; verify neither shows a Parameters toggle.
