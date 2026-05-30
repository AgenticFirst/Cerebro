/**
 * E2E: a routine's `ask_ai` step runs through the Codex engine when Codex is
 * the global default.
 *
 * Routine-engine inference goes through `singleShotActiveEngine`, which resolves
 * the GLOBAL `selected_engine` setting (no per-conversation override) — the same
 * resolution path the channel bridges (Telegram/Slack/etc.) use. So this also
 * transitively exercises the global engine-resolution that inbound-message runs
 * depend on.
 *
 * Requires CEREBRO_E2E_DEBUG_PORT=9229 npm start, plus both CLIs installed and
 * signed in. Skips if Codex isn't detected.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { connectToApp, dismissModals, setSetting } from './helpers';

const CODEX_LOG_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Cerebro', 'logs', 'codex');
const ROUTINE_NAME = `e2e-codex-routine-${Date.now().toString(36)}`;

interface EventMin {
  type: string;
  runId?: string;
  stepName?: string;
  actionType?: string;
  error?: string;
}

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ({ browser, page } = await connectToApp());
  const codexAvailable = await page.evaluate(async () => {
    try {
      const info = await (window as unknown as {
        cerebro: { codex: { getStatus: () => Promise<{ status: string }> } };
      }).cerebro.codex.getStatus();
      return info?.status === 'available';
    } catch {
      return false;
    }
  });
  test.skip(!codexAvailable, 'Codex CLI not detected on host — skipping.');

  // Make Codex the global engine, then reload so RoutineContext + the engine
  // registry's settings reader both observe it.
  await setSetting(page, 'selected_engine', 'codex');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('nav', { timeout: 15_000 });
});

test.afterAll(async () => {
  if (!page) return;
  // Restore default engine and delete the routine we created.
  await setSetting(page, 'selected_engine', 'claude-code').catch(() => {});
  await page.evaluate(async (name: string) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (r: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    const res = await invoke({ method: 'GET', path: '/routines?limit=200' });
    if (!res.ok) return;
    const body = res.data as { routines: Array<{ id: string; name: string }> };
    for (const r of body.routines || []) {
      if (r.name === name) await invoke({ method: 'DELETE', path: `/routines/${r.id}` }).catch(() => {});
    }
  }, ROUTINE_NAME).catch(() => {});
  await browser?.close();
});

function listCodexLogs(): Set<string> {
  try {
    return new Set(fs.readdirSync(CODEX_LOG_DIR).filter((f) => f.endsWith('.log')));
  } catch {
    return new Set();
  }
}

async function installEventCollector(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = window as unknown as { __ev?: unknown[]; __evOff?: () => void };
    if (w.__evOff) w.__evOff();
    w.__ev = [];
    w.__evOff = (window as unknown as {
      cerebro: { engine: { onAnyEvent: (cb: (e: unknown) => void) => () => void } };
    }).cerebro.engine.onAnyEvent((e) => w.__ev!.push(e));
  });
}

async function readEvents(p: Page, runId?: string): Promise<EventMin[]> {
  return p.evaluate((rid: string | undefined) => {
    const all = ((window as unknown as { __ev?: Array<Record<string, unknown>> }).__ev) ?? [];
    const filtered = rid ? all.filter((e) => e.runId === rid) : all;
    return filtered.map((e) => ({
      type: e.type as string,
      runId: e.runId as string | undefined,
      stepName: e.stepName as string | undefined,
      actionType: e.actionType as string | undefined,
      error: e.error as string | undefined,
    }));
  }, runId);
}

async function createCodexRoutine(p: Page, name: string): Promise<void> {
  const err = await p.evaluate(async (routineName: string) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (r: { method: string; path: string; body?: unknown }) => Promise<{ ok: boolean; data: unknown; status?: number }> };
    }).cerebro.invoke;
    const askId = crypto.randomUUID();
    const dag = {
      steps: [
        {
          id: askId,
          name: 'Ask the assistant',
          actionType: 'ask_ai',
          params: { prompt: 'Respond with EXACTLY these two words: routine ok. Nothing else.' },
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };
    const res = await invoke({
      method: 'POST',
      path: '/routines',
      body: {
        name: routineName,
        description: 'E2E — Ask AI under Codex',
        dag_json: JSON.stringify(dag),
        trigger_type: 'manual',
        is_enabled: true,
        source: 'user',
      },
    });
    return res.ok ? null : `POST /routines failed (status=${res.status ?? '?'}): ${JSON.stringify(res.data)}`;
  }, name);
  expect(err, err ?? '').toBeNull();
}

test('a routine ask_ai step runs through the Codex subprocess', async () => {
  await dismissModals(page);
  await installEventCollector(page);
  await createCodexRoutine(page, ROUTINE_NAME);

  // Navigate to Routines so the card mounts; then Run Now.
  await page.locator('nav button').filter({ hasText: /^Routines$/ }).first().click({ force: true });
  await expect(page.locator(`text=${ROUTINE_NAME}`).first()).toBeVisible({ timeout: 10_000 });

  const before = listCodexLogs();
  const priorRunIds = new Set((await readEvents(page)).map((e) => e.runId).filter(Boolean) as string[]);

  const card = page
    .locator('div')
    .filter({ has: page.locator(`text=${ROUTINE_NAME}`), hasText: /Run Now/i })
    .first();
  const runBtn = card.locator('button').filter({ hasText: /^Run Now$/ }).first();
  await expect(runBtn).toBeEnabled({ timeout: 5_000 });
  await runBtn.click();

  // Capture the fresh runId from run_started.
  let runId = '';
  const startDeadline = Date.now() + 15_000;
  while (Date.now() < startDeadline && !runId) {
    const fresh = (await readEvents(page)).find((e) => e.type === 'run_started' && e.runId && !priorRunIds.has(e.runId));
    if (fresh?.runId) runId = fresh.runId;
    await page.waitForTimeout(150);
  }
  expect(runId, 'expected a fresh run_started event').not.toBe('');

  // Wait for the run to settle.
  let events: EventMin[] = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    events = await readEvents(page, runId);
    if (events.some((e) => ['run_completed', 'run_failed', 'run_cancelled'].includes(e.type))) break;
    await page.waitForTimeout(400);
  }

  const types = events.map((e) => e.type);
  expect(types, `events: [${types.join(', ')}]`).toContain('run_completed');
  expect(types).not.toContain('run_failed');
  // The ask_ai step ran to completion (actionType rides on step_started/step_queued).
  expect(types).toContain('step_completed');
  expect(
    events.some((e) => e.actionType === 'ask_ai'),
    `expected an ask_ai step in the run; events: [${types.join(', ')}]`,
  ).toBe(true);

  // Ground truth: singleShotCodex wrote a fresh singleshot-*.log → the codex
  // subprocess (not Claude) executed the routine's inference step.
  const after = listCodexLogs();
  const newLogs = [...after].filter((f) => !before.has(f) && f.startsWith('singleshot-'));
  expect(
    newLogs.length,
    'expected a new logs/codex/singleshot-*.log from the Codex routine step',
  ).toBeGreaterThanOrEqual(1);
});
