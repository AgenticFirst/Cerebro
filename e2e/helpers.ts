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

// ─── Experts Messages helpers ──────────────────────────────────────────────
// Shared by e2e/experts-messages.spec.ts. Kept in this file so the whole suite
// pulls from one helpers module.

/** Generic-exit-error regex — the subprocess-crash line we never want a user
 *  to see in their chat. Lifted from expert-chat.spec.ts so both specs share it. */
export const GENERIC_EXIT_ERROR = /Claude Code exited unexpectedly/i;

/** Structured-error regex — acceptable *only* in environments without an API
 *  key. Tests that match this fail loudly so the operator fixes the env. */
export const STRUCTURED_ERROR =
  /Authentication error|Rate limited|maximum number of turns|Expert not installed|not.*found|ENOENT/i;

export interface VerifiedExpertMeta {
  /** Backend slug from `backend/experts/seed.py`. */
  slug: string;
  /** Visible display name in `ExpertListRail` rows and `ThreadHeader`. */
  name: string;
  /** Capitalized label surfaced under the name in list rows. */
  domain: 'engineering' | 'creative' | 'research' | 'productivity';
  /** Regex the W2 reply must match — any keyword an expert naturally uses. */
  keywords: RegExp;
}

/** Verified expert roster — mirrored from backend/experts/seed.py. Order
 *  matches the seed file. Keep these in sync; the C1 test asserts the roster. */
export const VERIFIED_EXPERT_NAMES: readonly VerifiedExpertMeta[] = [
  { slug: 'full-stack-engineer', name: 'Principal Full-Stack Engineer', domain: 'engineering', keywords: /api|migration|endpoint|schema|handler/i },
  { slug: 'product-designer', name: 'Staff Product Designer', domain: 'creative', keywords: /visual|layout|color|typography|design|figma/i },
  { slug: 'frontend-engineer', name: 'Principal Frontend Engineer', domain: 'engineering', keywords: /component|accessib|state|react|render|hook/i },
  { slug: 'technical-writer', name: 'Senior Technical Writer', domain: 'creative', keywords: /section|audience|example|documentation|clarity|guide/i },
  { slug: 'ios-engineer', name: 'Principal iOS Engineer', domain: 'engineering', keywords: /swift|view|state|ios|testflight|app\s*store/i },
  { slug: 'growth-marketer', name: 'Growth Marketing Lead', domain: 'creative', keywords: /positioning|audience|cta|funnel|campaign|conversion/i },
  { slug: 'security-engineer', name: 'Security Engineer', domain: 'engineering', keywords: /threat|mitigation|attacker|vulnerability|risk|auth/i },
  { slug: 'backend-engineer', name: 'Principal Backend Engineer', domain: 'engineering', keywords: /migration|backfill|index|slo|idempot|queue/i },
  { slug: 'data-analyst', name: 'Senior Data Analyst', domain: 'research', keywords: /groupby|aggregate|channel|analysis|pandas|sql|chart/i },
  { slug: 'product-manager', name: 'Senior Product Manager', domain: 'productivity', keywords: /problem|metric|scope|prd|jobs?-to-be-done|roadmap/i },
  { slug: 'customer-support-specialist', name: 'Customer Support Specialist', domain: 'productivity', keywords: /classif|escalat|reply|ticket|customer|bug/i },
];

/** A file or folder chip in the last assistant message bubble. */
export interface ChipHandle {
  /** The root DOM node of the chip (button for folder, div for file). */
  locator: Locator;
  /** Extension label text displayed on the chip, e.g., 'TS', 'MD', 'SW'. */
  label: string;
  /** Filename text displayed on the chip (the `.truncate` span). */
  name: string;
  /** True if this is a folder chip (single "Open folder" branch). */
  isFolder: boolean;
}

/** Convert a test title into a filesystem-safe slug for per-test workspaces. */
function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Absolute workspace path handed to the LLM when we want it to write files
 *  there. Always `/tmp/cerebro-e2e/<slug>`. */
export function workspacePathFor(testTitle: string): string {
  return `/tmp/cerebro-e2e/${slugify(testTitle)}`;
}

/** Per-test workspace "creation" — a no-op. The LLM's `Write` tool invokes
 *  `mkdir -p` on the parent directory before writing, so we don't need the
 *  path to exist ahead of time. Returns the deterministic path so the spec
 *  can hand it to the LLM inside the prompt. */
export async function createWorkspace(_page: Page, testTitle: string): Promise<string> {
  return workspacePathFor(testTitle);
}

/** Per-test workspace teardown — a no-op for now. The renderer has no
 *  `rm -rf` IPC, /tmp rotates on reboot, and per-test slugs don't collide
 *  across runs, so leftover files are cosmetic rather than pollutant. If a
 *  future run needs deterministic teardown, add a thin `shell:rmTree` IPC
 *  (gated on a test-only path prefix) rather than shelling out here. */
export async function cleanupWorkspace(_page: Page, _testTitle: string): Promise<void> {
  // intentionally empty — see comment
}

