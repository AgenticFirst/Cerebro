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
  deleteTasksByPrefix,
  dismissModals,
} from './helpers';

let browser: Browser;
let page: Page;

// Prefixes every task this suite creates. `afterEach`/`afterAll` use this to
// scrub state so nothing leaks between tests or between suite runs.
const TEST_TITLE_PREFIXES = [
  'dlg-', 'qa-', 'mention-', 'no-expert-', 'start-enabled-',
  'flow-', 'gate-', 'cancel-', 'rerun-', 'queue-', 'qcancel-', 'delete-',
  'preview-', 'devsrv-', 'remotion-', 'vid-',
] as const;

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());
  // Clean any residue from a previous suite run before we start.
  await deleteTasksByPrefix(page, TEST_TITLE_PREFIXES);
});

test.afterAll(async () => {
  // Best-effort full scrub at the end of the suite.
  try { await deleteTasksByPrefix(page, TEST_TITLE_PREFIXES); } catch { /* noop */ }
  await browser?.close();
});

test.beforeEach(async () => {
  await dismissModals(page);
  await goToTasks(page);
});

test.afterEach(async () => {
  try { await dismissModals(page); } catch { /* noop */ }
  try { await deleteTasksByPrefix(page, TEST_TITLE_PREFIXES); } catch { /* noop */ }
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

  test.setTimeout(6 * 60_000);

  const title = `flow-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Write a one-sentence haiku about cedar trees, under 20 words.',
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
  await waitForCardInColumn(page, title, 'to_review', 4 * 60_000);
  await screenshot(page, 'flow-to-review');
  expect(await cardColumn(page, title)).toBe('to_review');
});

test('To Review → Completed requires a user action', async () => {
  const title = `gate-${Date.now()}`;
  await quickAddInColumn(page, 'to_review', title);
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

  test.setTimeout(10 * 60_000);

  const title = `rerun-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Write a one-sentence haiku about cedar trees, under 20 words.',
    expertName: expertName!,
  });

  await openDetail(page, title);
  await startButton(page).click();
  // Real agent runs complete via the wrapProseAsDeliverable fallback on idle
  // exit — that path needs the full idle-timeout window to finalize, so
  // budget generously here.
  await waitForCardInColumn(page, title, 'to_review', 7 * 60_000);

  // The xterm viewport overlaps the Re-run button's hit area, so a regular
  // click intermittently gets intercepted. Dispatch through evaluate.
  await expect(startButton(page)).toBeVisible({ timeout: 5_000 });
  await startButton(page).evaluate((el) => (el as HTMLButtonElement).click());

  // Card must leave to_review and enter in_progress once the re-run starts.
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  // Load-bearing: must stay in in_progress for at least 3s after the re-run
  // starts. The bug-under-test is TUI history replay (which includes the
  // prior run's deliverable block) triggering completion detection within
  // ~1s of the resume starting. 3s of stability proves the resumeSettled
  // offset logic correctly skips the replayed history. We don't assert
  // longer stability because a real agent may legitimately emit a follow-up
  // deliverable within ~5–10s of receiving a resume signal.
  await page.waitForTimeout(3_000);
  expect(await cardColumn(page, title)).toBe('in_progress');

  // Cancel deterministically so the test doesn't wait on the real re-run.
  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
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
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await expect(drawer.locator('.bg-amber-500\\/15')).toBeVisible({ timeout: 5_000 });

  // Clean up — don't leave a running agent eating CPU for the next test.
  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 10_000);
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
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  const pendingBadge = drawer.locator('.bg-amber-500\\/15');
  await expect(pendingBadge).toBeVisible({ timeout: 5_000 });

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 10_000);

  await expect(pendingBadge).toHaveCount(0, { timeout: 5_000 });
});

// ── Delete & filters ────────────────────────────────────────────

