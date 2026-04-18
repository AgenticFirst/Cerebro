/** E2E coverage for the Expert chat flow.
 *
 * The bug: opening a freshly-created expert's chat and sending a message produces
 * the generic assistant reply `"Error: Claude Code exited unexpectedly (code 1)"`.
 * Root cause is the race between `ExpertContext.syncExpert` (fire-and-forget
 * on-disk materialization of `<dataDir>/.claude/agents/<slug>.md`) and
 * `AgentRuntime.startRun` spawning `claude -p --agent <slug>` before the file
 * exists.
 *
 * This suite exercises:
 *   1. Happy path — creating an expert then chatting with it should either return
 *      a real reply or a *structured* error, never the generic exit line.
 *   2. Race regression — create the expert and send immediately, without waiting
 *      for `EXPERTS_CHANGED` IPC. Same assertion.
 *
 * Requires a running Cerebro instance with CDP enabled:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { connectToApp, dismissModals } from './helpers';

// Matches the exact generic error produced by stream-adapter.ts:149 when the
// subprocess exits non-zero with empty stderr. This is the string we never
// want to see in a user-facing chat reply after the fix lands.
const GENERIC_EXIT_ERROR = /Claude Code exited unexpectedly/i;

// Structured error substrings — any of these is *acceptable* in CI where there's
// no real API key, since they tell the user why the chat couldn't start.
const STRUCTURED_ERROR = /Authentication error|Rate limited|maximum number of turns|Expert not installed|not.*found|ENOENT/i;

const TEST_EXPERT_PREFIX = 'E2E Expert ';

let browser: Browser;
let page: Page;

async function createExpertViaInvoke(
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
    const r = await invoke({ method: 'POST', path: '/experts', body: b });
    return r;
  }, body);
  if (!result.ok) {
    throw new Error(`POST /experts failed: ${JSON.stringify(result)}`);
  }
  return (result.data as { id: string }).id;
}

async function deleteExpertViaInvoke(page: Page, id: string): Promise<void> {
  await page.evaluate(async (expertId) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<unknown> };
    }).cerebro.invoke;
    await invoke({ method: 'DELETE', path: `/experts/${expertId}` }).catch(() => {});
  }, id);
}

async function cleanupTestExperts(page: Page): Promise<void> {
  await page.evaluate(async (prefix) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }>;
      };
    }).cerebro.invoke;
    const list = await invoke({ method: 'GET', path: '/experts' });
    if (!list.ok) return;
    const body = list.data as { experts: Array<{ id: string; name: string }> };
    for (const e of body.experts || []) {
      if (e.name.startsWith(prefix)) {
        await invoke({ method: 'DELETE', path: `/experts/${e.id}` }).catch(() => {});
      }
    }
  }, TEST_EXPERT_PREFIX);
}

/** Go to the Chat screen via sidebar. */
async function goToChat(page: Page): Promise<void> {
  await dismissModals(page);
  // Sidebar nav uses i18n labels; match by the visible text "Chat" inside <nav>.
  const chatBtn = page.locator('nav button').filter({ hasText: /^Chat$/ }).first();
  await chatBtn.click({ force: true });
  // ChatInput textarea placeholder is the i18n string "Send a message..."
  await page.waitForSelector('textarea[placeholder*="message" i]', { timeout: 10_000 });
}

/** Start a brand new conversation by clicking "New chat" in the sidebar. */
async function startNewChat(page: Page): Promise<void> {
  const newChatBtn = page.locator('button').filter({ hasText: /New chat/i }).first();
  if ((await newChatBtn.count()) > 0) {
    await newChatBtn.click({ force: true }).catch(() => {});
  }
}

/** Click the expert pill by visible name in the ExpertTray. */
async function selectExpert(page: Page, expertName: string): Promise<void> {
  // The tray lives just above the ChatInput; pills are <button> with the expert
  // name as their text. Use a tight ancestor filter to avoid matching arbitrary
  // buttons containing the word elsewhere on the page.
  const pill = page.locator('button').filter({ hasText: expertName }).first();
  await expect(pill).toBeVisible({ timeout: 10_000 });
  await pill.click();
}

/** Fill and send a message via the ChatInput composer. */
async function sendChatMessage(page: Page, text: string): Promise<void> {
  const ta = page.locator('textarea[placeholder*="message" i]').first();
  await ta.click();
  await ta.fill(text);
  await ta.press('Enter');
}

/** Wait for an assistant message to finalize (non-streaming). Returns its text. */
async function waitForAssistantReply(page: Page, timeoutMs = 90_000): Promise<string> {
  // ChatMessage elements aren't tagged; fall back to polling the DOM for text
  // that either contains the user's message echo followed by assistant content,
  // or contains any of our expected error/success substrings.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (GENERIC_EXIT_ERROR.test(bodyText)) return bodyText; // capture failure fast
    if (STRUCTURED_ERROR.test(bodyText)) return bodyText;
    // Heuristic: the assistant reply is the last block after our user "Hey!" echo.
    // If body contains anything beyond just "Hey!", assume we have a reply.
    if (/Hey!/.test(bodyText)) {
      // Give the renderer a moment to flush a terminal message.
      await page.waitForTimeout(1000);
      const after = await page.locator('body').innerText().catch(() => '');
      if (after.length > bodyText.length || /\n/.test(after.split('Hey!')[1] || '')) {
        return after;
      }
    }
    await page.waitForTimeout(500);
  }
  return await page.locator('body').innerText().catch(() => '');
}

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

test('expert chat — happy path: reply is not the generic exit error', async () => {
  const name = `${TEST_EXPERT_PREFIX}Design ${Date.now()}`;
  const expertId = await createExpertViaInvoke(page, {
    name,
    description: 'Helps with design decisions.',
    system_prompt: 'You are a design expert. Keep replies short.',
    domain: 'creative',
  });

  try {
    // Give the fire-and-forget materialization a best-effort window (the point
    // of the second test is to *remove* this margin and still pass).
    await page.waitForTimeout(1500);

    await goToChat(page);
    await startNewChat(page);
    await selectExpert(page, name);
    await sendChatMessage(page, 'Hey!');

    const replyText = await waitForAssistantReply(page);
    expect(replyText, `Assistant reply must not contain the generic exit error.\n\nDOM text:\n${replyText}`)
      .not.toMatch(GENERIC_EXIT_ERROR);
  } finally {
    await deleteExpertViaInvoke(page, expertId);
  }
});

test('expert chat — race: create + send immediately still avoids generic exit error', async () => {
  // This is the exact race that produces the live bug — no wait between
  // `/experts` POST and the first chat send.
  const name = `${TEST_EXPERT_PREFIX}Race ${Date.now()}`;
  const expertId = await createExpertViaInvoke(page, {
    name,
    description: 'Race-regression expert.',
    system_prompt: 'You are a helpful expert. Keep replies short.',
    domain: 'engineering',
  });

  try {
    await goToChat(page);
    await startNewChat(page);
    // Do NOT wait for EXPERTS_CHANGED — the ExpertTray polls on its own, so
    // the pill may or may not exist yet. Poll for the pill with a short cap.
    const pill = page.locator('button').filter({ hasText: name }).first();
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();

    await sendChatMessage(page, 'Hey!');

    const replyText = await waitForAssistantReply(page);
    expect(replyText, `Race-path reply must not contain the generic exit error.\n\nDOM text:\n${replyText}`)
      .not.toMatch(GENERIC_EXIT_ERROR);
  } finally {
    await deleteExpertViaInvoke(page, expertId);
  }
});
