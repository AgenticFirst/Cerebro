/** E2E coverage for the **Create Expert** workflow.
 *
 * The bug this suite exists to catch:
 *
 *   User (in Spanish): "Puedes crearme un agente que este especializado en
 *   redes sociales? especificamente en TikTok"
 *   Cerebro: "Error: Claude Code exited unexpectedly (code 1) — agent
 *   'cerebro' in /Users/clover/Library/Application Support/Cerebro"
 *
 * That message comes from `stream-adapter.ts` when the `cerebro` subprocess
 * exits non-zero with empty stderr AND empty stdout. It is *never* acceptable
 * in a user-facing chat reply: a healthy failure produces a structured error
 * (auth, rate limit, max-turns, expert-not-found). A silent exit means the
 * Cerebro agent died before we could see why.
 *
 * Three complementary paths are covered:
 *   1. **Skill-driven (LLM) path** — send the exact Spanish user message and
 *      assert Cerebro either asks a clarifier or invokes `create-expert`,
 *      never the generic exit error.
 *   2. **Direct-script path** (fast, deterministic) — POST `/experts` with a
 *      TikTok expert and assert the renderer picks it up, the on-disk agent
 *      file materializes, and the new expert is messageable.
 *   3. **Post-creation chat race** — create a brand-new user-source expert
 *      and DM it immediately, mirroring `expert-chat.spec.ts` but against the
 *      user-source code path (not the seeded verified experts).
 *
 * Requires a running Cerebro instance with CDP enabled:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  connectToApp,
  dismissModals,
  goToChat,
  goToExperts,
  selectExpertInMessagesTab,
  sendExpertMessage,
  waitForExpertReply,
  lastAssistantMessage,
  GENERIC_EXIT_ERROR,
  STRUCTURED_ERROR,
} from './helpers';

const TEST_EXPERT_PREFIX = 'E2E Create ';

let browser: Browser;
let page: Page;

// ─── Renderer-side helpers (minimal, duplicate-free) ────────────────────────

async function createExpertViaApi(
  page: Page,
  body: { name: string; description: string; system_prompt?: string; domain?: string },
): Promise<string> {
  const result = await page.evaluate(async (b) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string; body?: unknown }) => Promise<{
          ok: boolean;
          data: unknown;
          status?: number;
        }>;
      };
    }).cerebro.invoke;
    return invoke({ method: 'POST', path: '/experts', body: b });
  }, body);
  if (!result.ok) {
    throw new Error(`POST /experts failed: ${JSON.stringify(result)}`);
  }
  return (result.data as { id: string }).id;
}

async function listExperts(
  page: Page,
): Promise<Array<{ id: string; name: string; slug: string; source: string }>> {
  const res = await page.evaluate(async () => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    return invoke({ method: 'GET', path: '/experts' });
  });
  if (!res.ok) return [];
  return (res.data as { experts: Array<{ id: string; name: string; slug: string; source: string }> }).experts || [];
}

async function deleteExpert(page: Page, id: string): Promise<void> {
  await page.evaluate(async (expertId) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<unknown> };
    }).cerebro.invoke;
    await invoke({ method: 'DELETE', path: `/experts/${expertId}` }).catch(() => {});
  }, id);
}

async function cleanupTestExperts(page: Page): Promise<void> {
  const all = await listExperts(page);
  for (const e of all) {
    if (e.name.startsWith(TEST_EXPERT_PREFIX) || /tiktok|redes sociales/i.test(e.name)) {
      await deleteExpert(page, e.id);
    }
  }
}

/** Poll `/experts` until `predicate` matches or timeout. Returns the match. */
async function waitForExpert(
  page: Page,
  predicate: (e: { name: string; slug: string; source: string }) => boolean,
  timeoutMs = 30_000,
): Promise<{ id: string; name: string; slug: string; source: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = await listExperts(page);
    const match = all.find(predicate);
    if (match) return match;
    await page.waitForTimeout(500);
  }
  return null;
}

/** Start a fresh Cerebro chat conversation. The Chat screen is labeled
 *  "Cerebro" in the sidebar (not "Chat") — see helpers.ts:goToChat. */
async function startNewChat(page: Page): Promise<void> {
  const newChatBtn = page.locator('button').filter({ hasText: /New chat/i }).first();
  if ((await newChatBtn.count()) > 0) {
    await newChatBtn.click({ force: true }).catch(() => {});
  }
}

async function sendCerebroMessage(page: Page, text: string): Promise<void> {
  const ta = page.locator('textarea[placeholder*="message" i]').first();
  await ta.click();
  await ta.fill(text);
  if (((await ta.inputValue()) || '').trim().length === 0) {
    await ta.pressSequentially(text, { delay: 10 });
  }
  await ta.press('Enter');
}

/** Wait for a Cerebro assistant reply and return its rendered text. Polls the
 *  DOM so we can break out early if the generic exit line appears (fail fast). */
