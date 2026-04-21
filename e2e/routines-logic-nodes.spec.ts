/**
 * E2E coverage for the Logic-category routine nodes.
 *
 * Scenarios (numbering matches docs/test-plans/logic-nodes.md):
 *   C-E1   condition branching: only the TRUE branch executes.
 *   L-E1   loop surfaces items + count for downstream templating.
 *   D-E1   delay emits delayed_ms ≥ configured + completed_at ISO.
 *   A-E1   approval_gate: approve → run completes.
 *   A-E2   approval_gate: deny → run_failed with "Approval denied".
 *   W-E1   wait_for_webhook: register → external POST → run completes with payload.
 *   S-E1   run_script JavaScript sandbox returns computed output.
 *   S-E2   run_script Python delegates to backend and returns output.
 *
 * Requires Cerebro launched with CDP enabled:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 *
 * LLM calls are intentionally absent here — every node in scope is
 * deterministic so tests run fast and don't burn Claude Code budget.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { connectToApp } from './helpers';

const ROUTINE_NAME_PREFIX = 'e2e-logic-';
const RUN_SETTLE_TIMEOUT_MS = 60_000;

interface ExecutionEventMinimal {
  type: string;
  runId?: string;
  stepId?: string;
  stepName?: string;
  approvalId?: string;
  error?: string;
  failedStepId?: string;
  summary?: string;
  data?: unknown;
}

interface CreatedRoutine {
  id: string;
  stepIds: Record<string, string>;
}

// ── IPC bridge helpers ────────────────────────────────────────

async function cerebroInvoke<T>(
  page: Page,
  req: { method: string; path: string; body?: unknown },
): Promise<{ ok: boolean; data: T; status?: number }> {
  return page.evaluate(async (input) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (r: typeof input) => Promise<{ ok: boolean; data: unknown; status?: number }> };
    }).cerebro.invoke;
    return invoke(input) as Promise<{ ok: boolean; data: unknown; status?: number }>;
  }, req) as Promise<{ ok: boolean; data: T; status?: number }>;
}

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
        cerebro: { engine: { onAnyEvent: (cb: (ev: unknown) => void) => () => void } };
      }
    ).cerebro.engine.onAnyEvent((ev) => {
      w.__cerebroEngineEvents!.push(ev);
    });
    w.__cerebroEngineEventsOff = off;
  });
}

async function readEvents(
  page: Page,
  filter?: { runId?: string },
): Promise<ExecutionEventMinimal[]> {
  return page.evaluate((f: { runId?: string } | undefined) => {
    const all = (window as unknown as { __cerebroEngineEvents?: unknown[] }).__cerebroEngineEvents ?? [];
    const typed = all as Array<Record<string, unknown>>;
    const filtered = f?.runId ? typed.filter((e) => e.runId === f.runId) : typed;
    return filtered.map((e) => ({
      type: e.type as string,
      runId: e.runId as string | undefined,
      stepId: e.stepId as string | undefined,
      stepName: e.stepName as string | undefined,
      approvalId: e.approvalId as string | undefined,
      error: e.error as string | undefined,
      failedStepId: e.failedStepId as string | undefined,
      summary: e.summary as string | undefined,
      data: e.data,
    }));
  }, filter);
}

async function waitForRunSettlement(
  page: Page,
  runId: string,
  timeoutMs: number,
): Promise<ExecutionEventMinimal[]> {
  const deadline = Date.now() + timeoutMs;
  let events: ExecutionEventMinimal[] = [];
  while (Date.now() < deadline) {
    events = await readEvents(page, { runId });
    const terminal = events.find((e) => ['run_completed', 'run_failed', 'run_cancelled'].includes(e.type));
    if (terminal) return events;
    await page.waitForTimeout(300);
  }
  const typesSoFar = events.map((e) => e.type).join(', ') || '(none)';
  throw new Error(`Timed out waiting for run ${runId}. Events so far: [${typesSoFar}]`);
}

/** Wait for a specific event type on the given runId, with a short timeout. */
async function waitForEvent(
  page: Page,
  runId: string,
  eventType: string,
  timeoutMs = 15_000,
): Promise<ExecutionEventMinimal> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await readEvents(page, { runId });
    const found = events.find((e) => e.type === eventType);
    if (found) return found;
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for event "${eventType}" on run ${runId}`);
}

// ── Routine + run helpers ─────────────────────────────────────

interface StepSpec {
  key: string;
  actionType: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  inputMappings?: Array<{
    sourceStepId: string;
    sourceField: string;
    targetField: string;
    branchCondition?: 'true' | 'false';
  }>;
  requiresApproval?: boolean;
}

async function createManualRoutine(
  page: Page,
  name: string,
  steps: StepSpec[],
): Promise<CreatedRoutine> {
  const idByKey: Record<string, string> = {};
  for (const s of steps) {
    idByKey[s.key] = await page.evaluate(() => crypto.randomUUID());
  }

  const dagSteps = steps.map((s) => ({
    id: idByKey[s.key],
    name: s.key,
    actionType: s.actionType,
    params: s.params ?? {},
    dependsOn: (s.dependsOn ?? []).map((k) => idByKey[k]),
    inputMappings: (s.inputMappings ?? []).map((m) => ({
      sourceStepId: idByKey[m.sourceStepId],
      sourceField: m.sourceField,
      targetField: m.targetField,
      ...(m.branchCondition ? { branchCondition: m.branchCondition } : {}),
    })),
    requiresApproval: s.requiresApproval ?? false,
    onError: 'fail' as const,
  }));

  const dag = { steps: dagSteps, trigger: { triggerType: 'trigger_manual', config: {} } };

  const res = await cerebroInvoke<{ id: string }>(page, {
    method: 'POST',
    path: '/routines',
    body: {
      name,
      description: 'E2E logic node',
      dag_json: JSON.stringify(dag),
      trigger_type: 'manual',
      is_enabled: true,
      source: 'user',
    },
  });
  if (!res.ok) throw new Error(`POST /routines failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.id, stepIds: idByKey };
}

