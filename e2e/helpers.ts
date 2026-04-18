/** E2E helpers for Cerebro's Tasks feature. Connects over CDP to a running
 * app (CEREBRO_E2E_DEBUG_PORT=9229 npm start); does not launch Electron. */

import { chromium, expect, type Browser, type Page, type Locator } from '@playwright/test';

const CDP_PORT = Number(process.env.CEREBRO_CDP_PORT || 9229);

export const COLUMN_LABELS = {
  backlog: 'Backlog',
  in_progress: 'In Progress',
  to_review: 'To Review',
  completed: 'Completed',
  error: 'Error',
} as const;

export type ColumnKey = keyof typeof COLUMN_LABELS;

/** Connect to the already-running Cerebro via CDP. */
export async function connectToApp(): Promise<{ browser: Browser; page: Page }> {
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`;
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });

  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error('No browser contexts found');

  let page: Page | null = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      const url = p.url();
      // Exclude Electron's detached DevTools window — it reports as a page
      // under CDP but obviously isn't the app renderer. Without this filter,
      // screenshots render DevTools and all app-scoped locators miss.
      if (url.startsWith('devtools://')) continue;
      if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
        page = p;
        break;
      }
    }
    if (page) break;
  }
  if (!page) {
    const allPages = contexts.flatMap(c => c.pages());
    page = allPages.find(p => !p.url().startsWith('devtools://')) || allPages[0];
  }
  if (!page) throw new Error('No pages found — is Cerebro running?');

  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('nav', { timeout: 15_000 });
  return { browser, page };
}

/** Dismiss any open modal (NewTaskDialog, AlertModal) or task detail drawer. */
export async function dismissModals(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const zIndex50 = page.locator('.fixed.inset-0.z-50');
    const drawerPanel = page.locator('div.fixed.inset-y-0.right-0.z-40');
    const modalOpen = (await zIndex50.count()) > 0;
    const drawerOpen = (await drawerPanel.count()) > 0;
    if (!modalOpen && !drawerOpen) return;

    // Click the explicit close button — far more reliable than Escape when
    // focus is stuck inside an input/textarea with its own Escape handler.
    const root = modalOpen ? zIndex50 : drawerPanel;
    const closeBtn = root.locator('button[aria-label="Close"], button:has(svg.lucide-x)').first();
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click({ force: true }).catch(() => {});
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(150);
  }
}

/** Navigate to the Tasks screen via sidebar. */
export async function goToTasks(page: Page): Promise<void> {
  await dismissModals(page);
  const tasksBtn = page.locator('nav button').filter({ hasText: /Tasks/i });
  await tasksBtn.first().click();
  await page.waitForSelector('h1:has-text("Tasks")', { timeout: 5_000 });
  await page.waitForSelector(`text=${COLUMN_LABELS.backlog}`, { timeout: 5_000 });
}

/** Navigate to the Chat (Cerebro) screen via sidebar. The primary-nav label is
 *  the app name "Cerebro" — not "Chat" — per `nav.chat` in i18n/locales/en.ts. */
export async function goToChat(page: Page): Promise<void> {
  await dismissModals(page);
  await page.locator('nav button').filter({ hasText: /^Cerebro$/ }).first().click({ force: true });
  await page.waitForSelector('textarea[placeholder*="message" i]', { timeout: 10_000 });
}

/** Navigate to the Experts screen via sidebar. */
export async function goToExperts(page: Page): Promise<void> {
  await dismissModals(page);
  await page.locator('nav button').filter({ hasText: /^Experts$/ }).first().click({ force: true });
  // ExpertsTabs renders two tab labels that don't exist on any other screen.
  await page.waitForSelector('text=/^Messages$/', { timeout: 5_000 });
  await page.waitForSelector('text=/^Hierarchy$/', { timeout: 5_000 });
}

/** Return the column container by its stable testid. */
export function column(page: Page, col: ColumnKey): Locator {
  return page.locator(`[data-testid="kanban-column-${col}"]`);
}

/** Locate a specific task card by title inside any column. */
export function card(page: Page, title: string): Locator {
  return page.locator(`button:has-text("${title}"), div[role="button"]:has-text("${title}")`).first();
}

/** Find a card's current column by walking up the DOM. */
export async function cardColumn(page: Page, title: string): Promise<ColumnKey | null> {
  for (const key of Object.keys(COLUMN_LABELS) as ColumnKey[]) {
    const inCol = column(page, key).getByText(title, { exact: false });
    if ((await inCol.count()) > 0) return key;
  }
  return null;
}

/** Open the "New Task" dialog from the header. */
export async function openNewTaskDialog(page: Page): Promise<Locator> {
  const header = page.locator('h1:has-text("Tasks")').locator('..');
  const plus = header.locator('button').filter({ hasText: /New task/i });
  await plus.click();
  const dialog = page.locator('.fixed.inset-0.z-50');
  await dialog.waitFor({ state: 'visible', timeout: 3_000 });
  return dialog;
}

/** Fill out and submit the New Task dialog. Returns after the dialog closes. */
export async function createTaskViaDialog(
  page: Page,
  opts: { title: string; description?: string; expertName?: string },
): Promise<void> {
  const dialog = await openNewTaskDialog(page);

  await dialog.locator('input[type="text"]').first().fill(opts.title);
  if (opts.description) {
    await dialog.locator('textarea').first().fill(opts.description);
  }
  if (opts.expertName) {
    await dialog.locator('select').first().selectOption({ label: opts.expertName });
  }

  const submit = dialog.locator('button[type="submit"]').filter({ hasText: /Create Task/i });
  await submit.click();
  await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
}

/** Quick-add a task via a column's "Add card" button. */
export async function quickAddInColumn(
  page: Page,
  col: ColumnKey,
  title: string,
): Promise<void> {
  const col_ = column(page, col);
  const addCardBtn = col_.locator('button').filter({ hasText: /ADD CARD/i }).first();
  await addCardBtn.click();
  const input = col_.locator('input[placeholder*="Task title"]');
  await input.fill(title);
  await input.press('Enter');
  await expect(col_.getByText(title)).toBeVisible({ timeout: 5_000 });
}

/** Open the detail drawer for a task by title. */
export async function openDetail(page: Page, title: string): Promise<Locator> {
  await card(page, title).click();
  const drawer = page.locator('div:has(> div > h2)').filter({ has: page.locator('h2') }).first();
  await page.waitForSelector('h2', { timeout: 3_000 });
  return drawer;
}

/** Start button in the detail drawer. */
export function startButton(page: Page): Locator {
  return page.locator('div.z-40 button').filter({ hasText: /^(Start|Re-run|Retry)$/ }).first();
}

/** Cancel button in the detail drawer. */
export function cancelButton(page: Page): Locator {
  return page.locator('div.z-40 button').filter({ hasText: /Cancel task/i }).first();
}

/** Send a queued instruction via the detail drawer composer. */
export async function sendInstruction(page: Page, text: string): Promise<void> {
  const composer = page
    .locator('div.space-y-2')
    .filter({ has: page.locator('button', { hasText: /Send to Expert/i }) })
    .first();
  const ta = composer.locator('textarea').first();
  await ta.click();
  await ta.fill(text);
  // MentionTextarea's onChange fires from the input event; fill() dispatches it,
  // but belt-and-braces: confirm the value and type one char if stale.
  if (((await ta.inputValue()) || '').trim().length === 0) {
    await ta.pressSequentially(text, { delay: 10 });
  }
  await composer.locator('button', { hasText: /Send to Expert/i }).first().click();
}

/** The detail-drawer status pill (header dot + label). */
export function statusPill(page: Page): Locator {
  return page.locator('div.border-b:has(h2) span:has(> span.rounded-full)').first();
}

/** Read the detail-drawer status label (empty string if the pill is absent). */
export async function detailStatus(page: Page): Promise<string> {
  const pill = statusPill(page);
  if ((await pill.count()) === 0) return '';
  return (await pill.innerText()).trim();
}

/** Wait for a card with `title` to appear in `col`. */
export async function waitForCardInColumn(
  page: Page,
  title: string,
  col: ColumnKey,
  timeoutMs = 60_000,
): Promise<void> {
  await expect(column(page, col).getByText(title)).toBeVisible({ timeout: timeoutMs });
}

/** Wait for the detail status pill to match `targets`. Returns the label or 'timeout'. */
export async function waitForStatus(
  page: Page,
  targets: RegExp,
  timeoutMs = 3 * 60_000,
): Promise<string> {
  try {
    await expect
      .poll(() => detailStatus(page), { timeout: timeoutMs, intervals: [250, 500, 1000] })
      .toMatch(targets);
    return (await detailStatus(page)) || 'timeout';
  } catch {
    return 'timeout';
  }
}

/** Verify the Console tab has a live xterm terminal with a rendered surface. */
export async function verifyConsoleHasOutput(page: Page): Promise<boolean> {
  const consoleTab = page.locator('button').filter({ hasText: /^Console$/i });
  if ((await consoleTab.count()) > 0) await consoleTab.first().click();

  const terminal = page.locator('.xterm').first();
  try {
    await terminal.waitFor({ state: 'visible', timeout: 10_000 });
  } catch {
    return false;
  }
  const box = await terminal.boundingBox();
  if (!box || box.width === 0 || box.height === 0) return false;
  const surface = terminal.locator('canvas, .xterm-screen').first();
  return (await surface.count()) > 0;
}

let cachedFirstExpertName: string | null | undefined;

/** Pick the first existing expert name. Result is cached across calls in a run. */
export async function firstExpertName(page: Page): Promise<string | null> {
  if (cachedFirstExpertName !== undefined) return cachedFirstExpertName;
  const dialog = await openNewTaskDialog(page);
  const options = await dialog.locator('select').first().locator('option').allTextContents();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 3_000 });
  // First option is the "Unassigned" placeholder.
  cachedFirstExpertName = options.length > 1 ? options[1] : null;
  return cachedFirstExpertName;
}

/** Save a screenshot for debugging. */
export async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });
}

/** Delete every task whose title begins with any of the given prefixes. Uses the
 * renderer's IPC bridge so we don't need to know the backend's random port. */
export async function deleteTasksByPrefix(
  page: Page,
  prefixes: readonly string[],
): Promise<void> {
  await page.evaluate(async (pfxs: string[]) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    const list = await invoke({ method: 'GET', path: '/tasks' });
    if (!list.ok) return;
    const tasks = list.data as Array<{ id: string; title: string; column: string; run_id: string | null }>;
    for (const t of tasks) {
      if (!pfxs.some((p) => t.title.startsWith(p))) continue;
      // Cancel first (kills any active agent run + clears run_id) before delete
      // so we never leave an orphaned Claude Code subprocess behind.
      if (t.run_id) {
        await invoke({ method: 'POST', path: `/tasks/${t.id}/cancel` }).catch(() => {});
      }
      await invoke({ method: 'DELETE', path: `/tasks/${t.id}` }).catch(() => {});
    }
  }, [...prefixes]);
}

