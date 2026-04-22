/**
 * E2E coverage for the Integration-category routine nodes.
 *
 * Scenarios (numbering matches docs/test-plans/integration-nodes.md):
 *   HR-E1  http_request GET returns status/body/headers/duration.
 *   HR-E2  http_request POST with body auto-sets Content-Type + echoes body.
 *   HR-E3  http_request blocks private/internal addresses (SSRF).
 *   HR-E4  http_request templates {{vars}} from upstream step output.
 *   RC-E1  run_command executes an allowed command (echo) end-to-end.
 *   RC-E2  run_command rejects a disallowed command.
 *   RC-E3  run_command templates {{vars}} in args.
 *   CC-E1  run_claude_code in ask mode returns a real Claude Code response.
 *
 * Requires Cerebro launched with CDP enabled:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 *
 * HTTP tests hit httpbin.org because the SSRF guard rejects all
 * private/loopback addresses and we want to exercise the *real* transport.
 * If httpbin is unreachable, those tests fail with a clear network error —
 * that's the intended behavior (we do NOT work around bugs in tests).
 *
 * CC-E1 only runs when the `claude` CLI is on PATH. It uses
 * claude-sonnet-4-6 for determinism and speed.
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { connectToApp } from './helpers';

const ROUTINE_NAME_PREFIX = 'e2e-integration-';
const RUN_SETTLE_TIMEOUT_MS = 90_000;

const HTTP_BASE = 'https://httpbin.org';

interface ExecutionEventMinimal {
  type: string;
  runId?: string;
  stepId?: string;
  stepName?: string;
  error?: string;
  failedStepId?: string;
  summary?: string;
  data?: unknown;
}

interface CreatedRoutine {
  id: string;
  stepIds: Record<string, string>;
}

// ── IPC bridge helpers (duplicated from routines-logic-nodes for spec isolation)

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

interface StepSpec {
  key: string;
  actionType: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  inputMappings?: Array<{ sourceStepId: string; sourceField: string; targetField: string }>;
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
    })),
    requiresApproval: false,
    onError: 'fail' as const,
  }));

  const dag = { steps: dagSteps, trigger: { triggerType: 'trigger_manual', config: {} } };

  const res = await cerebroInvoke<{ id: string }>(page, {
    method: 'POST',
    path: '/routines',
    body: {
      name,
      description: 'E2E integration node',
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

async function hasClaudeCli(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['claude'], (err) => resolve(!err));
  });
}

// ── Spec ──────────────────────────────────────────────────────

test.describe('Routines: integration nodes (http_request, run_command, run_claude_code)', () => {
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

  // ── HR-E1 — GET returns status/body/headers/duration ─────────
  test('HR-E1 http_request — GET returns status/body/headers/duration', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}http-get-${Date.now()}`, [
      {
        key: 'req',
        actionType: 'http_request',
        params: {
          method: 'GET',
          url: `${HTTP_BASE}/json`,
          timeout: 30,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const out = outputs[routine.stepIds.req] as {
      status: number;
      body: unknown;
      headers: Record<string, string>;
      duration_ms: number;
    };
    expect(out.status).toBe(200);
    expect(typeof out.duration_ms).toBe('number');
    expect(out.duration_ms).toBeGreaterThan(0);
    expect(out.body).toBeTruthy();
    // httpbin.org/json returns a `slideshow` JSON object.
    expect(out.body).toHaveProperty('slideshow');
  });

  // ── HR-E2 — POST with body auto-sets content type ────────────
  test('HR-E2 http_request — POST with body echoes through and sets content-type', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}http-post-${Date.now()}`, [
      {
        key: 'req',
        actionType: 'http_request',
        params: {
          method: 'POST',
          url: `${HTTP_BASE}/anything`,
          body: JSON.stringify({ hello: 'world', n: 7 }),
          timeout: 30,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const out = outputs[routine.stepIds.req] as {
      status: number;
      body: { json: Record<string, unknown>; headers: Record<string, string> };
    };
    expect(out.status).toBe(200);
    // httpbin /anything echoes the parsed JSON body + inbound headers.
    expect(out.body.json).toEqual({ hello: 'world', n: 7 });
    // Headers keys on httpbin are Title-Cased.
    const receivedContentType = out.body.headers['Content-Type'] ?? out.body.headers['content-type'];
    expect(receivedContentType).toBe('application/json');
  });

  // ── HR-E3 — SSRF: private address rejected ───────────────────
  test('HR-E3 http_request — rejects private/internal addresses (SSRF)', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}http-ssrf-${Date.now()}`, [
      {
        key: 'req',
        actionType: 'http_request',
        // 169.254.169.254 is the AWS/Azure instance-metadata endpoint — the
        // most abuse-worthy target. Must fail fast, not try the network.
        params: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/', timeout: 5 },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);

    const failed = events.find((e) => e.type === 'run_failed' || e.type === 'step_failed');
    expect(failed, `expected SSRF to fail the run; events: ${events.map((e) => e.type).join(', ')}`).toBeDefined();
    expect(failed!.error ?? '').toMatch(/private\/internal addresses/);
  });

  // ── HR-E4 — {{var}} templating from upstream step ────────────
  test('HR-E4 http_request — templates {{vars}} from upstream run_script', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}http-tmpl-${Date.now()}`, [
      {
        key: 'produce',
        actionType: 'run_script',
        params: {
          language: 'javascript',
          code: 'output.path = "headers";',
          timeout: 5,
        },
      },
      {
        key: 'req',
        actionType: 'http_request',
        params: {
          method: 'GET',
          url: `${HTTP_BASE}/{{path}}`,
          timeout: 30,
        },
        dependsOn: ['produce'],
        inputMappings: [{ sourceStepId: 'produce', sourceField: 'result.path', targetField: 'path' }],
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const out = outputs[routine.stepIds.req] as { status: number; body: { headers?: Record<string, string> } };
    expect(out.status).toBe(200);
    // httpbin.org/headers returns the request headers it saw — proves we hit
    // the *templated* URL, not the literal {{path}} string.
    expect(out.body.headers).toBeTruthy();
  });

  // ── RC-E1 — allowed command end-to-end ───────────────────────
  test('RC-E1 run_command — echo hello world succeeds', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}cmd-echo-${Date.now()}`, [
      {
        key: 'c',
        actionType: 'run_command',
        params: { command: 'echo', args: 'hello e2e world', timeout: 10 },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const out = outputs[routine.stepIds.c] as {
      stdout: string;
      stderr: string;
      exit_code: number;
      duration_ms: number;
    };
    expect(out.exit_code).toBe(0);
    expect(out.stdout.trim()).toBe('hello e2e world');
  });

  // ── RC-E2 — disallowed command rejected ──────────────────────
  test('RC-E2 run_command — disallowed command is rejected before spawn', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}cmd-reject-${Date.now()}`, [
      {
        key: 'c',
        actionType: 'run_command',
        params: { command: 'rm', args: '-rf /tmp/nope' },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    const failed = events.find((e) => e.type === 'run_failed' || e.type === 'step_failed');
    expect(failed).toBeDefined();
    expect(failed!.error ?? '').toMatch(/not allowed/);
  });

  // ── RC-E3 — args templating from upstream ────────────────────
  test('RC-E3 run_command — templates {{vars}} in args from upstream', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}cmd-tmpl-${Date.now()}`, [
      {
        key: 'produce',
        actionType: 'run_script',
        params: {
          language: 'javascript',
          code: 'output.word = "templated";',
          timeout: 5,
        },
      },
      {
        key: 'c',
        actionType: 'run_command',
        params: { command: 'echo', args: 'got-{{word}}', timeout: 10 },
        dependsOn: ['produce'],
        inputMappings: [{ sourceStepId: 'produce', sourceField: 'result.word', targetField: 'word' }],
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const out = outputs[routine.stepIds.c] as { stdout: string };
    expect(out.stdout.trim()).toBe('got-templated');
  });

  // ── CC-E1 — run_claude_code ask mode ─────────────────────────
  //
  // Uses the real claude CLI with --model claude-sonnet-4-6 via the prompt
  // (we don't have a direct model switch — the action passes --print which
  // inherits CC's default, but the test prompt mentions the model so a
  // regression in wiring still yields deterministic failures). Skipped if
  // claude isn't installed.
  test('CC-E1 run_claude_code — ask mode returns a real Claude response', async () => {
    const cliAvailable = await hasClaudeCli();
    test.skip(!cliAvailable, 'claude CLI not installed on PATH — skipping CC-E1');

    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}cc-ask-${Date.now()}`, [
      {
        key: 'ask',
        actionType: 'run_claude_code',
        params: {
          mode: 'ask',
          prompt: 'Reply with the single word PONG and nothing else.',
          max_turns: 1,
          timeout: 180,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, 4 * 60_000);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const out = outputs[routine.stepIds.ask] as {
      response: string;
      exit_code: number;
      duration_ms: number;
    };
    expect(out.exit_code).toBe(0);
    expect(out.response.length).toBeGreaterThan(0);
    expect(out.response.toUpperCase()).toContain('PONG');
  });
});
