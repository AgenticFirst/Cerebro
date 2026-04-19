/** E2E coverage for the Verified Teams (Beta) feature on the Experts → Messages tab.
 *
 * See `docs/test-plans/teams-feature.md` for the full plan. This suite covers,
 * for the 4 verified teams seeded by `backend/experts/seed.py::VERIFIED_TEAMS`:
 *
 *   U1-U8 — UI / behavior, no LLM required (rail, drawer, flag flips)
 *   T1-T4 — One "most important" live coordination test per team (LLM-backed)
 *
 * Live tests use whatever model Claude Code is configured with. Cerebro's chat
 * runs through the Claude Code subprocess (see CLAUDE.md), so the test trusts
 * the operator's existing Claude Code login and doesn't try to pin a model.
 *
 * Requires a running Cerebro with CDP and a logged-in Claude Code:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  connectToApp,
  dismissModals,
  goToChat,
  goToExperts,
  GENERIC_EXIT_ERROR,
  STRUCTURED_ERROR,
  VERIFIED_TEAMS,
  VERIFIED_EXPERT_NAMES,
  enableTeamsFlag,
  disableTeamsFlag,
  getSetting,
  setSetting,
  gotoMessagesTab,
  selectExpertInMessagesTab,
  sendExpertMessage,
  waitForExpertReply,
  lastAssistantMessage,
  teamRow,
  expertRow,
  openTeamProfileDrawer,
  readLastMessageToolCalls,
  assertAgentInvocations,
  snapshotConversationIds,
  deleteConversationsNotIn,
} from './helpers';

// Live team coordination needs a generous wall-clock budget. Multi-agent runs
// add member-by-member latency on top of single-expert reply time, so we go
// well above the per-expert SLOW_TEST_TIMEOUT of 360s.
const TEAM_TEST_TIMEOUT = 6 * 60_000;

let browser: Browser;
let page: Page;
let preexistingConversationIds: Set<string>;
let originalTeamsFlag: boolean | null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());
  // Snapshot the current flag so we can restore it in afterAll regardless of
  // what the operator had set before running the suite.
  originalTeamsFlag = await getSetting<boolean>(page, 'beta:teams');
  await enableTeamsFlag(page);
  preexistingConversationIds = await snapshotConversationIds(page);
});

test.afterAll(async () => {
  try {
    await deleteConversationsNotIn(page, preexistingConversationIds);
  } catch {
    /* noop */
  }
  // Restore the flag to whatever it was before the suite started.
  try {
    if (originalTeamsFlag === null) {
      await setSetting(page, 'beta:teams', false);
    } else {
      await setSetting(page, 'beta:teams', originalTeamsFlag);
    }
  } catch {
    /* noop */
  }
  await browser?.close();
});

test.beforeEach(async () => {
  await dismissModals(page);
  await goToExperts(page);
  await gotoMessagesTab(page);
});

test.afterEach(async () => {
  try {
    await dismissModals(page);
  } catch {
    /* noop */
  }
});

// ────────────────────────────────────────────────────────────────
// U1 — Beta flag off hides teams everywhere
// ────────────────────────────────────────────────────────────────

test('U1 — beta:teams off hides every team from the rail', async () => {
  await disableTeamsFlag(page);
  await goToExperts(page);
  await gotoMessagesTab(page);

  // Groups header must not render.
  const groupsHeader = page.locator('text=/^Groups$/');
  await expect(
    await groupsHeader.count(),
    'Groups section header must not appear when flag is off',
  ).toBe(0);

  // Every team row must be absent.
  for (const team of VERIFIED_TEAMS) {
    const row = teamRow(page, team.name);
    await expect(
      await row.count(),
      `team ${team.slug} must not render with flag off`,
    ).toBe(0);
  }

  // Re-enable for the rest of the suite.
  await enableTeamsFlag(page);
  await goToExperts(page);
  await gotoMessagesTab(page);
});

// ────────────────────────────────────────────────────────────────
// U2 — Groups section shows all 4 teams when flag is on
// ────────────────────────────────────────────────────────────────