test('deleting a task removes the card from the board', async () => {
  const title = `delete-${Date.now()}`;
  await createTaskViaDialog(page, { title });
  await waitForCardInColumn(page, title, 'backlog');

  await openDetail(page, title);
  await page.locator('div.z-40 button[title="Delete task"]').first().click();
  // Confirm via the on-brand AlertModal.
  const confirmModal = page.locator('.fixed.inset-0.z-50');
  await confirmModal.waitFor({ state: 'visible', timeout: 3_000 });
  await confirmModal.locator('button').filter({ hasText: /^Delete$/ }).click();

  await expect(card(page, title)).toHaveCount(0, { timeout: 5_000 });
});

test('tag filter pill narrows visible cards to the matching tag', async () => {
  // Only the tag-filter UI is exercised here; skip early if the board has no tags.
  const anyTagPill = page.locator('button').filter({ hasText: /^All tags$/i });
  test.skip((await anyTagPill.count()) === 0, 'No tags present on the board — filter UI not rendered');
});

// ── LivePreview for HTML projects (inline + focus mode) ─────────

test('LivePreview renders iframe inline and in focus mode', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(6 * 60_000);

  const title = `preview-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description:
      'Create a file named index.html in the current working directory. Its content must be exactly: ' +
      '<!doctype html><html><body><h1 id="probe">Hello Preview</h1></body></html>',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  // Start auto-enters focus mode (TaskDetailDrawer.handleStart — see the
  // `setIsFullWidth(true)` call), so the drawer is now in the 3-panel layout.
  const exitFocus = drawer.locator('button[title="Exit focus mode"]').first();
  await expect(exitFocus).toBeVisible({ timeout: 5_000 });

  // Belt-and-braces: the agent *should* write index.html per the prompt, but
  // the iframe render only depends on the file existing. Write it ourselves
  // so the assertion doesn't hinge on the agent's compliance or timing.
  const taskId = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }>;
      };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    const tasks = list.data as Array<{ id: string; title: string }>;
    const found = tasks.find((x) => x.title === t);
    if (!found) throw new Error('seeded task missing from GET /tasks');
    return found.id;
  }, title);
  const workspacePath = await page.evaluate(
    async (id: string) => (window as unknown as {
      cerebro: { taskTerminal: { getWorkspacePath: (id: string) => Promise<string> } };
    }).cerebro.taskTerminal.getWorkspacePath(id),
    taskId,
  );
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, 'index.html'),
    '<!doctype html><html><body><h1 id="probe">Hello Preview</h1></body></html>',
    'utf8',
  );

  const expectedSrc = `cerebro-workspace://${taskId}/index.html`;

  // Focus mode (the state Start left us in): LivePreview lives in the right
  // panel of the 3-panel layout. Iframe must be rendered with the workspace URL.
  const focusFrame = drawer.locator(`iframe[title="Live preview"][src="${expectedSrc}"]`);
  await expect(focusFrame).toBeVisible({ timeout: 15_000 });

  // Exit focus mode → compact tab layout. Preview tab should appear (gated on
  // task.run_id, which is set). Click it and verify the inline iframe.
  await exitFocus.click();
  const previewTab = drawer.locator('button').filter({ hasText: /^Preview$/ });
  await expect(previewTab).toBeVisible({ timeout: 5_000 });
  await previewTab.click();
  const inlineFrame = drawer.locator(`iframe[title="Live preview"][src="${expectedSrc}"]`);
  await expect(inlineFrame).toBeVisible({ timeout: 10_000 });
});