async function runRoutine(page: Page, routineId: string): Promise<string> {
  const fetched = await cerebroInvoke<{ id: string; dag_json: string | null }>(page, {
    method: 'GET',
    path: `/routines/${routineId}`,
  });
  if (!fetched.ok || !fetched.data.dag_json) {
    throw new Error(`Could not load routine DAG: ${JSON.stringify(fetched.data)}`);
  }
  const dag = JSON.parse(fetched.data.dag_json);

  return page.evaluate(
    async ({ dag, routineId }) => {
      const engineRun = (
        window as unknown as {
          cerebro: {
            engine: {
              run: (req: { dag: unknown; routineId?: string; triggerSource?: string }) => Promise<string>;
            };
          };
        }
      ).cerebro.engine.run;
      return engineRun({ dag, routineId, triggerSource: 'manual' });
    },
    { dag, routineId },
  );
}

async function getStepOutputs(page: Page, runId: string): Promise<Record<string, unknown>> {
  const res = await cerebroInvoke<{ steps: Array<{ step_id: string; output_json: string | null; status: string }> }>(
    page,
    { method: 'GET', path: `/engine/runs/${runId}` },
  );
  if (!res.ok) throw new Error(`GET /engine/runs/${runId} failed: ${JSON.stringify(res.data)}`);
  const map: Record<string, unknown> = {};
  for (const s of res.data.steps || []) {
    if (s.output_json) {
      try {
        map[s.step_id] = JSON.parse(s.output_json);
      } catch {
        map[s.step_id] = s.output_json;
      }
    }
  }
  return map;
}

async function getStepStatuses(page: Page, runId: string): Promise<Record<string, string>> {
  const res = await cerebroInvoke<{ steps: Array<{ step_id: string; status: string }> }>(
    page,
    { method: 'GET', path: `/engine/runs/${runId}` },
  );
  if (!res.ok) throw new Error(`GET /engine/runs/${runId} failed: ${JSON.stringify(res.data)}`);
  const map: Record<string, string> = {};
  for (const s of res.data.steps || []) map[s.step_id] = s.status;
  return map;
}

function assertRunCompleted(events: ExecutionEventMinimal[]): void {
  const failed = events.find((e) => e.type === 'run_failed' || e.type === 'step_failed');
  const completed = events.find((e) => e.type === 'run_completed');
  if (!completed) {
    const why = failed
      ? `${failed.type}(${failed.stepName ?? failed.failedStepId ?? '?'}): ${failed.error ?? ''}`
      : 'no terminal';
    throw new Error(`Run did not complete: ${why}. Events: [${events.map((e) => e.type).join(', ')}]`);
  }
  expect(failed).toBeFalsy();
}

async function cleanupRoutines(page: Page): Promise<void> {
  await page.evaluate(async (prefix: string) => {
    const invoke = (window as unknown as {
      cerebro: {
        invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }>;
      };
    }).cerebro.invoke;
    const res = await invoke({ method: 'GET', path: '/routines?limit=200' });
    if (!res.ok) return;
    const body = res.data as { routines: Array<{ id: string; name: string }> };
    for (const r of body.routines ?? []) {
      if (!r.name.startsWith(prefix)) continue;
      await invoke({ method: 'DELETE', path: `/routines/${r.id}` }).catch(() => undefined);
    }
  }, ROUTINE_NAME_PREFIX);
}