test('U2 — Groups section renders all 4 teams with verified badges', async () => {
  // Groups header must render.
  await expect(page.locator('text=/^Groups$/').first()).toBeVisible({ timeout: 5_000 });

  for (const team of VERIFIED_TEAMS) {
    const row = teamRow(page, team.name);
    await expect(row, `team row for ${team.slug}`).toBeVisible({ timeout: 5_000 });
    // Verified badge (lucide-badge-check svg).
    expect(
      await row.locator('svg.lucide-badge-check').count(),
      `verified badge for ${team.slug}`,
    ).toBeGreaterThanOrEqual(1);
  }
});

// ────────────────────────────────────────────────────────────────
// U3 — Selecting a team shows Group + strategy chips in header
// ────────────────────────────────────────────────────────────────

test('U3 — team header shows Group label + strategy chip', async () => {
  for (const team of VERIFIED_TEAMS) {
    await selectExpertInMessagesTab(page, team.name);
    // ThreadHeader renders a "Group" pill and a strategy pill (Sequential/Parallel/Auto).
    // Scope to the header strip so we don't match the sidebar-rail counterpart.
    const header = page.locator('div.sticky.top-0').first();
    await expect(header.locator('text=/^Group$/').first(), `Group chip for ${team.slug}`).toBeVisible({
      timeout: 5_000,
    });
    const strategyText = team.strategy === 'parallel' ? 'Parallel' : 'Sequential';
    await expect(
      header.locator(`text=/^${strategyText}$/`).first(),
      `${strategyText} chip for ${team.slug}`,
    ).toBeVisible({ timeout: 5_000 });
  }
});

// ────────────────────────────────────────────────────────────────
// U4 — Profile drawer renders members, strategy, coordinator
// ────────────────────────────────────────────────────────────────

test('U4 — team profile drawer renders members + strategy + coordinator', async () => {
  // Use Market Research team — sequential, 3 members, deterministic ordering.
  const team = VERIFIED_TEAMS.find((t) => t.slug === 'market-research-and-business-plan')!;
  const drawer = await openTeamProfileDrawer(page, team.name);

  // Strategy header + chip.
  await expect(drawer.locator('text=/^Strategy$/').first()).toBeVisible();
  await expect(drawer.locator('text=/^Sequential$/').first()).toBeVisible();

  // Members section + every member name (display-name from VERIFIED_EXPERT_NAMES).
  await expect(drawer.locator('text=/^Members$/').first()).toBeVisible();
  for (const memberSlug of team.memberSlugs) {
    const meta = VERIFIED_EXPERT_NAMES.find((e) => e.slug === memberSlug);
    expect(meta, `member meta for ${memberSlug}`).toBeTruthy();
    await expect(
      drawer.locator(`text=${meta!.name}`).first(),
      `member ${memberSlug} should appear in drawer`,
    ).toBeVisible();
  }

  // Coordinator section header is collapsible — header always rendered.
  await expect(drawer.locator('text=/Coordinator instructions/i').first()).toBeVisible();

  // Verified lock chip (cyan locked badge text, English copy).
  await expect(drawer.locator('text=/Verified.*Cerebro/i').first()).toBeVisible();
});

// ────────────────────────────────────────────────────────────────
// U5 — Team composer placeholder differs from expert default
// ────────────────────────────────────────────────────────────────

test('U5 — team thread composer uses team-specific placeholder', async () => {
  const team = VERIFIED_TEAMS[0];
  await selectExpertInMessagesTab(page, team.name);
  // ExpertThreadView passes the team placeholder when expert.type === 'team'.
  const teamComposer = page.locator('textarea[placeholder*="Message the team" i]').last();
  await expect(teamComposer, `team composer placeholder for ${team.slug}`).toBeVisible({
    timeout: 5_000,
  });
});

// ────────────────────────────────────────────────────────────────
// U6 — Member row in drawer routes to the member's expert profile
// ────────────────────────────────────────────────────────────────

