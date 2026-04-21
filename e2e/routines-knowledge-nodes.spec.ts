/**
 * E2E coverage for the four Knowledge-category routine nodes.
 *
 * Each scenario drives a real routine to completion through the Cerebro
 * app (ExecutionEngine + Claude Code CLI + backend file store). Runs are
 * triggered via the same IPC path the UI uses, and assertions read the
 * resulting run state / file-store contents.
 *
 * Scenarios:
 *   SM-E1 + STM-E1 (paired)  save_to_memory writes a file, search_memory
 *                            then finds it in the same run.
 *   SW-E1                    search_web returns at least one result for
 *                            a real query.
 *   SD-E1                    search_documents pulls an answer out of a
 *                            bucket containing a known text file.
 *   STM-E2                   save_to_memory extract-mode distills raw
 *                            text into bullets before writing.
 *
 * All steps pin `model: "claude-sonnet-4-6"` so the test is deterministic
 * across model-family changes and matches the project's "Sonnet for
 * knowledge routines" rule.
 *
 * Requires Cerebro launched with CDP enabled:
 *   CEREBRO_E2E_DEBUG_PORT=9229 npm start
 * and Claude Code logged in (real inference path).
 */

import { test, expect, type Browser, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectToApp } from './helpers';

const ROUTINE_NAME_PREFIX = 'e2e-knowledge-';
const BUCKET_NAME_PREFIX = 'e2e-knowledge-bucket-';
const SONNET_MODEL = 'claude-sonnet-4-6';
const E2E_SLUG = 'cerebro';
const RUN_SETTLE_TIMEOUT_MS = 5 * 60_000;

interface ExecutionEventMinimal {
  type: string;
  runId?: string;
  stepId?: string;
  stepName?: string;
  error?: string;
  failedStepId?: string;
  summary?: string;
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
      error: e.error as string | undefined,
      failedStepId: e.failedStepId as string | undefined,
      summary: e.summary as string | undefined,
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
    await page.waitForTimeout(400);
  }
  const typesSoFar = events.map((e) => e.type).join(', ') || '(none)';
  throw new Error(`Timed out waiting for run ${runId}. Events so far: [${typesSoFar}]`);
}

// ── Routine + run helpers ─────────────────────────────────────

/** Build a manual-trigger routine DAG with the given steps and create it. */
async function createManualRoutine(
  page: Page,
  name: string,
  steps: Array<{
    key: string;
    actionType: string;
    params: Record<string, unknown>;
    dependsOn?: string[];
    inputMappings?: Array<{ sourceStepId: string; sourceField: string; targetField: string }>;
  }>,
): Promise<CreatedRoutine> {
  // Generate one UUID per "key" so we can cross-reference event stepIds after the run.
  const idByKey: Record<string, string> = {};
  for (const s of steps) {
    idByKey[s.key] = await page.evaluate(() => crypto.randomUUID());
  }

  const dagSteps = steps.map((s) => ({
    id: idByKey[s.key],
    name: s.key,
    actionType: s.actionType,
    params: s.params,
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
      description: 'E2E knowledge node',
      dag_json: JSON.stringify(dag),
      trigger_type: 'manual',
      is_enabled: true,
      source: 'user',
    },
  });
  if (!res.ok) throw new Error(`POST /routines failed: ${JSON.stringify(res.data)}`);
  return { id: res.data.id, stepIds: idByKey };
}

/** Start a manual run via the same engine-run IPC the UI uses. The backend
 *  `POST /routines/{id}/run` endpoint only updates metadata — it does NOT
 *  execute. Real execution lives in the Electron main process via
 *  `window.cerebro.engine.run({ dag, routineId, triggerSource })`. */
async function runRoutine(page: Page, routineId: string): Promise<string> {
  // Load the stored DAG so we can hand the engine the exact DAG it expects.
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
              run: (req: {
                dag: unknown;
                routineId?: string;
                triggerSource?: string;
              }) => Promise<string>;
            };
          };
        }
      ).cerebro.engine.run;
      return engineRun({ dag, routineId, triggerSource: 'manual' });
    },
    { dag, routineId },
  );
}

/** Fetch persisted step records for a completed run and return an output map keyed by stepId. */
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
    const why = failed ? `${failed.type}(${failed.stepName ?? failed.failedStepId ?? '?'}): ${failed.error ?? ''}` : 'no terminal';
    throw new Error(`Run did not complete: ${why}. Events: [${events.map((e) => e.type).join(', ')}]`);
  }
  expect(failed).toBeFalsy();
}

// ── Backend data helpers (buckets, memory) ──────────────────

interface CreatedBucket { id: string; fileId: string; absPath: string }

