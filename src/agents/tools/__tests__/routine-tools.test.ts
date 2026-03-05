import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createRunRoutine, createProposeRoutine } from '../routine-tools';
import type { ToolContext } from '../../types';

// ── Mock helpers ────────────────────────────────────────────────

function makeMockEngine() {
  return {
    startRun: async () => 'mock-run-id',
  } as any;
}

function makeMockWebContents() {
  return { isDestroyed: () => false, send: () => {} } as any;
}

/** Create a mock backend that serves routine data for tool tests. */
function createMockBackend(routines: { id: string; name: string; dag_json: string | null }[]) {
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/routines')) {
      if (req.method === 'POST' && req.url.includes('/run')) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ routines }));
      }
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
}

function listenOnRandomPort(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' ? addr!.port : 0);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeCtx(port: number, withEngine = true): ToolContext {
  return {
    expertId: null,
    conversationId: 'conv-1',
    scope: 'general',
    scopeId: null,
    backendPort: port,
    executionEngine: withEngine ? makeMockEngine() : undefined,
    webContents: withEngine ? makeMockWebContents() : undefined,
  };
}

function extractText(result: any): string {
  return result.content[0].text;
}

// ── run_routine ─────────────────────────────────────────────────

describe('run_routine', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('matches routine by name (case-insensitive)', async () => {
    const routines = [
      { id: 'r1', name: 'Morning Prep', dag_json: '{"steps":[]}' },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createRunRoutine(ctx);

    const result = await tool.execute('tc1', { routine: 'morning prep' });
    expect(extractText(result)).toContain('Started routine "Morning Prep"');
    expect(extractText(result)).toContain('[ENGINE_RUN_ID:');
  });

  it('matches routine by ID', async () => {
    const routines = [
      { id: 'abc-123', name: 'My Routine', dag_json: '{"steps":[]}' },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createRunRoutine(ctx);

    const result = await tool.execute('tc1', { routine: 'abc-123' });
    expect(extractText(result)).toContain('Started routine "My Routine"');
  });

  it('returns not-found message when routine does not exist', async () => {
    const routines = [
      { id: 'r1', name: 'Alpha', dag_json: '{"steps":[]}' },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createRunRoutine(ctx);

    const result = await tool.execute('tc1', { routine: 'nonexistent' });
    expect(extractText(result)).toContain('not found');
    expect(extractText(result)).toContain('Alpha');
  });

  it('returns error when routine has no DAG', async () => {
    const routines = [
      { id: 'r1', name: 'No DAG', dag_json: null },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createRunRoutine(ctx);

    const result = await tool.execute('tc1', { routine: 'No DAG' });
    expect(extractText(result)).toContain('no DAG configured');
  });

  it('returns error when engine is not available', async () => {
    const routines = [
      { id: 'r1', name: 'Test', dag_json: '{"steps":[]}' },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port, false); // No engine
    const tool = createRunRoutine(ctx);

    const result = await tool.execute('tc1', { routine: 'Test' });
    expect(extractText(result)).toContain('not available');
  });
});

// ── propose_routine ─────────────────────────────────────────────

describe('propose_routine', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('returns valid proposal JSON', async () => {
    server = createMockBackend([]);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    const result = await tool.execute('tc1', {
      name: 'Morning Prep',
      description: 'Prepares the day',
      steps: ['Check calendar', 'Review emails', 'Draft plan'],
      trigger_type: 'manual',
    });

    const proposal = JSON.parse(extractText(result));
    expect(proposal.type).toBe('routine_proposal');
    expect(proposal.name).toBe('Morning Prep');
    expect(proposal.steps).toEqual(['Check calendar', 'Review emails', 'Draft plan']);
    expect(proposal.triggerType).toBe('manual');
    expect(proposal.requiredConnections).toEqual([]);
    expect(proposal.approvalGates).toEqual([]);
  });

  it('detects duplicate routines by similar name', async () => {
    const routines = [
      { id: 'r1', name: 'Morning Standup Prep', dag_json: '{"steps":[]}' },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    // "Morning Standup Prep Routine" shares 3/4 tokens (75%) with "Morning Standup Prep"
    const result = await tool.execute('tc1', {
      name: 'Morning Standup Prep Routine',
      steps: ['Step 1'],
    });
    expect(extractText(result)).toContain('similar routine already exists');
    expect(extractText(result)).toContain('Morning Standup Prep');
  });

  it('allows proposals with sufficiently different names', async () => {
    const routines = [
      { id: 'r1', name: 'Morning Standup Prep', dag_json: '{"steps":[]}' },
    ];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    const result = await tool.execute('tc1', {
      name: 'Weekly Report Generator',
      steps: ['Gather data', 'Format report'],
    });
    const proposal = JSON.parse(extractText(result));
    expect(proposal.type).toBe('routine_proposal');
    expect(proposal.name).toBe('Weekly Report Generator');
  });

  it('includes cron fields when trigger_type is cron', async () => {
    server = createMockBackend([]);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    const result = await tool.execute('tc1', {
      name: 'Daily Report',
      steps: ['Generate report'],
      trigger_type: 'cron',
      cron_expression: '0 9 * * 1-5',
    });
    const proposal = JSON.parse(extractText(result));
    expect(proposal.triggerType).toBe('cron');
    expect(proposal.cronExpression).toBe('0 9 * * 1-5');
  });

  it('defaults trigger_type to manual', async () => {
    server = createMockBackend([]);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    const result = await tool.execute('tc1', {
      name: 'Ad Hoc Task',
      steps: ['Do thing'],
    });
    const proposal = JSON.parse(extractText(result));
    expect(proposal.triggerType).toBe('manual');
  });
});

// ── isSimilarName (tested indirectly through propose_routine) ──

describe('isSimilarName (via propose_routine)', () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await closeServer(server);
  });

  it('exact match after normalization is duplicate', async () => {
    const routines = [{ id: 'r1', name: 'Morning Prep', dag_json: null }];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    const result = await tool.execute('tc1', {
      name: 'MORNING PREP',
      steps: ['Step'],
    });
    expect(extractText(result)).toContain('similar routine already exists');
  });

  it('short dissimilar names are not duplicates', async () => {
    const routines = [{ id: 'r1', name: 'AI', dag_json: null }];
    server = createMockBackend(routines);
    const port = await listenOnRandomPort(server);
    const ctx = makeCtx(port);
    const tool = createProposeRoutine(ctx);

    const result = await tool.execute('tc1', {
      name: 'AI Email Draft',
      steps: ['Step'],
    });
    // Should NOT be duplicate — "AI" alone has low Jaccard overlap with "AI Email Draft"
    const proposal = JSON.parse(extractText(result));
    expect(proposal.type).toBe('routine_proposal');
  });
});
