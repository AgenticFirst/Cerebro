/**
 * Integration tests for the four Knowledge-category actions running through
 * the full ExecutionEngine pipeline (DAG executor → actions → event/state
 * persistence). The Claude Code subprocess is mocked so tests are
 * hermetic, but the action↔backend HTTP interface is exercised
 * against a real local mock server.
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../claude-code/single-shot', () => ({
  singleShotClaudeCode: vi.fn(),
}));

import { singleShotClaudeCode } from '../../claude-code/single-shot';
import { ExecutionEngine } from '../engine';
import type { EngineRunRequest, StepDefinition } from '../dag/types';

const mockSingleShot = vi.mocked(singleShotClaudeCode);

// ── Test helpers ───────────────────────────────────────────────

function makeStep(overrides: Partial<StepDefinition> & { id: string; actionType: string }): StepDefinition {
  return {
    name: overrides.id,
    params: {},
    dependsOn: [],
    inputMappings: [],
    requiresApproval: false,
    onError: 'fail',
    ...overrides,
  } as StepDefinition;
}

function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: { on: vi.fn(), removeListener: vi.fn() },
  } as any;
}

function makeMockRuntime() {
  return { startRun: vi.fn() } as any;
}

// ── Mock HTTP server — handles engine + agent-memory + files endpoints ───

interface CapturedRequest {
  method: string;
  path: string;
  body: any;
}

let mockServer: http.Server;
let serverPort: number;
let captured: CapturedRequest[];
/** Virtual file store for agent-memory mock: key = `<slug>:<relPath>` → content */
let memoryStore: Map<string, string>;
/** Virtual buckets mock: bucket_id → array of BucketContent */
let bucketStore: Map<string, Array<{ id: string; name: string; ext: string; mime: string | null; size_bytes: number; abs_path: string }>>;

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timeout. Captured: ${JSON.stringify(captured.map(r => `${r.method} ${r.path}`))}`));
      }
      setTimeout(check, 15);
    };
    check();
  });
}

function waitForRunCompleted(runId: string): Promise<void> {
  return waitFor(() =>
    captured.some(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed'),
  );
}

beforeAll(async () => {
  captured = [];
  memoryStore = new Map();
  bucketStore = new Map();

  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { parsed = body; }

      const url = req.url || '/';
      const method = req.method || 'GET';
      captured.push({ method, path: url, body: parsed });

      // ── Engine persistence routes (match engine-integration.test.ts) ───
      if (method === 'POST' && url.endsWith('/runs') && !url.includes('/steps') && !url.includes('/events')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: parsed?.id || 'test' }));
      }
      if (method === 'POST' && url.includes('/steps') && !url.includes('/events')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        const steps = Array.isArray(parsed) ? parsed.map((s: any) => ({ ...s, run_id: 'test' })) : [];
        return res.end(JSON.stringify(steps));
      }
      if (method === 'POST' && url.includes('/events')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ created: parsed?.events?.length || 0 }));
      }
      if (method === 'PATCH') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: parsed?.status || 'running' }));
      }

      // ── /files/buckets/{id}/contents ───
      const bucketMatch = url.match(/^\/files\/buckets\/([^/]+)\/contents(?:\?.*)?$/);
      if (method === 'GET' && bucketMatch) {
        const bid = decodeURIComponent(bucketMatch[1]);
        const contents = bucketStore.get(bid);
        if (!contents) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ detail: 'Bucket not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(contents));
      }

      // ── /agent-memory/{slug}/files/{path...} ───
      const memMatch = url.match(/^\/agent-memory\/([^/]+)\/files\/(.+)$/);
      if (memMatch) {
        const slug = decodeURIComponent(memMatch[1]);
        const relPath = memMatch[2].split('/').map(decodeURIComponent).join('/');
        const key = `${slug}:${relPath}`;
        if (method === 'GET') {
          const content = memoryStore.get(key);
          if (content == null) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ detail: 'File not found' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ path: relPath, content, last_modified: '2026-04-21T14:32:00' }));
        }
        if (method === 'PUT') {
          memoryStore.set(key, parsed.content ?? '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ path: relPath, content: parsed.content, last_modified: '2026-04-21T14:32:00' }));
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
  });

  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = (mockServer.address() as any).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});

beforeEach(() => {
  captured = [];
  memoryStore.clear();
  bucketStore.clear();
  mockSingleShot.mockReset();
});

/**
 * Resolve the engine-assigned stepRecordId (a UUID) that corresponds to
 * the user-facing step.id, by reading the initial step-create POST.
 */
function resolveStepRecordId(stepId: string): string | null {
  const create = captured.find(
    (r) => r.method === 'POST' && r.path.includes('/steps') && Array.isArray(r.body),
  );
  if (!create) return null;
  const record = (create.body as Array<{ id: string; step_id: string }>).find(
    (s) => s.step_id === stepId,
  );
  return record?.id ?? null;
}

/**
 * Pull the `output_json` from a step's "completed" PATCH call — this is the
 * canonical persisted form of the action's `data` field, so verifying it
 * proves the value actually travels through the full pipeline.
 */
function getStepOutput(stepId: string): Record<string, unknown> | null {
  const recordId = resolveStepRecordId(stepId);
  if (!recordId) return null;
  const patch = captured.find(
    (r) =>
      r.method === 'PATCH' &&
      r.path.includes(`/steps/${recordId}`) &&
      r.body?.status === 'completed',
  );
  if (!patch || !patch.body.output_json) return null;
  return JSON.parse(patch.body.output_json);
}

// ── Integration scenarios ───────────────────────────────────────

describe('SM-I1: search_memory inside a DAG returns parsed hits end-to-end', () => {
  it('Claude Code returns JSON → engine persists results/count on step_completed', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify([{ content: 'pairing notes', source: 'routines/2026-04-20.md', score: 0.88 }]),
    );

    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'mem',
            actionType: 'search_memory',
            params: { query: 'pair programming', agent: 'cerebro', max_results: 3 },
          }),
        ],
      },
    };

    const runId = await engine.startRun(makeMockWebContents(), request);
    await waitForRunCompleted(runId);

    const out = getStepOutput('mem') as { results: Array<{ content: string; source: string; score: number }>; count: number };
    expect(out).toBeTruthy();
    expect(out.count).toBe(1);
    expect(out.results[0].content).toBe('pairing notes');
    expect(out.results[0].source).toBe('routines/2026-04-20.md');
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'cerebro', allowedTools: 'Read,Glob,Grep' }),
    );
  }, 10_000);
});

describe('SW-I1: search_web inside a DAG returns parsed results end-to-end', () => {
  it('Claude Code JSON response reaches downstream as results[]', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify({
        results: [
          { title: 'One', url: 'https://one.test', snippet: 's1' },
          { title: 'Two', url: 'https://two.test', snippet: 's2' },
        ],
      }),
    );

    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'web',
            actionType: 'search_web',
            params: { query: 'cerebro docs', max_results: 5 },
          }),
        ],
      },
    };

    const runId = await engine.startRun(makeMockWebContents(), request);
    await waitForRunCompleted(runId);

    const out = getStepOutput('web') as { results: Array<{ url: string }> };
    expect(out.results).toHaveLength(2);
    expect(out.results.map(r => r.url)).toEqual(['https://one.test', 'https://two.test']);
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: 'WebSearch,WebFetch' }),
    );
  }, 10_000);
});

describe('SD-I1: search_documents fetches bucket contents from the backend then asks Claude', () => {
  it('passes bucket abs_paths into the Claude prompt and returns parsed hits', async () => {
    bucketStore.set('bk-integration', [
      { id: 'f1', name: 'a.md', ext: 'md', mime: 'text/markdown', size_bytes: 100, abs_path: '/abs/a.md' },
      { id: 'f2', name: 'b.md', ext: 'md', mime: 'text/markdown', size_bytes: 100, abs_path: '/abs/b.md' },
    ]);
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify([{ path: '/abs/a.md', snippet: 'hit in a', score: 0.9 }]),
    );

    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'docs',
            actionType: 'search_documents',
            params: { query: 'what is X', bucket_id: 'bk-integration', max_results: 5 },
          }),
        ],
      },
    };

    const runId = await engine.startRun(makeMockWebContents(), request);
    await waitForRunCompleted(runId);

    // Bucket-contents GET actually fired against the mock backend.
    const bucketGet = captured.find(r => r.method === 'GET' && r.path.startsWith('/files/buckets/bk-integration/contents'));
    expect(bucketGet).toBeDefined();

    // Paths were in the prompt.
    const claudeCall = mockSingleShot.mock.calls[0][0];
    expect(claudeCall.prompt).toContain('/abs/a.md');
    expect(claudeCall.prompt).toContain('/abs/b.md');

    const out = getStepOutput('docs') as { results: Array<{ path: string }>; count: number };
    expect(out.count).toBe(1);
    expect(out.results[0].path).toBe('/abs/a.md');
  }, 10_000);
});

describe('STM-I1: save_to_memory writes to /agent-memory via the backend', () => {
  it('PUTs a routines/<date>.md file to the target subagent', async () => {
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'save',
            actionType: 'save_to_memory',
            params: {
              content: 'integration-test body',
              agent: 'fitness-coach-ab12',
              topic: 'integration',
              mode: 'write',
            },
          }),
        ],
      },
    };

    const runId = await engine.startRun(makeMockWebContents(), request);
    await waitForRunCompleted(runId);

    // GET-then-PUT sequence to the correct slug.
    const memGet = captured.find(r => r.method === 'GET' && r.path.startsWith('/agent-memory/fitness-coach-ab12/files/routines/'));
    const memPut = captured.find(r => r.method === 'PUT' && r.path.startsWith('/agent-memory/fitness-coach-ab12/files/routines/'));
    expect(memGet).toBeDefined();
    expect(memPut).toBeDefined();
    expect(memPut!.body.content).toContain('integration-test body');
    expect(memPut!.body.content).toContain('— integration');

    // Store now reflects the write.
    const keys = Array.from(memoryStore.keys());
    expect(keys.some(k => k.startsWith('fitness-coach-ab12:routines/'))).toBe(true);

    const out = getStepOutput('save') as { saved: boolean; item_id: string };
    expect(out.saved).toBe(true);
    expect(out.item_id).toMatch(/^fitness-coach-ab12:routines\//);
  }, 10_000);

  it('appends instead of overwriting when a prior entry exists for the same day', async () => {
    // Seed the store with an existing entry.
    const todayISO = new Date().toISOString().slice(0, 10);
    const key = `cerebro:routines/${todayISO}.md`;
    memoryStore.set(key, '# Routine notes — earlier\n\n## 09:00\n\nEarlier entry.\n');

    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'append',
            actionType: 'save_to_memory',
            params: { content: 'Later entry.', mode: 'write' },
          }),
        ],
      },
    };

    const runId = await engine.startRun(makeMockWebContents(), request);
    await waitForRunCompleted(runId);

    const stored = memoryStore.get(key)!;
    expect(stored).toContain('Earlier entry.');
    expect(stored).toContain('Later entry.');
    expect(stored.indexOf('Earlier entry.')).toBeLessThan(stored.indexOf('Later entry.'));
  }, 10_000);
});