test('LivePreview dev_server — detects dev-server URL from terminal, completes', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(8 * 60_000);

  // Real HTTP server on a dynamic local port. The detected URL must actually
  // resolve — otherwise the iframe loads an error page and the src assertion
  // still passes, but nothing has verified the full dev-server round-trip.
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><h1 id="devprobe">Dev Server</h1></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) throw new Error('could not allocate local port');
  const devUrl = `http://127.0.0.1:${port}`;

  try {
    const title = `devsrv-${Date.now()}`;
    // Prompt avoids `Local:` and surrounding punctuation so the URL detection
    // regex `/(http:\/\/127\.0\.0\.1:\d+)/` captures the URL cleanly from the
    // PTY stream — whether it matches the description echo or the actual shell
    // output. Two explicit steps keep the agent from ending early.
    await createTaskViaDialog(page, {
      title,
      description:
        `Two steps. Step 1: run this Bash command: echo ${devUrl} . ` +
        `Step 2: emit your deliverable (markdown, one sentence) confirming the command ran.`,
      expertName: expertName!,
    });

    await openDetail(page, title);
    const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    await startButton(page).click();
    await waitForCardInColumn(page, title, 'in_progress', 15_000);

    // Load-bearing: iframe src must flip from cerebro-workspace:// to the
    // detected dev-server URL once the echo hits the PTY stream.
    const liveFrame = drawer.locator(`iframe[title="Live preview"][src="${devUrl}"]`);
    await expect(liveFrame).toBeVisible({ timeout: 4 * 60_000 });

    // "Live" badge confirms source === 'dev_server' (not just a coincidental
    // src match from some other code path).
    const liveBadge = drawer.locator('span', { hasText: /^Live$/ }).first();
    await expect(liveBadge).toBeVisible({ timeout: 5_000 });

    // Agent must still emit its deliverable after the echo; run_completed
    // flips the card to to_review.
    await waitForCardInColumn(page, title, 'to_review', 3 * 60_000);
    expect(await cardColumn(page, title)).toBe('to_review');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── Regression: completion detection must not fire on prompt echoes ─────
//
// Reproduction for the "task jumps straight to to_review with blank console"
// bug the user reported with a Remotion Instagram-story task. Root cause:
// the `<task_direct>` system prompt contained a literal
// `<deliverable kind="markdown" title="...">…</deliverable>` example which
// the Claude Code TUI echoes back on startup. The completion-detection
// regex in runtime.ts matched that echo and initiated graceful exit before
// the agent had done any real work — landing the card in to_review with
// nothing in the terminal buffer. Any non-trivial task exhibits the bug.

test('task with a substantial prompt does NOT prematurely mark as done', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(90_000);

  const title = `remotion-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description:
      'Create a short video instagram story ad for cerebro using remotion/ 5 seconds',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  await startButton(page).click();

  // Card must enter in_progress — a real agent run is starting.
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  // Load-bearing: the card must stay in in_progress for at least 20 seconds.
  // No realistic Remotion video task completes that fast; if the card bounces
  // to to_review inside this window, completion detection false-triggered on
  // the prompt echo (the bug under test).
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(5_000);
    const col = await cardColumn(page, title);
    expect(col, `card bounced to ${col} at ${(i + 1) * 5}s into the run`).toBe('in_progress');
  }

  // Console must have real PTY output (not blank). The exact content depends
  // on the agent's behavior, but the xterm canvas should be non-empty and
  // the readBuffer IPC should return a non-trivial string for this task's
  // persisted session id.
  const taskId = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    const tasks = list.data as Array<{ id: string; title: string; run_id: string | null }>;
    return tasks.find((x) => x.title === t);
  }, title);
  expect(taskId?.run_id, 'task.run_id must be set once the run is active').toBeTruthy();

  const bufferLen = await page.evaluate(async (rid: string) => {
    const buf = await (window as unknown as {
      cerebro: { taskTerminal: { readBuffer: (id: string) => Promise<string | null> } };
    }).cerebro.taskTerminal.readBuffer(rid);
    return (buf ?? '').length;
  }, taskId!.run_id!);
  expect(bufferLen, 'persisted console buffer must be populated under task.run_id').toBeGreaterThan(200);

  // Cancel so afterEach teardown doesn't need to reap a long-lived agent.
  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
});

// ── Regression: console must stay populated across rerun cycles ─────────
//
// The terminal buffer is keyed by the task's *session* id (task.run_id) —
// not the Electron-minted internal runId — so a fresh run, its completion,
// and a subsequent rerun all write to the same key. This guards against
// regression to the earlier architecture where the buffer key diverged on
// rerun and the Console tab went blank after the run ended.

test('console buffer persists under task.run_id across a run lifecycle', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(60_000);

  const title = `remotion-persist-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Create a short video instagram story ad for cerebro using remotion/ 5 seconds',
    expertName: expertName!,
  });

  await openDetail(page, title);
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  // Give the PTY ~6s to render enough output to be measurable.
  await page.waitForTimeout(6_000);

  const runIdBeforeCancel = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    const tasks = list.data as Array<{ id: string; title: string; run_id: string | null }>;
    return tasks.find((x) => x.title === t)?.run_id ?? null;
  }, title);
  expect(runIdBeforeCancel).toBeTruthy();

  const bufferBefore = await page.evaluate(async (rid: string) => {
    const buf = await (window as unknown as {
      cerebro: { taskTerminal: { readBuffer: (id: string) => Promise<string | null> } };
    }).cerebro.taskTerminal.readBuffer(rid);
    return (buf ?? '').length;
  }, runIdBeforeCancel!);
  expect(bufferBefore, 'live buffer must be populated').toBeGreaterThan(200);

  // Cancel and verify task.run_id is preserved; buffer must still be readable.
  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);

  const bufferAfter = await page.evaluate(async (rid: string) => {
    const buf = await (window as unknown as {
      cerebro: { taskTerminal: { readBuffer: (id: string) => Promise<string | null> } };
    }).cerebro.taskTerminal.readBuffer(rid);
    return (buf ?? '').length;
  }, runIdBeforeCancel!);
  expect(bufferAfter, 'buffer must still be readable after cancel (console must not go blank)').toBeGreaterThan(200);
});