test('U6 — clicking a member row in the team drawer opens that member', async () => {
  const team = VERIFIED_TEAMS.find((t) => t.slug === 'market-research-and-business-plan')!;
  const drawer = await openTeamProfileDrawer(page, team.name);

  const firstMemberSlug = team.memberSlugs[0]; // data-analyst
  const firstMember = VERIFIED_EXPERT_NAMES.find((e) => e.slug === firstMemberSlug)!;
  // Click the member row inside the drawer.
  await drawer.locator(`button:has-text("${firstMember.name}")`).first().click();

  // The drawer should re-target the clicked member; verify the member name is
  // still visible in the drawer (now as the heading) and the team's coordinator
  // section is gone (drawer flipped from team-mode to expert-mode).
  await expect(page.locator(`h2:has-text("${firstMember.name}")`).first()).toBeVisible({
    timeout: 5_000,
  });
  // Coordinator section is team-only — its absence proves we're now on the
  // member's expert profile rather than still on the team's profile.
  expect(
    await page.locator('text=/Coordinator instructions/i').count(),
    'member profile must not show team coordinator section',
  ).toBe(0);
});

// ────────────────────────────────────────────────────────────────
// U7 — Default selection respects flag (regression for race condition)
// ────────────────────────────────────────────────────────────────

test('U7 — flag-off mount selects an expert, never a hidden team', async () => {
  await disableTeamsFlag(page);
  await goToExperts(page);
  await gotoMessagesTab(page);

  // The rail must have a selected (highlighted) row that is NOT one of the
  // teams. Easiest robust check: every team row is absent (covered by U1) and
  // the ThreadHeader must show some expert name plus the expert's domain
  // chip — never the "Group" chip.
  const header = page.locator('div.sticky.top-0').first();
  await expect(header).toBeVisible({ timeout: 5_000 });
  expect(
    await header.locator('text=/^Group$/').count(),
    'Group chip must not appear when flag is off',
  ).toBe(0);

  // Restore flag.
  await enableTeamsFlag(page);
  await goToExperts(page);
  await gotoMessagesTab(page);
});

// ────────────────────────────────────────────────────────────────
// U8 — Flag flip cleans up an open team thread (reactive filter safety)
// ────────────────────────────────────────────────────────────────

test('U8 — flipping flag off while a team is selected re-selects an expert', async () => {
  // Open a team, then flip flag off — selection should bounce to an expert.
  const team = VERIFIED_TEAMS[0];
  await selectExpertInMessagesTab(page, team.name);

  // Flip flag off (reload re-runs FeatureFlagsContext + MessagesTab effects).
  await disableTeamsFlag(page);
  await goToExperts(page);
  await gotoMessagesTab(page);

  // Header must not be the team anymore — no Group chip.
  const header = page.locator('div.sticky.top-0').first();
  expect(
    await header.locator('text=/^Group$/').count(),
    'after flag flip, header must show an expert (no Group chip)',
  ).toBe(0);

  // Re-enable for the live tests.
  await enableTeamsFlag(page);
  await goToExperts(page);
  await gotoMessagesTab(page);
});

// ────────────────────────────────────────────────────────────────
// Live team coordination tests (T1–T4) — LLM required, slow
// ────────────────────────────────────────────────────────────────

interface LiveTeamCase {
  slug: string;
  /** Prompt kernel — small, deterministic, designed to force coordination. */
  prompt: string;
  /** Markers the synthesized reply must contain (regex set; ALL must match). */
  contentMarkers: RegExp[];
}

const LIVE_TEAM_CASES: LiveTeamCase[] = [
  {
    slug: 'market-research-and-business-plan',
    prompt:
      'Produce a 1-paragraph business plan for a fake app called "dayplan" that turns calendar events into daily summaries. Keep the total response under 300 words. Cover: the problem, the ideal customer profile, the success metric, and a one-line MVP roadmap.',
    // Markers are intentionally semantic — they prove the reply is about THIS
    // app (Dayplan / calendar→summary), not lexical assertions on specific
    // words. The coordination signal is the load-bearing check; these only
    // catch egregious off-topic / empty replies.
    contentMarkers: [
      /(calendar|schedule|event|meeting)/i,
      /(summary|summari[sz]e|digest|briefing|recap)/i,
      /(business|product|market|customer|user|metric|MVP|roadmap|plan)/i,
    ],
  },
  {
    slug: 'app-build-team',
    prompt:
      'Give a 1-paragraph architecture sketch and a 5-line directory tree for a hello-world TODO app (SQLite + FastAPI + React). No code, no implementation. Keep under 250 words.',
    contentMarkers: [
      /(SQLite|FastAPI|React|python|javascript|typescript)/i,
      /(TODO|task|item)/i,
      /(architect|component|module|directory|file|backend|frontend|api)/i,
    ],
  },
  {
    slug: 'product-launch-team',
    prompt:
      'Draft a 1-paragraph launch brief for a feature called "smart-inbox". Include: a one-liner positioning, a single launch channel, one anticipated FAQ, and one risk to watch.',
    contentMarkers: [
      /(smart[- ]?inbox|inbox)/i,
      /(launch|positioning|channel|message|announce|post|email|blog)/i,
      /(FAQ|risk|question|concern|watch|user|customer)/i,
    ],
  },
  {
    slug: 'code-review-team',
    prompt:
      'Review this 3-line diff for problems. Focus on security, correctness, and style. Reply with a 1-paragraph review that flags every must-fix issue.\n\n```python\ndef get_user(email):\n    query = f"SELECT * FROM users WHERE email=\'{email}\'"\n    return db.execute(query).fetchone()\n```',
    // The SQL-injection signal must be present — that's the only must-fix
    // bug in the diff and any honest review must call it out. Other markers
    // are loose semantic checks.
    contentMarkers: [
      /(injection|sqli|parameteri[sz]ed|sanitiz|prepared|escap|bind|placeholder)/i,
      /(security|vulnerab|risk|concern|fix|issue)/i,
      /(SQL|query|database|email)/i,
    ],
  },
];