async function waitForCerebroReply(page: Page, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (GENERIC_EXIT_ERROR.test(bodyText)) return bodyText;
    const msg = lastAssistantMessage(page);
    if ((await msg.count()) > 0) {
      const busy =
        (await msg.locator('text=/Working on it/i').count()) > 0 ||
        (await msg.locator('text=/is thinking/i').count()) > 0;
      const prose = msg.locator('.prose').first();
      if (!busy && (await prose.count()) > 0) {
        const proseText = (await prose.innerText().catch(() => '')).trim();
        if (proseText.length > 0) return proseText;
      }
    }
    await page.waitForTimeout(500);
  }
  return (await page.locator('body').innerText().catch(() => ''));
}

// ─── Setup / teardown ───────────────────────────────────────────────────────

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());
  await cleanupTestExperts(page);
});

test.afterAll(async () => {
  try { await cleanupTestExperts(page); } catch { /* noop */ }
  await browser?.close();
});

test.beforeEach(async () => {
  await dismissModals(page);
});

test.afterEach(async () => {
  try { await dismissModals(page); } catch { /* noop */ }
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test('create-expert — direct API path: POST /experts materializes a messageable expert', async () => {
  // Fast, LLM-free contract: the creation → installer → renderer pipeline
  // must produce a live expert the user can message without any manual wait.
  const name = `${TEST_EXPERT_PREFIX}TikTok ${Date.now()}`;
  const id = await createExpertViaApi(page, {
    name,
    description: 'Helps create, plan, and analyze TikTok content.',
    system_prompt: 'You are a TikTok content strategist. Reply in at most two short sentences.',
    domain: 'content',
  });

  try {
    // The expert row should appear in `/experts` *immediately* after the POST
    // (regression test for the backend race guarded by
    // backend/tests/test_experts_api.py::test_create_then_get_returns_same_row_immediately).
    const found = await waitForExpert(page, (e) => e.id === id, 5_000);
    expect(found, 'new expert must be visible in GET /experts right after POST').not.toBeNull();
    expect(found!.source, 'user-created expert must have source=user').toBe('user');

    // The Experts → Messages tab must surface the pill for this new expert
    // without requiring a reload.
    await goToExperts(page);
    await selectExpertInMessagesTab(page, name);

    // Round-trip a short message. The point isn't to grade the model's
    // answer — it's to assert the agent file is on disk and the subprocess
    // spawns cleanly.
    await sendExpertMessage(page, 'Say hi in one short sentence.');
    const reply = await waitForExpertReply(page, { timeoutMs: 120_000 });
    expect(
      reply,
      `Fresh expert must not hit the generic-exit fallback.\n\nReply:\n${reply}`,
    ).not.toMatch(GENERIC_EXIT_ERROR);
  } finally {
    await deleteExpert(page, id);
  }
});

test('create-expert — skill path: Cerebro handles the TikTok request without a silent crash', async () => {
  // Exact reproduction of the production report. We don't care if Cerebro
  // asks one clarifier first or invokes `create-expert` outright — either is
  // a healthy outcome. The *only* unacceptable outcome is the generic
  // "Claude Code exited unexpectedly" line.
  await goToChat(page);
  await startNewChat(page);

  const userMsg =
    'Puedes crearme un agente que este especializado en redes sociales? especificamente en TikTok';
  await sendCerebroMessage(page, userMsg);

  const reply = await waitForCerebroReply(page);

  // Primary assertion: never the generic silent-crash line.
  expect(
    reply,
    `Cerebro's first reply must not be the generic-exit line. ` +
      `If stderr/stdout were empty on crash, fix stream-adapter.ts so we ` +
      `surface a structured error instead.\n\nReply:\n${reply}`,
  ).not.toMatch(GENERIC_EXIT_ERROR);

  // Secondary assertion: if an error *did* happen, it must be structured
  // (tells the user what to fix). If it's not an error, the reply should
  // mention the topic so we know the LLM actually engaged.
  const isStructuredError = STRUCTURED_ERROR.test(reply);
  const mentionsTopic = /tiktok|redes sociales|social|expert|agente|crear/i.test(reply);
  expect(
    isStructuredError || mentionsTopic,
    `Reply must be either a structured error or an on-topic response.\n\nReply:\n${reply}`,
  ).toBeTruthy();
});

test('create-expert — chat race: send to a brand-new user-source expert with no wait', async () => {
  // Complements `expert-chat.spec.ts` (which covers the same race but uses
  // fabricated test experts with `domain: engineering|creative`). This test
  // uses `domain: content` — a user-created content expert — to cover a
  // different auto-skill-assignment code path in the installer.
  const name = `${TEST_EXPERT_PREFIX}Race ${Date.now()}`;
  const id = await createExpertViaApi(page, {
    name,
    description: 'Race-regression expert (content domain).',
    system_prompt: 'You are a content strategist. Reply in one short sentence.',
    domain: 'content',
  });

  try {
    // Do NOT wait — go straight into messaging. The installer's
    // fire-and-forget materialization is the race under test.
    await goToExperts(page);
    await selectExpertInMessagesTab(page, name);
    await sendExpertMessage(page, 'Hey!');

    const reply = await waitForExpertReply(page, { timeoutMs: 120_000 });
    expect(
      reply,
      `Zero-wait create+DM must never surface the generic exit line.\n\nReply:\n${reply}`,
    ).not.toMatch(GENERIC_EXIT_ERROR);
  } finally {
    await deleteExpert(page, id);
  }
});