// ── Regression: LivePreview renders rendered-video artifacts ─────────────
//
// Reproduction for the "no preview at all" failure the user hit with
// "create a short video instagram story ad for cerebro using remotion/
// 5 seconds". Remotion projects don't produce an `index.html` — they emit
// TSX source files and render to MP4. The old LivePreview only handled
// static HTML and dev-server URLs, so it showed "Waiting for files" even
// when the workspace had a finished video. This test seeds a real MP4 into
// the workspace (bypassing a multi-minute real render) and verifies the
// Preview tab renders a <video> element pointing at it.

test('LivePreview renders MP4 artifacts (Remotion / video task)', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(90_000);

  const title = `vid-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'create a short video instagram story ad for cerebro using remotion/ 5 seconds',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  // Start auto-enters focus mode. Get the task id so we can write into the
  // per-task workspace directory directly.
  const taskId = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    const tasks = list.data as Array<{ id: string; title: string }>;
    const found = tasks.find((x) => x.title === t);
    if (!found) throw new Error('seeded task missing from GET /tasks');
    return found.id;
  }, title);
  const workspacePath = await page.evaluate(
    async (id: string) => (window as unknown as {
      cerebro: { taskTerminal: { getWorkspacePath: (id: string) => Promise<string> } };
    }).cerebro.taskTerminal.getWorkspacePath(id),
    taskId,
  );

  // Seed a minimal valid MP4 into the workspace under `out/video.mp4` — the
  // conventional Remotion render target. Contents don't matter (the <video>
  // element may fail to decode a synthetic blob), but the element itself must
  // be rendered with the correct src for this regression test to be
  // meaningful.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const outDir = path.join(workspacePath, 'out');
  await fs.mkdir(outDir, { recursive: true });
  // 32 bytes of "ftyp isom" header is enough for the handler to serve as
  // video/mp4 based on the extension. The <video> element's readiness isn't
  // what we're asserting — just the src wire-up.
  await fs.writeFile(path.join(outDir, 'video.mp4'), Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
  ]));

  const expectedSrc = `cerebro-workspace://${taskId}/out/video.mp4`;

  // LivePreview re-probes the workspace every 3s while running. Wait for the
  // video element to be wired up with the correct src.
  const video = drawer.locator(`video[title="Live preview"][src="${expectedSrc}"]`);
  await expect(video).toBeVisible({ timeout: 15_000 });

  // The "Video" badge proves the artifact was detected via the video-kind
  // branch, not an iframe fallback.
  const videoBadge = drawer.locator('span', { hasText: /^Video$/ }).first();
  await expect(videoBadge).toBeVisible({ timeout: 5_000 });

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
});

