/** E2E coverage for sidebar navigation. Every primary nav item must route to
 *  its own screen — no silent bounces. These tests assert EXPECTED behavior
 *  (the screen we clicked actually renders), not implementation details.
 *
 *  Background on the bug that motivated this file: clicking "Experts" routed
 *  the user to the Cerebro chat screen. `ChatContext.setActiveConversation`
 *  had a side-effect that forced `activeScreen='chat'` whenever a non-null id
 *  was set, and `ExpertThreadView`'s mount effect auto-binds the most recent
 *  thread for the selected expert — so any expert with past chats triggered
 *  the bounce. See the last test in this file for the dedicated regression.
 *
 *  Requires a running Cerebro instance with CDP enabled:
 *    CEREBRO_E2E_DEBUG_PORT=9229 npm start
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  connectToApp,
  dismissModals,
  goToChat,
  goToExperts,
} from './helpers';

const TEST_EXPERT_PREFIX = 'E2E Nav ';

let browser: Browser;
let page: Page;

// ── API helpers (scoped to this file — unrelated to expert-chat.spec.ts) ───

async function apiPost<T = unknown>(p: Page, path: string, body: unknown): Promise<T> {
  const res = await p.evaluate(async ({ path, body }) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string; body?: unknown }) => Promise<{
          ok: boolean; status?: number; data: unknown;
        }>;
      };
    }).cerebro.invoke;
    return invoke({ method: 'POST', path, body });
  }, { path, body });
  if (!res.ok) throw new Error(`POST ${path} failed: ${JSON.stringify(res)}`);
  return res.data as T;
}

async function apiDelete(p: Page, path: string): Promise<void> {
  await p.evaluate(async (path) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<unknown> };
    }).cerebro.invoke;
    await invoke({ method: 'DELETE', path }).catch(() => {});
  }, path);
}

async function cleanupTestExperts(p: Page): Promise<void> {
  await p.evaluate(async (prefix) => {
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

function clickNav(p: Page, label: RegExp): Promise<void> {
  return p.locator('nav button').filter({ hasText: label }).first().click({ force: true });
}

/** Landing assertion: the chat screen has a composer textarea AND is NOT the
 *  Experts screen (ExpertThreadView also renders a ChatInput, so textarea
 *  presence alone isn't chat-exclusive — the Experts tab strip's absence is). */
async function expectOnChat(p: Page): Promise<void> {
  await expect(p.locator('textarea[placeholder*="message" i]').first()).toBeVisible({ timeout: 5_000 });
  await expect(p.locator('text=/^Hierarchy$/')).toHaveCount(0);
}

/** Landing assertion: the Experts screen is identified by its tab strip.
 *  These two labels only exist in ExpertsTabs, so their visibility uniquely
 *  identifies the experts screen. */
async function expectOnExperts(p: Page): Promise<void> {
  await expect(p.locator('text=/^Messages$/').first()).toBeVisible({ timeout: 5_000 });
  await expect(p.locator('text=/^Hierarchy$/').first()).toBeVisible({ timeout: 5_000 });
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
  // Baseline every test on the chat screen so we measure the *click*, not a
  // leaked state from a previous test.
  await goToChat(page);
});

test.afterEach(async () => {
  try { await dismissModals(page); } catch { /* noop */ }
});

// ── Primary nav items ─────────────────────────────────────────────

test('sidebar — Cerebro (chat) renders the chat screen', async () => {
  // beforeEach already navigated to chat; just assert the landing.
  await expectOnChat(page);
});

test('sidebar — Experts renders the experts screen (not chat)', async () => {
  await goToExperts(page);
  await expectOnExperts(page);
});

test('sidebar — Tasks renders the tasks screen', async () => {
  await clickNav(page, /^Tasks$/);
  await expect(page.locator('h1:has-text("Tasks")').first()).toBeVisible({ timeout: 5_000 });
  // The composer textarea is only on the chat screen — verify we left it.
  await expect(page.locator('textarea[placeholder*="message" i]')).toHaveCount(0);
});

test('sidebar — Workspaces renders the workspaces screen', async () => {
  await clickNav(page, /^Workspaces$/);
  await expect(page.locator('h1:has-text("Workspaces")').first()).toBeVisible({ timeout: 5_000 });
});

test('sidebar — Routines renders the routines screen', async () => {
  await clickNav(page, /^Routines$/);
  await expect(page.locator('h1:has-text("Routines")').first()).toBeVisible({ timeout: 5_000 });
});

test('sidebar — Activity renders the activity screen', async () => {
  await clickNav(page, /^Activity$/);
  await expect(page.locator('h1:has-text("Activity")').first()).toBeVisible({ timeout: 5_000 });
});

test('sidebar — Approvals renders the approvals screen', async () => {
  await clickNav(page, /^Approvals$/);
  await expect(page.locator('h1:has-text("Approvals")').first()).toBeVisible({ timeout: 5_000 });
});

// ── Regression: clicking Experts must not bounce to Chat ──────────

test('regression: clicking Experts does not bounce to Chat, even when the auto-selected expert has existing threads', async () => {
  // The bug required TWO things to trigger the bounce:
  //   1. An enabled expert is auto-selected by MessagesTab.
  //   2. That expert has at least one conversation — so ExpertThreadView's
  //      mount effect calls setActiveConversation(threadId), and the old
  //      side-effect inside setActiveConversation flipped the screen back.
  // We seed both preconditions here and assert we stay on Experts.
  const expertName = `${TEST_EXPERT_PREFIX}Anchor ${Date.now()}`;
  const expert = await apiPost<{ id: string }>(page, '/experts', {
    name: expertName,
    description: 'Seeded for sidebar nav regression.',
    domain: 'engineering',
    is_enabled: true,
    is_pinned: true, // ensures MessagesTab picks this expert first
  });
  const convId = crypto.randomUUID().replace(/-/g, '');
  await apiPost(page, '/conversations', {
    id: convId,
    title: 'Seeded thread',
    expert_id: expert.id,
  });

  try {
    // Ensure the renderer picks up the new expert/conversation before we test.
    // ExpertContext polls / reloads on its own, but give it a beat.
    await page.waitForTimeout(500);

    // Baseline: beforeEach already put us on chat.
    await expectOnChat(page);

    // The click under test.
    await clickNav(page, /^Experts$/);

    // Give the bouncing effect (if re-introduced) a full render cycle to fire.
    await page.waitForTimeout(500);

    // Positive: we're on Experts.
    await expectOnExperts(page);

    // Negative: we're NOT on chat. The time-group labels in the sidebar and
    // the composer textarea are chat-screen-only; both must be absent.
    await expect(page.locator('text=/^Previous 7 Days$/')).toHaveCount(0);
    await expect(page.locator('text=/^Today$/')).toHaveCount(0);
    await expect(page.locator('text=/^Yesterday$/')).toHaveCount(0);
    await expect(page.locator('text=/^Older$/')).toHaveCount(0);
  } finally {
    await apiDelete(page, `/conversations/${convId}`);
    await apiDelete(page, `/experts/${expert.id}`);
  }
});