// Sanity — one live case per verified team.
test('live team coverage matches the verified-teams roster', () => {
  for (const team of VERIFIED_TEAMS) {
    const has = LIVE_TEAM_CASES.some((c) => c.slug === team.slug);
    expect(has, `expected a live coordination case for ${team.slug}`).toBe(true);
  }
  expect(LIVE_TEAM_CASES.length).toBe(VERIFIED_TEAMS.length);
});

for (const kase of LIVE_TEAM_CASES) {
  const team = VERIFIED_TEAMS.find((t) => t.slug === kase.slug)!;

  test(`${kase.slug} — T live coordination + content synthesis`, async () => {
    test.setTimeout(TEAM_TEST_TIMEOUT);

    await selectExpertInMessagesTab(page, team.name);
    // Snapshot conversation IDs *before* sending. A team chat must produce
    // exactly ONE new conversation regardless of how many members participate.
    // Catches the regression where a team fans out into per-member threads
    // instead of staying as a single group conversation.
    const beforeIds = await snapshotConversationIds(page);
    await sendExpertMessage(page, kase.prompt);

    const reply = await waitForExpertReply(page, { timeoutMs: TEAM_TEST_TIMEOUT - 30_000 });
    expect(reply, `live reply for ${kase.slug} must not be the generic exit error`).not.toMatch(
      GENERIC_EXIT_ERROR,
    );
    expect(reply, `live reply for ${kase.slug} must not be a structured error`).not.toMatch(
      STRUCTURED_ERROR,
    );
    expect(
      reply.length,
      `live reply for ${kase.slug} should be a real synthesis, not a stub`,
    ).toBeGreaterThan(120);

    // Coordination signal FIRST — this is the load-bearing assertion. If the
    // coordinator skips delegation and answers directly, we want the test to
    // fail with a "missing Agent invocations" diagnostic, not a content-marker
    // miss that obscures the real product bug. Every team member must have
    // been invoked via the Agent tool.
    const toolCalls = await readLastMessageToolCalls(page);
    assertAgentInvocations(toolCalls, team.memberSlugs);

    // Content signal — every required marker must appear in the synthesized
    // reply. These markers are loose (concept-level) on purpose; they catch
    // gross synthesis failures (empty / off-topic / single-member output)
    // without being brittle to harmless wording variation.
    for (const marker of kase.contentMarkers) {
      expect(
        reply,
        `live reply for ${kase.slug} should contain marker ${marker}`,
      ).toMatch(marker);
    }

    // Single-conversation invariant — a team chat is one group conversation,
    // not one-per-member. Assert exactly one new conversation appeared.
    const afterIds = await snapshotConversationIds(page);
    const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
    expect(
      newIds.length,
      `team chat for ${kase.slug} must create exactly ONE conversation; saw ${newIds.length}`,
    ).toBe(1);
  });
}