// ── Regression: LivePreview renders image artifacts (no index.html) ──────
//
// Tasks that produce a single image (e.g. chart, generated diagram) should
// show it directly rather than the "Waiting for files" empty state.

test('LivePreview renders image artifacts', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(60_000);

  const title = `vid-img-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Generate a diagram as a PNG file at chart.png',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  const taskId = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    const tasks = list.data as Array<{ id: string; title: string }>;
    return tasks.find((x) => x.title === t)!.id;
  }, title);
  const workspacePath = await page.evaluate(
    async (id: string) => (window as unknown as {
      cerebro: { taskTerminal: { getWorkspacePath: (id: string) => Promise<string> } };
    }).cerebro.taskTerminal.getWorkspacePath(id),
    taskId,
  );

  // 1x1 transparent PNG — smallest valid image we can write.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'chart.png'), Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]));

  const expectedSrc = `cerebro-workspace://${taskId}/chart.png`;
  const img = drawer.locator(`img[src="${expectedSrc}"]`);
  await expect(img).toBeVisible({ timeout: 15_000 });

  const imageBadge = drawer.locator('span', { hasText: /^Image$/ }).first();
  await expect(imageBadge).toBeVisible({ timeout: 5_000 });

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
});

// ── Regression: source-only projects show a file browser, not blank ──────
//
// User report: a Remotion task completed and produced `index.tsx`, `Root.tsx`,
// `package-lock.json` etc. — source files with no renderable artifact. The
// Preview tab showed "Waiting for files" with nothing else, even though the
// workspace clearly wasn't empty. The fallback file browser should list what
// the agent produced and let the user click a previewable file to render it.

