import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { RoutineScheduler } from '../scheduler';
import type { ExecutionEngine } from '../../engine/engine';

// ── Mock helpers ────────────────────────────────────────────────

function makeMockEngine(): ExecutionEngine {
  return {
    startRun: vi.fn().mockResolvedValue('run-123'),
    cancelRun: vi.fn(),
  } as unknown as ExecutionEngine;
}

function makeMockWebContents() {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    send: vi.fn(),
  } as any;
}

/** Minimal backend server that serves routine data. */
function createMockBackend(routines: Record<string, any>[]) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.url?.startsWith('/routines?')) {
      // List endpoint — filter by trigger_type and is_enabled from query
      const url = new URL(req.url, `http://127.0.0.1`);
      let filtered = routines;
      const trigger = url.searchParams.get('trigger_type');
      if (trigger) filtered = filtered.filter((r) => r.trigger_type === trigger);
      const enabled = url.searchParams.get('is_enabled');
      if (enabled) filtered = filtered.filter((r) => String(r.is_enabled) === enabled);
      res.writeHead(200);
      res.end(JSON.stringify({ routines: filtered }));
    } else if (req.url?.match(/^\/routines\/[^/]+\/run$/)) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url?.match(/^\/routines\/[^/]+$/)) {
      const id = req.url.split('/')[2];
      const routine = routines.find((r) => r.id === id);
      if (routine) {
        res.writeHead(200);
        res.end(JSON.stringify(routine));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ detail: 'Not found' }));
      }
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  return server;
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

// ── Tests ───────────────────────────────────────────────────────

describe('RoutineScheduler', () => {
  let server: http.Server;
  let port: number;
  let engine: ExecutionEngine;
  let scheduler: RoutineScheduler;

  afterEach(async () => {
    scheduler?.stopAll();
    if (server) await closeServer(server);
  });

  // ── sync() ─────────────────────────────────────────────────────

  it('creates cron jobs for enabled cron routines', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'Morning Prep',
        trigger_type: 'cron',
        cron_expression: '0 9 * * 1-5',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);

    await scheduler.sync();

    // The scheduler should have 1 job
    expect((scheduler as any).jobs.size).toBe(1);
    expect((scheduler as any).jobs.has('r1')).toBe(true);
  });

  it('skips routines with invalid cron expressions', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'Bad Cron',
        trigger_type: 'cron',
        cron_expression: 'not-valid',
        is_enabled: true,
        dag_json: null,
        plain_english_steps: ['Step 1'],
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);

    await scheduler.sync();
    expect((scheduler as any).jobs.size).toBe(0);
  });

  it('removes jobs for deleted routines on re-sync', async () => {
    let routines = [
      {
        id: 'r1',
        name: 'Will Be Deleted',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);

    await scheduler.sync();
    expect((scheduler as any).jobs.size).toBe(1);

    // Remove routine from backend
    routines.length = 0;
    await scheduler.sync();
    expect((scheduler as any).jobs.size).toBe(0);
  });

  it('recreates job when cron expression changes', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'Changing Schedule',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);

    await scheduler.sync();
    const oldJob = (scheduler as any).jobs.get('r1');
    expect(oldJob.cronExpression).toBe('0 9 * * *');

    // Change cron expression
    routines[0].cron_expression = '30 14 * * 1-5';
    await scheduler.sync();
    const newJob = (scheduler as any).jobs.get('r1');
    expect(newJob.cronExpression).toBe('30 14 * * 1-5');
    expect(newJob).not.toBe(oldJob);
  });

  it('keeps existing job if cron has not changed', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'Stable',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);

    await scheduler.sync();
    const firstJob = (scheduler as any).jobs.get('r1');

    await scheduler.sync();
    const secondJob = (scheduler as any).jobs.get('r1');
    expect(secondJob).toBe(firstJob); // Same object reference — not recreated
  });

  // ── stopAll() ──────────────────────────────────────────────────

  it('clears all jobs on stopAll', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'Job 1',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
      {
        id: 'r2',
        name: 'Job 2',
        trigger_type: 'cron',
        cron_expression: '0 10 * * *',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);

    await scheduler.sync();
    expect((scheduler as any).jobs.size).toBe(2);

    scheduler.stopAll();
    expect((scheduler as any).jobs.size).toBe(0);
  });

  // ── executeRoutine ─────────────────────────────────────────────

  it('executeRoutine skips when no webContents', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'No WC',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: JSON.stringify({ steps: [{ id: 's1', name: 'Go', actionType: 'model_call' }] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);
    // No setWebContents call

    await (scheduler as any).executeRoutine('r1', 'No WC');
    expect((engine.startRun as any)).not.toHaveBeenCalled();
  });

  it('executeRoutine skips disabled routine', async () => {
    const routines = [
      {
        id: 'r1',
        name: 'Disabled',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: false,
        dag_json: JSON.stringify({ steps: [] }),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);
    scheduler.setWebContents(makeMockWebContents());

    await (scheduler as any).executeRoutine('r1', 'Disabled');
    expect((engine.startRun as any)).not.toHaveBeenCalled();
  });

  it('executeRoutine uses dag_json when available', async () => {
    const dag = { steps: [{ id: 's1', name: 'Model', actionType: 'model_call', params: { prompt: 'test' } }] };
    const routines = [
      {
        id: 'r1',
        name: 'Has DAG',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: JSON.stringify(dag),
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);
    const wc = makeMockWebContents();
    scheduler.setWebContents(wc);

    await (scheduler as any).executeRoutine('r1', 'Has DAG');
    expect((engine.startRun as any)).toHaveBeenCalledWith(wc, {
      dag,
      routineId: 'r1',
      triggerSource: 'schedule',
    });
  });

  it('executeRoutine compiles from plain_english_steps when no dag_json', async () => {
    const routines = [
      {
        id: 'r2',
        name: 'Steps Only',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: null,
        plain_english_steps: ['Fetch data', 'Process data'],
        default_runner_id: null,
        approval_gates: [],
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);
    scheduler.setWebContents(makeMockWebContents());

    await (scheduler as any).executeRoutine('r2', 'Steps Only');
    expect((engine.startRun as any)).toHaveBeenCalledTimes(1);

    const callArgs = (engine.startRun as any).mock.calls[0][1];
    expect(callArgs.dag.steps).toHaveLength(2);
    expect(callArgs.dag.steps[0].name).toBe('Fetch data');
    expect(callArgs.routineId).toBe('r2');
    expect(callArgs.triggerSource).toBe('schedule');
  });

  it('executeRoutine skips when no dag_json and no steps', async () => {
    const routines = [
      {
        id: 'r3',
        name: 'Empty',
        trigger_type: 'cron',
        cron_expression: '0 9 * * *',
        is_enabled: true,
        dag_json: null,
        plain_english_steps: null,
        default_runner_id: null,
        approval_gates: null,
      },
    ];

    server = createMockBackend(routines);
    port = await listenOnRandomPort(server);
    engine = makeMockEngine();
    scheduler = new RoutineScheduler(engine, port);
    scheduler.setWebContents(makeMockWebContents());

    await (scheduler as any).executeRoutine('r3', 'Empty');
    expect((engine.startRun as any)).not.toHaveBeenCalled();
  });
});