// ────────────────────────────────────────────────────────────────
// T5 — Canonical Claude Code agent-teams use-case
//      from https://code.claude.com/docs/en/agent-teams#use-case-examples
//
// The Claude Code docs describe agent-teams via this exact prompt: a CLI
// design ask that wants UX + technical + devil's-advocate perspectives.
// Cerebro's Verified Teams ARE Claude Code agent-teams (subagent .md files
// invoked via the `Agent` tool), so this prompt should work end-to-end on
// the App Build Team — its members map naturally onto the three angles
// (product-designer = UX, full-stack-engineer = architecture, security-
// engineer = devil's-advocate).
// ────────────────────────────────────────────────────────────────

test('T5 — App Build Team handles the canonical Claude Code agent-teams CLI prompt', async () => {
  test.setTimeout(TEAM_TEST_TIMEOUT);

  const team = VERIFIED_TEAMS.find((t) => t.slug === 'app-build-team')!;
  await selectExpertInMessagesTab(page, team.name);

  const prompt =
    "I'm designing a CLI tool that helps developers track TODO comments " +
    'across their codebase. Explore this from different angles: one ' +
    'teammate on UX, one on technical architecture, one playing devil\'s ' +
    "advocate. Keep total output under 400 words.";

  const beforeIds = await snapshotConversationIds(page);
  await sendExpertMessage(page, prompt);

  const reply = await waitForExpertReply(page, { timeoutMs: TEAM_TEST_TIMEOUT - 30_000 });
  expect(reply, 'reply must not be the generic exit error').not.toMatch(GENERIC_EXIT_ERROR);
  expect(reply, 'reply must not be a structured error').not.toMatch(STRUCTURED_ERROR);
  expect(reply.length, 'reply should be a real synthesis').toBeGreaterThan(150);

  // Coordination signal — the prompt explicitly asks for three perspectives.
  // The team coordinator must engage at least three distinct member agents
  // (which of the five members it picks is up to the coordinator's judgment;
  // we don't pin to a specific subset because the prompt is small enough
  // that picking 3 of 5 is reasonable).
  const toolCalls = await readLastMessageToolCalls(page);
  const distinctAgentSubagents = new Set(
    toolCalls
      .filter((tc) => tc.name === 'Agent' && tc.subagentType)
      .map((tc) => tc.subagentType as string),
  );
  expect(
    distinctAgentSubagents.size,
    `App Build Team must engage ≥3 distinct member agents for the multi-` +
      `perspective ask. Saw: ${distinctAgentSubagents.size} distinct ` +
      `subagents [${[...distinctAgentSubagents].join(', ') || 'none'}]`,
  ).toBeGreaterThanOrEqual(3);

  // Content signal — every named angle from the user prompt must appear in
  // the synthesized reply. If the team only addresses one angle, the
  // multi-perspective contract is broken regardless of how many members ran.
  expect(reply, 'reply must address the UX angle').toMatch(
    /(UX|user[- ]experience|usability|user[- ]flow|interface|interaction|workflow)/i,
  );
  expect(reply, 'reply must address the technical/architecture angle').toMatch(
    /(architect|technical|implement|library|framework|module|system|stack|component)/i,
  );
  expect(reply, "reply must address the devil's-advocate / risk angle").toMatch(
    /(devil|advocat|risk|concern|drawback|downside|caveat|trade[- ]?off|skeptic|push[- ]back|limitation|why not|alternative)/i,
  );

  // Single-conversation invariant — the team chat is one group conversation,
  // not one-per-member.
  const afterIds = await snapshotConversationIds(page);
  const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
  expect(
    newIds.length,
    `App Build Team chat must create exactly ONE conversation; saw ${newIds.length}`,
  ).toBe(1);
});

// ────────────────────────────────────────────────────────────────
// CT1 — Sanity: every team's expert row in the rail is also listed under
// Direct Messages (i.e., teams don't shadow their own member experts).
// ────────────────────────────────────────────────────────────────

test('CT1 — team members are also listed as standalone experts', async () => {
  for (const team of VERIFIED_TEAMS) {
    for (const memberSlug of team.memberSlugs) {
      const meta = VERIFIED_EXPERT_NAMES.find((e) => e.slug === memberSlug)!;
      const row = expertRow(page, meta.name);
      await expect(
        row,
        `member ${memberSlug} of team ${team.slug} should still appear in the experts rail`,
      ).toBeVisible({ timeout: 5_000 });
    }
  }
});