/** Stat a path via the shell IPC. Returns `{ exists, isDirectory, size }`. */
export async function statPath(
  page: Page,
  absolutePath: string,
): Promise<{ exists: boolean; isDirectory: boolean; size: number }> {
  return page.evaluate(async (p: string) => {
    const shell = (window as unknown as {
      cerebro: { shell: { statPath: (p: string) => Promise<{ exists: boolean; isDirectory: boolean; size: number }> } };
    }).cerebro.shell;
    return shell.statPath(p);
  }, absolutePath);
}

/** Copy a file to ~/Downloads via the shell IPC. Returns the destination path. */
export async function downloadToDownloads(page: Page, absolutePath: string): Promise<string> {
  return page.evaluate(async (p: string) => {
    const shell = (window as unknown as {
      cerebro: { shell: { downloadToDownloads: (p: string) => Promise<string> } };
    }).cerebro.shell;
    return shell.downloadToDownloads(p);
  }, absolutePath);
}

/** Navigate into the Messages tab of the Experts screen. Assumes already on Experts. */
export async function gotoMessagesTab(page: Page): Promise<void> {
  // ExpertsTabs renders "Messages" and "Hierarchy" buttons; click Messages.
  // `exact` regex so we don't match other things on the page containing "Messages".
  const btn = page.locator('button').filter({ hasText: /^Messages$/ }).first();
  if ((await btn.count()) > 0) await btn.click({ force: true }).catch(() => {});
  // Search input in ExpertListRail is the tab's unique marker.
  await page.waitForSelector('input[placeholder*="Search experts" i]', { timeout: 5_000 });
}

/** Locator for the row in `ExpertListRail` whose visible name matches `expertName`.
 *  Scopes to the rail container (parent of the "Search experts" input) so the
 *  ThreadHeader / chat-message instances of the same name don't collide. */
