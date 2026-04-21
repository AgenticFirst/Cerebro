/**
 * E2E coverage for a manual routine that executes end-to-end.
 *
 * Scenario reproduced:
 *   1. Create a manual-trigger routine with two steps wired together:
 *        Ask AI  →  Send Notification
 *   2. Visit the Routines list; assert the routine is listed and the
 *      "Run Now" button is enabled (isEnabled=true + non-empty dagJson).
 *   3. Subscribe to every engine event via the renderer's onAnyEvent
 *      bridge before clicking Run, so nothing is missed.
 *   4. Click "Run Now" on the card — this drives the real
 *      RoutineContext → ChatContext → engine.run path.
 *   5. Expect the following event sequence for the triggered runId:
 *        run_started
 *        step_started(ask_ai) → step_completed(ask_ai)
 *        step_started(send_notification) → step_completed(send_notification)
 *        run_completed
 *      No run_failed / step_failed anywhere.
 *
 * Requires Cerebro launched with CDP enabled:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 *
 * Also requires Claude Code to be logged in (the Ask AI step calls the
 * CLI). If the login is stale, the test will fail at step_failed with a
 * clear authentication error — the failure mode the user actually wants
 * surfaced, not silently swallowed.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { connectToApp, dismissModals } from './helpers';

const ROUTINE_NAME_PREFIX = 'e2e-routine-';

// ── Types we reuse from the renderer ──────────────────────────

interface ExecutionEventMinimal {
  type: string;
  runId?: string;
  stepId?: string;
  stepName?: string;
  actionType?: string;
  error?: string;
  failedStepId?: string;
  summary?: string;
  reason?: string;
}

interface CreatedRoutine {
  id: string;
  name: string;
  askAiStepId: string;
  notifyStepId: string;
}

// ── Helpers ────────────────────────────────────────────────────

/** Nav to the Routines screen via the sidebar (nav label: "Routines"). */
async function goToRoutines(page: Page): Promise<void> {
  await dismissModals(page);
  await page
    .locator('nav button')
    .filter({ hasText: /^Routines$/ })
    .first()
    .click({ force: true });
  // RoutinesScreen renders the h1 "Routines" as a distinctive marker.
  await page.waitForSelector('h1:has-text("Routines")', { timeout: 10_000 });
}

/** Create a routine via the IPC bridge with a realistic DAG (Ask AI → Send
 *  Notification). Returns the routine + step ids for later assertions. */
async function createManualRoutineWithDag(
  page: Page,
  name: string,
): Promise<CreatedRoutine> {
  return page.evaluate(async (routineName: string) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: {
          method: string;
          path: string;
          body?: unknown;
        }) => Promise<{ ok: boolean; data: unknown; status?: number }>;
      };
    }).cerebro.invoke;

    const askAiId = crypto.randomUUID();
    const notifyId = crypto.randomUUID();

    const dag = {
      steps: [
        {
          id: askAiId,
          name: 'Ask the assistant',
          actionType: 'ask_ai',
          params: {
            prompt:
              'Respond with EXACTLY the three words: hello from cerebro. Do not add anything else.',
          },
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail' as const,
        },
        {
          id: notifyId,
          name: 'Show notification',
          actionType: 'send_notification',
          params: {
            title: 'Cerebro routine ran',
            body: 'AI said: {{ai_reply}}',
          },
          dependsOn: [askAiId],
          inputMappings: [
            {
              sourceStepId: askAiId,
              sourceField: 'response',
              targetField: 'ai_reply',
            },
          ],
          requiresApproval: false,
          onError: 'fail' as const,
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };

    const res = await invoke({
      method: 'POST',
      path: '/routines',
      body: {
        name: routineName,
        description: 'E2E — Ask AI → Desktop notification',
        dag_json: JSON.stringify(dag),
        trigger_type: 'manual',
        is_enabled: true,
        source: 'user',
      },
    });
    if (!res.ok) {
      throw new Error(
        `POST /routines failed (status=${res.status ?? '?'}): ${JSON.stringify(res.data)}`,
      );
    }
    const created = res.data as { id: string; name: string };
    return {
      id: created.id,
      name: created.name,
      askAiStepId: askAiId,
      notifyStepId: notifyId,
    };
  }, name);
}

/** Subscribe to engine.onAnyEvent and accumulate events on window.__ev. The
 *  returned disposer stops the subscription and clears the buffer. */
async function installEventCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface EventWindow extends Window {
      __cerebroEngineEvents?: unknown[];
      __cerebroEngineEventsOff?: () => void;
    }
    const w = window as EventWindow;
    if (w.__cerebroEngineEventsOff) w.__cerebroEngineEventsOff();
    w.__cerebroEngineEvents = [];
    const off = (
      window as unknown as {
        cerebro: {
          engine: { onAnyEvent: (cb: (ev: unknown) => void) => () => void };
        };
      }
    ).cerebro.engine.onAnyEvent((ev) => {
      w.__cerebroEngineEvents!.push(ev);
    });
    w.__cerebroEngineEventsOff = off;
  });
}