// ── Spec ──────────────────────────────────────────────────────

test.describe('Routines: logic nodes (condition, loop, delay, approval, webhook, script)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    const connection = await connectToApp();
    browser = connection.browser;
    page = connection.page;
    await installEventCollector(page);
  });

  test.afterAll(async () => {
    try {
      await cleanupRoutines(page);
    } catch {
      // best-effort
    }
    await browser.close().catch(() => undefined);
  });

  // ── C-E1 — condition branching ───────────────────────────────
  //
  // `condition` with `is_empty` on a missing field evaluates to TRUE — the
  // routine has no upstream wiring so `wiredInputs.missing` is undefined,
  // so `branch` = 'true'. The TRUE branch must complete; the FALSE branch
  // must be pruned (not executed).
  test('C-E1 condition branching — only the TRUE branch executes', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}cond-${Date.now()}`, [
      {
        key: 'cond',
        actionType: 'condition',
        params: { field: 'missing', operator: 'is_empty' },
      },
      {
        key: 'true_branch',
        actionType: 'run_script',
        params: {
          language: 'javascript',
          code: 'output.ran = "true";',
          timeout: 5,
        },
        dependsOn: ['cond'],
        inputMappings: [
          { sourceStepId: 'cond', sourceField: 'branch', targetField: 'b', branchCondition: 'true' },
        ],
      },
      {
        key: 'false_branch',
        actionType: 'run_script',
        params: {
          language: 'javascript',
          code: 'output.ran = "false";',
          timeout: 5,
        },
        dependsOn: ['cond'],
        inputMappings: [
          { sourceStepId: 'cond', sourceField: 'branch', targetField: 'b', branchCondition: 'false' },
        ],
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const statuses = await getStepStatuses(page, runId);
    expect(statuses[routine.stepIds.true_branch]).toBe('completed');
    expect(statuses[routine.stepIds.false_branch]).toBe('skipped');
  });

  // ── L-E1 — loop exposes items + count ────────────────────────
  //
  // run_script seeds an array, loop extracts it. This is the DAG shape the
  // UI generates for a "split this list into N parallel runs" pattern.
  test('L-E1 loop — exposes items[], count, variable_name for downstream templating', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}loop-${Date.now()}`, [
      {
        key: 'produce',
        actionType: 'run_script',
        params: {
          language: 'javascript',
          code: 'output.fruits = [1, 2, 3];',
          timeout: 5,
        },
      },
      {
        key: 'loop',
        actionType: 'loop',
        params: { items_field: 'fruits', variable_name: 'fruit' },
        dependsOn: ['produce'],
        inputMappings: [
          { sourceStepId: 'produce', sourceField: 'result.fruits', targetField: 'fruits' },
        ],
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const loopOut = outputs[routine.stepIds.loop] as {
      items: unknown[];
      count: number;
      variable_name: string;
    };
    expect(loopOut.items).toEqual([1, 2, 3]);
    expect(loopOut.count).toBe(3);
    expect(loopOut.variable_name).toBe('fruit');
  });

  // ── D-E1 — delay honours configured duration ─────────────────
  test('D-E1 delay — emits delayed_ms and ISO completed_at', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}delay-${Date.now()}`, [
      {
        key: 'd',
        actionType: 'delay',
        params: { duration: 0.2, unit: 'seconds' },
      },
    ]);

    const t0 = Date.now();
    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150); // 0.2s target — allow slight timer slack

    const outputs = await getStepOutputs(page, runId);
    const d = outputs[routine.stepIds.d] as { delayed_ms: number; completed_at: string };
    expect(d.delayed_ms).toBe(200);
    expect(d.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(new Date(d.completed_at).getTime())).toBe(false);
  });

  // ── A-E1 — approval_gate approve ─────────────────────────────
  test('A-E1 approval_gate — approve resumes the run to completion', async () => {
    const AUTHORED = 'Please review before continuing.';
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}appr-ok-${Date.now()}`, [
      {
        key: 'gate',
        actionType: 'approval_gate',
        params: { summary: AUTHORED },
        requiresApproval: true,
      },
    ]);

    const runId = await runRoutine(page, routine.id);

    // Wait for the approval_requested event — the run is paused.
    const approvalEv = await waitForEvent(page, runId, 'approval_requested', 10_000);
    expect(approvalEv.summary).toBe(AUTHORED);
    expect(approvalEv.approvalId).toBeTruthy();

    // Approve through the renderer bridge — same path the Approvals UI uses.
    // This calls ExecutionEngine.resolveApproval(id, true) in the main process,
    // which both resolves the pending Promise and persists the decision.
    const approvalId = approvalEv.approvalId!;
    await page.evaluate(async (id: string) => {
      await (window as unknown as {
        cerebro: { engine: { approve: (id: string) => Promise<boolean> } };
      }).cerebro.engine.approve(id);
    }, approvalId);

    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);
  });

  // ── A-E2 — approval_gate deny ────────────────────────────────
  test('A-E2 approval_gate — deny fails the run with "Approval denied"', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}appr-deny-${Date.now()}`, [
      {
        key: 'gate',
        actionType: 'approval_gate',
        params: { summary: 'Deny me' },
        requiresApproval: true,
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const approvalEv = await waitForEvent(page, runId, 'approval_requested', 10_000);
    const approvalId = approvalEv.approvalId!;

    await page.evaluate(async (id: string) => {
      await (window as unknown as {
        cerebro: { engine: { deny: (id: string, reason?: string) => Promise<boolean> } };
      }).cerebro.engine.deny(id, 'e2e deny');
    }, approvalId);

    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    const failed = events.find((e) => e.type === 'run_failed' || e.type === 'step_failed');
    expect(failed).toBeDefined();
    // Denial surfaces as "Approval denied" per approval-gate test contract.
    const errorText = failed?.error ?? '';
    expect(errorText).toMatch(/Approval denied|denied/i);
  });

  // ── W-E1 — wait_for_webhook round-trip ──────────────────────
  test('W-E1 wait_for_webhook — external POST resumes the run with payload', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}wh-${Date.now()}`, [
      {
        key: 'wh',
        actionType: 'wait_for_webhook',
        params: { match_path: '/stripe', timeout: 60 },
      },
    ]);

    const runId = await runRoutine(page, routine.id);

    // The action POSTs /webhooks/listen during step_started. Wait for the
    // step to start so we know the listener is registered.
    await waitForEvent(page, runId, 'step_started', 10_000);

    // Discover the listener the action registered by listing active listeners
    // on the backend. We match by `match_path` since we set it uniquely above.
    let listenerId: string | null = null;
    const listDeadline = Date.now() + 10_000;
    while (Date.now() < listDeadline) {
      const listRes = await cerebroInvoke<{ listeners: Array<{ listener_id: string; match_path: string }> }>(page, {
        method: 'GET',
        path: '/webhooks/listen',
      });
      if (listRes.ok) {
        const match = listRes.data.listeners?.find((l) => l.match_path === '/stripe');
        if (match) {
          listenerId = match.listener_id;
          break;
        }
      }
      await page.waitForTimeout(200);
    }
    expect(listenerId, 'wait_for_webhook should register a listener that appears in GET /webhooks/listen').toBeTruthy();

    // Fire a POST at the catch endpoint — the in-process backend picks it up
    // and the run's poll loop sees `received: true` on the next iteration.
    const fireRes = await cerebroInvoke(page, {
      method: 'POST',
      path: `/webhooks/catch/${listenerId}`,
      body: { event: 'signed', order_id: 42 },
    });
    expect(fireRes.ok).toBe(true);

    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const wh = outputs[routine.stepIds.wh] as { payload: Record<string, unknown>; received_at: string };
    expect(wh.payload).toEqual({ event: 'signed', order_id: 42 });
    expect(wh.received_at).toBeTruthy();
  });

  // ── S-E1 — run_script JavaScript ────────────────────────────
  test('S-E1 run_script — JavaScript executes in sandbox and returns output', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}js-${Date.now()}`, [
      {
        key: 's',
        actionType: 'run_script',
        params: {
          language: 'javascript',
          // No wiredInputs needed — compute a fixed value inside the sandbox.
          code: 'output.answer = 6 * 7;',
          timeout: 5,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const s = outputs[routine.stepIds.s] as { result: { answer: number }; duration_ms: number };
    expect(s.result.answer).toBe(42);
    expect(s.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ── S-E2 — run_script Python delegation ─────────────────────
  test('S-E2 run_script — Python delegates to backend and returns output', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}py-${Date.now()}`, [
      {
        key: 's',
        actionType: 'run_script',
        params: {
          language: 'python',
          code: 'output["sum"] = sum([1, 2, 3, 4])',
          timeout: 10,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const s = outputs[routine.stepIds.s] as { result: { sum: number } };
    expect(s.result.sum).toBe(10);
  });
});