export function expertRow(page: Page, expertName: string): Locator {
  const rail = page
    .locator('input[placeholder*="Search experts" i]')
    .locator('xpath=ancestor::div[contains(@class, "w-[260px]") or contains(@class, "flex-col")][1]')
    .first();
  return rail
    .locator('button')
    .filter({ hasText: new RegExp(expertName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .first();
}

/** Click the row for `expertName`. Filters via the search box first to stabilize
 *  scroll position. Returns the row locator. */
export async function selectExpertInMessagesTab(page: Page, expertName: string): Promise<Locator> {
  await gotoMessagesTab(page);
  const search = page.locator('input[placeholder*="Search experts" i]').first();
  await search.click();
  await search.fill(expertName);
  const row = expertRow(page, expertName);
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
  // Clear the search filter so subsequent selections in the same test don't
  // fail because the other expert is filtered out of the list.
  await search.fill('');
  return row;
}

/** The ChatInput textarea scoped to the active `ExpertThreadView` (not the
 *  global Chat screen's composer). */
export function expertThreadComposer(page: Page): Locator {
  // ExpertThreadView wraps ChatInput in `<div className="mx-auto max-w-3xl">`.
  // The textarea uses the i18n placeholder "Send a message...".
  return page.locator('textarea[placeholder*="Send a message" i]').last();
}

/** Type `text` into the expert thread composer and send it. */
export async function sendExpertMessage(page: Page, text: string): Promise<void> {
  const ta = expertThreadComposer(page);
  await ta.click();
  await ta.fill(text);
  // fill() dispatches input; belt-and-braces — confirm the value before send.
  if (((await ta.inputValue()) || '').trim().length === 0) {
    await ta.pressSequentially(text, { delay: 10 });
  }
  await ta.press('Enter');
}

/** Open a fresh thread for the currently-selected expert via the Clock dropdown. */
export async function openNewThread(page: Page): Promise<void> {
  // ThreadHeader renders a Clock-icon button with title="Threads" (i18n'd).
  const clockBtn = page.locator('button[title="Threads"]').first();
  await clockBtn.click();
  // ThreadsDropdown renders a "New thread" button at the top.
  const newThreadBtn = page.locator('button').filter({ hasText: /^New thread$/ }).first();
  await expect(newThreadBtn).toBeVisible({ timeout: 3_000 });
  await newThreadBtn.click();
}

/** Locator for the last assistant message bubble in the active thread.
 *  ChatMessage exposes `data-testid="chat-message"` + `data-role="assistant"`
 *  so we don't accidentally match nested tool-call cards that reuse the same
 *  `animate-fade-in` class. */
export function lastAssistantMessage(page: Page): Locator {
  return page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
}

/** Wait for the most recent assistant message to finalize: `MarkdownContent`
 *  (`.prose`) block rendered with non-empty text, no "Working on it…" pill,
 *  no "Cerebro is thinking" indicator. Returns the rendered markdown text.
 *
 *  We anchor on `.prose` rather than the bubble's `innerText` because the
 *  bubble can contain tool-call cards + a ThinkingIndicator while still
 *  mid-stream — all of which inflate `innerText` without meaning a reply
 *  actually arrived. */
export async function waitForExpertReply(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const msg = lastAssistantMessage(page);
    if ((await msg.count()) > 0) {
      // "Working on it…" pill and "Cerebro is thinking" indicator both signal
      // an in-flight stream — if either is visible, we're not done.
      const busy =
        (await msg.locator('text=/Working on it/i').count()) > 0 ||
        (await msg.locator('text=/is thinking/i').count()) > 0;
      const prose = msg.locator('.prose').first();
      const hasProse = (await prose.count()) > 0;
      if (!busy && hasProse) {
        const proseText = (await prose.innerText().catch(() => '')).trim();
        if (proseText.length > 0) return proseText;
      }
    }
    await page.waitForTimeout(500);
  }
  // Return whatever is there so the caller can include it in the assertion msg.
  const msg = lastAssistantMessage(page);
  const prose = msg.locator('.prose').first();
  if ((await prose.count()) > 0) {
    return (await prose.innerText().catch(() => '')).trim();
  }
  return (await msg.innerText().catch(() => '')).trim();
}

/** List all attachment chips rendered on the last assistant message.
 *  File chips are identified by their "Download to Downloads" button; folder
 *  chips are identified as the outer button with title="Open folder". This
 *  avoids depending on Tailwind class-name stability. */
export async function attachmentChipsOf(messageLocator: Locator): Promise<ChipHandle[]> {
  const chips: ChipHandle[] = [];

  // File chips — locate each Download button, walk up to its chip root wrapper.
  const fileDownloadBtns = messageLocator.locator('button[title="Download to Downloads"]');
  const fileCount = await fileDownloadBtns.count();
  for (let i = 0; i < fileCount; i++) {
    const downloadBtn = fileDownloadBtns.nth(i);
    // Chip root is the nearest ancestor div with role-less sibling buttons. The
    // chip renders as `<div class="inline-flex ...">`. `locator('xpath=..')`
    // gives the immediate parent which is the chip root.
    const root = downloadBtn.locator('xpath=..');
    const label = (await root.locator('span').first().innerText().catch(() => '')).trim();
    const name = (await root.locator('span.truncate').first().innerText().catch(() => '')).trim();
    chips.push({ locator: root, label, name, isFolder: false });
  }

  // Folder chips — the outer <button> itself has title="Open folder".
  const folderBtns = messageLocator.locator('button[title="Open folder"]');
  const folderCount = await folderBtns.count();
  for (let i = 0; i < folderCount; i++) {
    const root = folderBtns.nth(i);
    const name = (await root.locator('span.truncate').first().innerText().catch(() => '')).trim();
    chips.push({ locator: root, label: 'DIR', name, isFolder: true });
  }

  return chips;
}

/** Click the download button on a file chip. Asserts the button exists. */
export async function clickChipDownload(chip: ChipHandle): Promise<void> {
  if (chip.isFolder) throw new Error('clickChipDownload called on a folder chip');
  const btn = chip.locator.locator('button[title="Download to Downloads"]').first();
  await expect(btn).toBeVisible({ timeout: 3_000 });
  await btn.click();
}

/** Click the reveal button on a file chip. */
export async function clickChipReveal(chip: ChipHandle): Promise<void> {
  if (chip.isFolder) throw new Error('clickChipReveal called on a folder chip');
  const btn = chip.locator.locator('button[title="Reveal in folder"]').first();
  await expect(btn).toBeVisible({ timeout: 3_000 });
  await btn.click();
}

/** Click the "Open folder" button on a folder chip. */
export async function clickFolderOpen(chip: ChipHandle): Promise<void> {
  if (!chip.isFolder) throw new Error('clickFolderOpen called on a file chip');
  await chip.locator.click();
}

/** Snapshot every current conversation ID. Used at the start of a test run
 *  so that the afterAll hook can delete only the conversations the suite
 *  created (no title-prefix coupling required). */
export async function snapshotConversationIds(page: Page): Promise<Set<string>> {
  const ids = await page.evaluate(async () => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    const list = await invoke({ method: 'GET', path: '/conversations' });
    if (!list.ok) return [] as string[];
    const body = list.data as { conversations: Array<{ id: string }> };
    return (body.conversations || []).map((c) => c.id);
  });
  return new Set(ids);
}

/** Delete every conversation whose ID is NOT in `preexisting`. Used in afterAll
 *  to clean up exactly the conversations the suite created. */
export async function deleteConversationsNotIn(
  page: Page,
  preexisting: Set<string>,
): Promise<void> {
  await page.evaluate(async (keep: string[]) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    const list = await invoke({ method: 'GET', path: '/conversations' });
    if (!list.ok) return;
    const body = list.data as { conversations: Array<{ id: string; title: string }> };
    const keepSet = new Set(keep);
    for (const c of body.conversations || []) {
      if (keepSet.has(c.id)) continue;
      await invoke({ method: 'DELETE', path: `/conversations/${c.id}` }).catch(() => {});
    }
  }, [...preexisting]);
}