/** Read all buffered engine events that belong to a given runId (optional). */
async function readEvents(
  page: Page,
  filter?: { runId?: string },
): Promise<ExecutionEventMinimal[]> {
  return page.evaluate((f: { runId?: string } | undefined) => {
    const all = ((window as unknown) as { __cerebroEngineEvents?: unknown[] })
      .__cerebroEngineEvents ?? [];
    const typed = all as Array<Record<string, unknown>>;
    const filtered = f?.runId
      ? typed.filter((e) => e.runId === f.runId)
      : typed;
    // Narrow to the fields we use in assertions.
    return filtered.map((e) => ({
      type: e.type as string,
      runId: e.runId as string | undefined,
      stepId: e.stepId as string | undefined,
      stepName: e.stepName as string | undefined,
      actionType: e.actionType as string | undefined,
      error: e.error as string | undefined,
      failedStepId: e.failedStepId as string | undefined,
      summary: e.summary as string | undefined,
      reason: e.reason as string | undefined,
    }));
  }, filter);
}

/** Wait until either `run_completed`, `run_failed`, or `run_cancelled` has
 *  been observed — or throw with a diagnostic dump if the timeout fires. */
async function waitForRunSettlement(
  page: Page,
  runId: string,
  timeoutMs: number,
): Promise<ExecutionEventMinimal[]> {
  const deadline = Date.now() + timeoutMs;
  let events: ExecutionEventMinimal[] = [];
  while (Date.now() < deadline) {
    events = await readEvents(page, { runId });
    const terminal = events.find((e) =>
      ['run_completed', 'run_failed', 'run_cancelled'].includes(e.type),
    );
    if (terminal) return events;
    await page.waitForTimeout(300);
  }
  const typesSoFar = events.map((e) => e.type).join(', ') || '(none)';
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for run ${runId} to settle. ` +
      `Events so far: [${typesSoFar}]`,
  );
}

/** Click the "Run Now" button on the RoutineCard for `name`, then extract
 *  the engineRunId the RoutineContext → ChatContext path assigns. */
async function clickRunNowAndGetRunId(page: Page, name: string): Promise<string> {
  const cardText = page.locator(`text=${name}`);
  await expect(cardText.first()).toBeVisible({ timeout: 10_000 });

  // "Run Now" is unique per card footer; scope to the card that contains our name.
  const card = page.locator('div').filter({
    has: page.locator(`text=${name}`),
    hasText: /Run Now/i,
  }).first();

  // Pre-click: snapshot events already buffered so we can find the NEW runId.
  const priorRunIds = new Set(
    (await readEvents(page)).map((e) => e.runId).filter((id): id is string => !!id),
  );

  const runBtn = card.locator('button').filter({ hasText: /^Run Now$/ }).first();
  await expect(runBtn).toBeEnabled({ timeout: 5_000 });
  await runBtn.click();

  // Wait for a fresh run_started event to surface — that carries our runId.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const all = await readEvents(page);
    const started = all.find(
      (e) => e.type === 'run_started' && e.runId && !priorRunIds.has(e.runId),
    );
    if (started?.runId) return started.runId;
    await page.waitForTimeout(150);
  }
  throw new Error(
    'No fresh run_started event observed within 15s after clicking Run Now',
  );
}

/** Remove every routine whose name starts with the e2e prefix. Runs in
 *  afterAll so a failed test doesn't poison the next run. */
async function cleanupRoutines(page: Page): Promise<void> {
  await page.evaluate(async (prefix: string) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string }) => Promise<{
          ok: boolean;
          data: unknown;
        }>;
      };
    }).cerebro.invoke;
    const res = await invoke({ method: 'GET', path: '/routines?limit=200' });
    if (!res.ok) return;
    const body = res.data as { routines: Array<{ id: string; name: string }> };
    for (const r of body.routines ?? []) {
      if (!r.name.startsWith(prefix)) continue;
      await invoke({ method: 'DELETE', path: `/routines/${r.id}` }).catch(
        () => undefined,
      );
    }
  }, ROUTINE_NAME_PREFIX);
}

/** Remove any conversation whose title was created by the legacy "Run Now →
 *  chat" path (titles prefixed with "Run routine: e2e-routine-"). After the
 *  ActivityScreen refactor this path no longer creates conversations, but we
 *  still sweep to clean up state left by earlier runs of the suite. */
async function cleanupConversations(page: Page): Promise<void> {
  await page.evaluate(async (prefix: string) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string }) => Promise<{
          ok: boolean;
          data: unknown;
        }>;
      };
    }).cerebro.invoke;
    const res = await invoke({ method: 'GET', path: '/conversations' });
    if (!res.ok) return;
    const body = res.data as { conversations: Array<{ id: string; title: string }> };
    for (const c of body.conversations ?? []) {
      if (!c.title.startsWith(`Run routine: ${prefix}`)) continue;
      await invoke({ method: 'DELETE', path: `/conversations/${c.id}` }).catch(
        () => undefined,
      );
    }
  }, ROUTINE_NAME_PREFIX);
}

// ── Spec ───────────────────────────────────────────────────────

test.describe('Routines: manual run (Ask AI → Desktop notification)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const connection = await connectToApp();
    browser = connection.browser;
    page = connection.page;
  });

  test.afterAll(async () => {
    try {
      await cleanupRoutines(page);
    } catch {
      // best-effort
    }
    try {
      await cleanupConversations(page);
    } catch {
      // best-effort
    }
    await browser.close().catch(() => undefined);
  });

  test('manual routine with Ask AI + Send Notification runs to completion', async () => {
    const routineName = `${ROUTINE_NAME_PREFIX}${Date.now()}`;

    // 1. Create the routine directly (mirrors what flowToDag would serialize).
    const created = await createManualRoutineWithDag(page, routineName);
    expect(created.id).toBeTruthy();

    // 2. Install the event collector BEFORE navigating / clicking so we don't
    //    miss the initial run_started event.
    await installEventCollector(page);

    // 3. Visit the Routines screen and confirm the card is visible + runnable.
    await goToRoutines(page);
    // Loading the list is async — RoutineContext pulls from /routines on mount.
    await expect(page.locator(`text=${routineName}`).first()).toBeVisible({
      timeout: 10_000,
    });

    // 4. Click "Run Now" — real-user entry point.
    const runId = await clickRunNowAndGetRunId(page, routineName);

    // 5. Wait for the run to settle (completion or failure) and assert success.
    const events = await waitForRunSettlement(page, runId, 5 * 60_000);

    const types = events.map((e) => e.type);
    const failures = events.filter(
      (e) => e.type === 'run_failed' || e.type === 'step_failed',
    );
    const runFailed = events.find((e) => e.type === 'run_failed');
    const runCompleted = events.find((e) => e.type === 'run_completed');

    // Build a failure message with all relevant diagnostics so that if this
    // assertion trips, the user immediately sees WHY — no need to rerun with
    // traces. We check `runCompleted` first because that's the happy path.
    if (!runCompleted) {
      const failureSummaries = failures
        .map((f) => `${f.type}(${f.stepName ?? f.failedStepId ?? 'unknown'}): ${f.error ?? ''}`)
        .join(' | ');
      throw new Error(
        `Routine did not complete. Terminal event: ${runFailed?.type ?? types[types.length - 1] ?? 'none'}. ` +
          `Failures: ${failureSummaries || '(none captured)'}. ` +
          `All events: [${types.join(', ')}]`,
      );
    }

    expect(runCompleted).toBeTruthy();
    expect(runFailed).toBeFalsy();
    expect(failures.length).toBe(0);

    // Step-level sequencing — Ask AI must both start and complete, and
    // Send Notification must both start and complete (and after Ask AI).
    const askStarted = events.find(
      (e) => e.type === 'step_started' && e.stepId === created.askAiStepId,
    );
    const askCompleted = events.find(
      (e) => e.type === 'step_completed' && e.stepId === created.askAiStepId,
    );
    const notifyStarted = events.find(
      (e) => e.type === 'step_started' && e.stepId === created.notifyStepId,
    );
    const notifyCompleted = events.find(
      (e) => e.type === 'step_completed' && e.stepId === created.notifyStepId,
    );

    expect(askStarted, 'ask_ai should emit step_started').toBeTruthy();
    expect(askCompleted, 'ask_ai should emit step_completed').toBeTruthy();
    expect(notifyStarted, 'send_notification should emit step_started').toBeTruthy();
    expect(notifyCompleted, 'send_notification should emit step_completed').toBeTruthy();

    const askCompletedIdx = events.indexOf(askCompleted!);
    const notifyStartedIdx = events.indexOf(notifyStarted!);
    expect(askCompletedIdx).toBeLessThan(notifyStartedIdx);

    // Notification summary should have received the Ask AI reply via the
    // templated {{ai_reply}} wiring — the summary format is
    // `Notification: <title>` (see send-notification.ts). We don't pin the
    // exact title, but we do verify the step emitted a non-empty summary.
    expect(notifyCompleted?.summary ?? '').toMatch(/Notification/i);
  });
});