async function createBucketWithTextFile(
  page: Page,
  bucketName: string,
  fileName: string,
  fileContent: string,
): Promise<CreatedBucket> {
  const bucket = await cerebroInvoke<{ id: string }>(page, {
    method: 'POST',
    path: '/files/buckets',
    body: { name: bucketName, color: '#4F46E5', icon: 'folder', is_pinned: false },
  });
  if (!bucket.ok) throw new Error(`create bucket: ${JSON.stringify(bucket.data)}`);

  // The Cerebro backend runs on the same machine as the Playwright runner, so
  // we can write the test file directly from the test process. Using workspace
  // storage_kind means the backend returns this abs path verbatim — no
  // managed-files root resolution.
  const absPath = `/tmp/cerebro-e2e/${bucketName}/${fileName}`;
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, fileContent, 'utf8');

  const item = await cerebroInvoke<{ id: string }>(page, {
    method: 'POST',
    path: '/files/items',
    body: {
      bucket_id: bucket.data.id,
      name: fileName,
      ext: fileName.split('.').pop() ?? 'txt',
      mime: 'text/plain',
      size_bytes: Buffer.byteLength(fileContent, 'utf8'),
      sha256: null,
      storage_kind: 'workspace',
      storage_path: absPath,
      source: 'workspace-save',
    },
  });
  if (!item.ok) throw new Error(`create file item: ${JSON.stringify(item.data)}`);

  return { id: bucket.data.id, fileId: item.data.id, absPath };
}

/** Read the text content of a file in an agent's memory directory. */
async function readAgentMemoryFile(page: Page, agent: string, relPath: string): Promise<string | null> {
  const res = await cerebroInvoke<{ content: string }>(page, {
    method: 'GET',
    path: `/agent-memory/${encodeURIComponent(agent)}/files/${relPath.split('/').map(encodeURIComponent).join('/')}`,
  });
  return res.ok ? res.data.content : null;
}

// ── Cleanup ───────────────────────────────────────────────────

async function cleanupRoutines(page: Page): Promise<void> {
  await page.evaluate(async (prefix: string) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    const list = await invoke({ method: 'GET', path: '/routines?limit=200' });
    if (!list.ok) return;
    const body = list.data as { routines: Array<{ id: string; name: string }> };
    for (const r of body.routines ?? []) {
      if (!r.name.startsWith(prefix)) continue;
      await invoke({ method: 'DELETE', path: `/routines/${r.id}` }).catch(() => undefined);
    }
  }, ROUTINE_NAME_PREFIX);
}

async function cleanupBuckets(page: Page): Promise<void> {
  await page.evaluate(async (prefix: string) => {
    const invoke = (window as unknown as {
      cerebro: { invoke: (req: { method: string; path: string }) => Promise<{ ok: boolean; data: unknown }> };
    }).cerebro.invoke;
    const list = await invoke({ method: 'GET', path: '/files/buckets' });
    if (!list.ok) return;
    const buckets = list.data as Array<{ id: string; name: string }>;
    for (const b of buckets) {
      if (!b.name.startsWith(prefix)) continue;
      await invoke({ method: 'DELETE', path: `/files/buckets/${b.id}` }).catch(() => undefined);
    }
  }, BUCKET_NAME_PREFIX);
}

// ── Suite ─────────────────────────────────────────────────────

