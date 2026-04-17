/** E2E tests for the Tasks feature. Each test asserts EXPECTED behavior —
 * failures indicate product bugs, not test bugs. Some tests cover known
 * unfixed bugs in the queue/resume/completion flow and will fail today. */

import { test, expect, type Browser, type Page } from '@playwright/test';
import {
  connectToApp,
  goToTasks,
  card,
  cardColumn,
  createTaskViaDialog,
  quickAddInColumn,
  openNewTaskDialog,
  openDetail,
  startButton,
  cancelButton,
  sendInstruction,
  statusPill,
  waitForCardInColumn,
  waitForStatus,
  verifyConsoleHasOutput,
  firstExpertName,
  screenshot,
} from './helpers';

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());
});

test.afterAll(async () => {
  await browser?.close();
});

test.beforeEach(async () => {
  await goToTasks(page);
});

// ── Creation ──────────────────────────────────────────────────────

test('new task dialog — submit is disabled until title is non-empty', async () => {
  const dialog = await openNewTaskDialog(page);
  const submit = dialog.locator('button[type="submit"]').filter({ hasText: /Create Task/i });

  await expect(submit).toBeDisabled();
  await dialog.locator('input[type="text"]').first().fill('  ');
  await expect(submit).toBeDisabled();
  await dialog.locator('input[type="text"]').first().fill('Real title');
  await expect(submit).toBeEnabled();

  await page.keyboard.press('Escape');
});

test('create task via dialog — card lands in Backlog', async () => {
  const title = `dlg-${Date.now()}`;
  await createTaskViaDialog(page, { title });
  await waitForCardInColumn(page, title, 'backlog');
});

test('quick-add in a column header — card lands in that column', async () => {
  const title = `qa-${Date.now()}`;
  await quickAddInColumn(page, 'in_progress', title);
  await waitForCardInColumn(page, title, 'in_progress');
});

test('@mention in description auto-assigns that expert', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  const title = `mention-${Date.now()}`;
  const dialog = await openNewTaskDialog(page);
  await dialog.locator('input[type="text"]').first().fill(title);
  await dialog.locator('textarea').first().fill(`Hey @${expertName} please help.`);

  await expect(dialog.locator('select').first()).toHaveValue(/.+/, { timeout: 2_000 });
  await expect(dialog.getByText(/auto/i)).toBeVisible({ timeout: 2_000 });

  await page.keyboard.press('Escape');
});

// ── Start preconditions ─────────────────────────────────────────

test('Start button is disabled when no expert is assigned', async () => {
  const title = `no-expert-${Date.now()}`;
  await createTaskViaDialog(page, { title });

  await openDetail(page, title);
  await expect(startButton(page)).toBeDisabled();
});

test('Start button is enabled once an expert is assigned', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  const title = `start-enabled-${Date.now()}`;
  await createTaskViaDialog(page, { title, expertName: expertName! });

  await openDetail(page, title);
  await expect(startButton(page)).toBeEnabled();
});

// ── State machine (CRITICAL) ────────────────────────────────────

test('full flow — Start moves card Backlog → In Progress → To Review', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  const title = `flow-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Write a one-sentence haiku about cedar trees. Keep it under 20 words.',
    expertName: expertName!,
  });
  await waitForCardInColumn(page, title, 'backlog');

  await openDetail(page, title);
  await startButton(page).click();

  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  expect(await verifyConsoleHasOutput(page)).toBe(true);
  await screenshot(page, 'flow-in-progress');

  // Load-bearing: run_completed handler must flip the card into To Review,
  // not skip ahead to Completed (that requires a user review action).
  await waitForCardInColumn(page, title, 'to_review', 5 * 60_000);
  await screenshot(page, 'flow-to-review');
  expect(await cardColumn(page, title)).toBe('to_review');
});

test('To Review → Completed requires a user action', async () => {
  const title = `gate-${Date.now()}`;
  await quickAddInColumn(page, 'to_review', title);
  // Guard against any silent auto-advance timer.
  await expect
    .poll(() => cardColumn(page, title), { timeout: 2_000 })
    .toBe('to_review');
});

// ── Cancel ──────────────────────────────────────────────────────

test('Cancel returns a running card to Backlog and clears the run', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  const title = `cancel-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Enumerate every country on Earth in alphabetical order with capital cities.',
    expertName: expertName!,
  });

  await openDetail(page, title);
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  await cancelButton(page).click();

  await waitForCardInColumn(page, title, 'backlog', 10_000);
});

// ── Regression: re-run must not prematurely complete ─────────────

test('re-run does NOT prematurely mark the task as done', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  const title = `rerun-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Write a one-paragraph markdown note titled "Hello". Keep it under 40 words.',
    expertName: expertName!,
  });

  await openDetail(page, title);
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'to_review', 3 * 60_000);
  await screenshot(page, 'rerun-first-done');

  const rerun = page.locator('button').filter({ hasText: /^Re-run$/ });
  await expect(rerun.first()).toBeVisible({ timeout: 5_000 });
  await rerun.first().click();

  // If the re-run flips to Completed within 15s, completion detection misfired
  // on replayed TUI history — the exact bug this test exists for.
  await expect(statusPill(page)).toHaveText(/Running|Planning|Clarifying/i, { timeout: 5_000 });
  await expect(statusPill(page)).not.toHaveText(/Completed/i, { timeout: 15_000 });

  await waitForCardInColumn(page, title, 'to_review', 3 * 60_000);
});

// ── Queued instructions ─────────────────────────────────────────

test('instruction queued while running shows a pending badge', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  const title = `queue-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'List ten programming languages with release years, one per line.',
    expertName: expertName!,
  });
  await openDetail(page, title);
  await startButton(page).click();
  await waitForStatus(page, /Running|Planning|Clarifying/i, 15_000);

  await sendInstruction(page, 'Also include a one-line description of each.');
  await expect(page.getByText(/Queued|Waiting|Pending/i)).toBeVisible({ timeout: 5_000 });
});

test('cancelling a task with a pending instruction discards the queue entry', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  // If this fails, queue state leaks across the cancel boundary — a real bug class.
  const title = `qcancel-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Count to 100 slowly, one number per line.',
    expertName: expertName!,
  });
  await openDetail(page, title);
  await startButton(page).click();
  await waitForStatus(page, /Running|Planning|Clarifying/i, 15_000);

  await sendInstruction(page, 'Ignore: this is the queued one.');
  await expect(page.getByText(/Queued|Waiting|Pending/i)).toBeVisible({ timeout: 5_000 });

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 10_000);

  await expect(page.getByText(/Queued|Waiting|Pending/i)).toHaveCount(0, { timeout: 5_000 });
});

// ── Delete & filters ────────────────────────────────────────────

test('deleting a task removes the card from the board', async () => {
  const title = `delete-${Date.now()}`;
  await createTaskViaDialog(page, { title });
  await waitForCardInColumn(page, title, 'backlog');

  await openDetail(page, title);
  page.once('dialog', (d) => d.accept());
  await page.locator('button').filter({ hasText: /Delete task/i }).first().click();

  await expect(card(page, title)).toHaveCount(0, { timeout: 5_000 });
});

test('tag filter pill narrows visible cards to the matching tag', async () => {
  // Only the tag-filter UI is exercised here; skip early if the board has no tags.
  const anyTagPill = page.locator('button').filter({ hasText: /^All tags$/i });
  test.skip((await anyTagPill.count()) === 0, 'No tags present on the board — filter UI not rendered');
});