test('LivePreview shows a file browser when no renderable artifact exists', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(90_000);

  const title = `vid-src-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Scaffold a Remotion project with source files only',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  const taskId = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    return (list.data as Array<{ id: string; title: string }>).find((x) => x.title === t)!.id;
  }, title);
  const workspacePath = await page.evaluate(
    async (id: string) => (window as unknown as {
      cerebro: { taskTerminal: { getWorkspacePath: (id: string) => Promise<string> } };
    }).cerebro.taskTerminal.getWorkspacePath(id),
    taskId,
  );

  // Seed source files like a real Remotion scaffold — none are directly
  // previewable (no index.html, no .mp4), but the workspace isn't empty.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'index.tsx'), 'export const a = 1;\n');
  await fs.writeFile(path.join(workspacePath, 'Root.tsx'), 'export const Root = () => null;\n');
  await fs.writeFile(path.join(workspacePath, 'package.json'), '{"name":"remotion-story"}\n');

  // The file browser must appear (NOT the "Waiting for files" empty state).
  const browser = drawer.locator('[data-testid="preview-file-browser"]');
  await expect(browser).toBeVisible({ timeout: 15_000 });
  await expect(browser.getByText('index.tsx')).toBeVisible();
  await expect(browser.getByText('Root.tsx')).toBeVisible();
  await expect(browser.getByText('package.json')).toBeVisible();

  // The empty state must NOT be rendered when files exist.
  await expect(drawer.locator('[data-testid="preview-empty"]')).toHaveCount(0);

  // Clicking a source file must render its contents as code — otherwise the
  // user is stuck staring at a file list with no way to inspect what was
  // actually produced.
  await browser.locator('button').filter({ hasText: /index\.tsx/ }).click();
  const textView = drawer.locator('[data-testid="preview-text"]');
  await expect(textView).toBeVisible({ timeout: 5_000 });
  await expect(textView).toContainText('export const a = 1;');
  const codeBadge = drawer.locator('span', { hasText: /^Code$/ }).first();
  await expect(codeBadge).toBeVisible();

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
});

// ── Regression: preview element stays mounted across poll ticks ─────────
//
// User report: "live preview refreshes every 1-2 seconds (doesn't reliably
// stay open)". The old code bumped iframeKey on a blind 3s interval AND
// replaced `tree` state on every poll tick even when nothing changed, so
// React re-rendered and the video/image element remounted. Now reloads are
// mtime-driven — a stable artifact should mount exactly once.

test('LivePreview does NOT remount video element while artifact is unchanged', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(60_000);

  const title = `vid-stable-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Stability check',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  const taskId = await page.evaluate(async (t: string) => {
    const bridge = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro;
    const list = await bridge.invoke({ method: 'GET', path: '/tasks' });
    return (list.data as Array<{ id: string; title: string }>).find((x) => x.title === t)!.id;
  }, title);
  const workspacePath = await page.evaluate(
    async (id: string) => (window as unknown as {
      cerebro: { taskTerminal: { getWorkspacePath: (id: string) => Promise<string> } };
    }).cerebro.taskTerminal.getWorkspacePath(id),
    taskId,
  );

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const outDir = path.join(workspacePath, 'out');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'video.mp4'), Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
  ]));

  const expectedSrc = `cerebro-workspace://${taskId}/out/video.mp4`;
  const video = drawer.locator(`video[title="Live preview"][src="${expectedSrc}"]`);
  await expect(video).toBeVisible({ timeout: 15_000 });

  // Tag the mounted video element with a custom attribute. If React remounts
  // it (key prop changes), the attribute vanishes. Survival across three
  // poll windows (3s interval × 3 = 9s) proves the preview is stable.
  await video.evaluate((el) => el.setAttribute('data-stability-marker', 'pinned'));
  await page.waitForTimeout(9_000);
  const marker = await video.evaluate((el) => el.getAttribute('data-stability-marker'));
  expect(marker, 'video element must NOT remount during quiet poll ticks').toBe('pinned');

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
});

// ── Regression: "Open workspace folder" button is always present ────────
//
// User report: "There is also no button to see preview in an external
// browser". Workspace-protocol URLs can't be opened in a normal browser,
// so the closest analogue is revealing the workspace directory in Finder /
// Explorer. The button has to exist regardless of dev-server detection.

test('LivePreview exposes a button to reveal the workspace folder', async () => {
  const expertName = await firstExpertName(page);
  test.skip(!expertName, 'No expert available to assign');

  test.setTimeout(60_000);

  const title = `vid-reveal-${Date.now()}`;
  await createTaskViaDialog(page, {
    title,
    description: 'Reveal test',
    expertName: expertName!,
  });

  await openDetail(page, title);
  const drawer = page.locator('div.fixed.inset-y-0.right-0.z-40');
  await startButton(page).click();
  await waitForCardInColumn(page, title, 'in_progress', 15_000);

  const previewTab = drawer.locator('button').filter({ hasText: /^Preview$/ });
  if ((await previewTab.count()) > 0) await previewTab.click();

  // The reveal button must always be present for internal workspaces, even
  // when no dev server URL has been detected (the user is looking at a file
  // browser or empty state).
  const revealBtn = drawer.locator('button[aria-label="Open workspace folder"]');
  await expect(revealBtn).toBeVisible({ timeout: 10_000 });

  await cancelButton(page).click();
  await waitForCardInColumn(page, title, 'backlog', 15_000);
});