test.describe('Routines: knowledge nodes (Sonnet)', () => {
  let browser: Browser;
  let page: Page;

  test.beforeAll(async () => {
    ({ browser, page } = await connectToApp());
    await installEventCollector(page);
  });

  test.afterAll(async () => {
    try { await cleanupRoutines(page); } catch { /* best-effort */ }
    try { await cleanupBuckets(page); } catch { /* best-effort */ }
    await browser.close().catch(() => undefined);
  });

  // SM-E1 + STM-E1: paired save → search roundtrip on the same memory slug.
  test('STM-E1 + SM-E1: save_to_memory then search_memory round-trips through Claude Code', async () => {
    const marker = `CEREBRO-E2E-MARKER-${Date.now()}`;
    const content = `Carlos prefers to be greeted with "hola amigo" in the mornings. Magic test marker: ${marker}.`;

    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}save-search-${Date.now()}`, [
      {
        key: 'save',
        actionType: 'save_to_memory',
        params: { content, agent: E2E_SLUG, mode: 'write', topic: 'e2e-preferences', model: SONNET_MODEL },
      },
      {
        key: 'search',
        actionType: 'search_memory',
        params: { query: `marker ${marker} preferences`, agent: E2E_SLUG, max_results: 5, model: SONNET_MODEL },
        dependsOn: ['save'],
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const saveOut = outputs[routine.stepIds['save']] as { saved: boolean; item_id: string };
    expect(saveOut.saved).toBe(true);
    expect(saveOut.item_id).toMatch(new RegExp(`^${E2E_SLUG}:routines/`));

    // Verify the markdown file actually exists with our marker in it.
    const [, relPath] = saveOut.item_id.split(':');
    const fileContent = await readAgentMemoryFile(page, E2E_SLUG, relPath);
    expect(fileContent, 'saved memory file should be readable').toBeTruthy();
    expect(fileContent!).toContain(marker);

    // search_memory should find at least one hit referencing the marker.
    const searchOut = outputs[routine.stepIds['search']] as {
      results: Array<{ content: string; source: string | null; score: number }>;
      count: number;
    };
    expect(searchOut.count).toBeGreaterThan(0);
    const concatenated = searchOut.results.map((r) => r.content).join('\n');
    expect(concatenated).toContain(marker);
  });

  // SW-E1: web search for a real, stable query.
  test('SW-E1: search_web returns at least one real result via Claude Code WebSearch', async () => {
    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}web-${Date.now()}`, [
      {
        key: 'web',
        actionType: 'search_web',
        params: {
          query: 'Anthropic Claude official documentation site',
          max_results: 3,
          include_ai_answer: false,
          model: SONNET_MODEL,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const webOut = outputs[routine.stepIds['web']] as {
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(webOut.results.length).toBeGreaterThan(0);
    for (const r of webOut.results) {
      expect(r.url).toMatch(/^https?:\/\//);
    }
  });

  // SD-E1: RAG over a single bucket-backed text file.
  test('SD-E1: search_documents answers a query against a real bucket file', async () => {
    const bucketName = `${BUCKET_NAME_PREFIX}${Date.now()}`;
    const secret = `cerebro-sd-secret-${Date.now()}`;
    const bucket = await createBucketWithTextFile(
      page,
      bucketName,
      'doc.md',
      `# Company handbook\n\nOur internal support code is "${secret}". Employees greet customers by saying "hola amigo".\n`,
    );

    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}docs-${Date.now()}`, [
      {
        key: 'docs',
        actionType: 'search_documents',
        params: {
          query: 'What is the internal support code?',
          bucket_id: bucket.id,
          max_results: 3,
          model: SONNET_MODEL,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const docsOut = outputs[routine.stepIds['docs']] as {
      results: Array<{ path: string; snippet: string; score: number }>;
      count: number;
    };
    expect(docsOut.count).toBeGreaterThan(0);
    const concatenated = docsOut.results.map((r) => r.snippet).join('\n');
    expect(concatenated).toContain(secret);
    // The hit's path should be the abs_path we registered.
    expect(docsOut.results.some((r) => r.path === bucket.absPath)).toBe(true);
  });

  // STM-E2: extract-mode distillation.
  test('STM-E2: save_to_memory extract-mode distills raw content into bullets', async () => {
    const uniqTag = `e2e-extract-${Date.now()}`;
    const rambling = [
      'Hi team, quick thoughts on the new onboarding flow. I think we should reduce the setup steps from seven',
      'to three. Also our activation rate last month was 42%, up from 38% previously. One more thing — the mobile',
      `team is cutting a release branch Friday. Please tag ${uniqTag} so we can find this later.`,
    ].join(' ');

    const routine = await createManualRoutine(page, `${ROUTINE_NAME_PREFIX}extract-${Date.now()}`, [
      {
        key: 'save',
        actionType: 'save_to_memory',
        params: {
          content: rambling,
          agent: E2E_SLUG,
          mode: 'extract',
          topic: uniqTag,
          model: SONNET_MODEL,
        },
      },
    ]);

    const runId = await runRoutine(page, routine.id);
    const events = await waitForRunSettlement(page, runId, RUN_SETTLE_TIMEOUT_MS);
    assertRunCompleted(events);

    const outputs = await getStepOutputs(page, runId);
    const saveOut = outputs[routine.stepIds['save']] as { saved: boolean; item_id: string };
    expect(saveOut.saved).toBe(true);

    const [, relPath] = saveOut.item_id.split(':');
    const fileContent = await readAgentMemoryFile(page, E2E_SLUG, relPath);
    expect(fileContent, 'extracted memory file should be readable').toBeTruthy();

    // Our tag appears in the header, and the body is bulleted facts — not the raw paragraph.
    expect(fileContent!).toContain(uniqTag);
    const entryHeaderIdx = fileContent!.indexOf(`— ${uniqTag}`);
    expect(entryHeaderIdx).toBeGreaterThanOrEqual(0);
    const entryBody = fileContent!.slice(entryHeaderIdx);
    // At least one bullet in the entry body.
    expect(entryBody).toMatch(/^[\t ]*[-*]\s+\S+/m);
    // And the raw opener "Hi team, quick thoughts" should NOT survive distillation verbatim.
    expect(entryBody).not.toContain('Hi team, quick thoughts on the new onboarding flow');
  });
});
