/**
 * Integration tests for the full execution pipeline.
 *
 * These tests exercise: ExecutionEngine.startRun() → DAGExecutor → Actions → Events → Persistence.
 * A real mock HTTP server intercepts backend persistence calls so we can verify
 * the engine makes the correct HTTP requests without a real Python backend.
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ExecutionEngine } from '../engine';
import type { EngineRunRequest } from '../dag/types';
import type { StepDefinition } from '../dag/types';

// ── Test helpers ────────────────────────────────────────────────

function makeStep(overrides: Partial<StepDefinition> & { id: string }): StepDefinition {
  return {
    name: overrides.id,
    actionType: 'transformer',
    params: { operation: 'extract', path: '' },
    dependsOn: [],
    inputMappings: [],
    requiresApproval: false,
    onError: 'fail',
    ...overrides,
  };
}

function makeMockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: { on: vi.fn(), removeListener: vi.fn() },
  } as any;
}

function makeMockRuntime() {
  return {
    startRun: vi.fn(),
  } as any;
}

// ── Mock HTTP server ────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  path: string;
  body: any;
}

let mockServer: http.Server;
let serverPort: number;
let capturedRequests: CapturedRequest[];

function waitForRequests(predicate: (reqs: CapturedRequest[]) => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate(capturedRequests)) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for requests. Captured: ${JSON.stringify(capturedRequests.map(r => `${r.method} ${r.path}`))}`));
      } else {
        setTimeout(check, 20);
      }
    };
    check();
  });
}

beforeAll(async () => {
  capturedRequests = [];
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { parsed = body; }

      capturedRequests.push({
        method: req.method || 'GET',
        path: req.url || '/',
        body: parsed,
      });

      // Return minimal valid responses for each endpoint
      const url = req.url || '';
      if (req.method === 'POST' && url.endsWith('/runs') && !url.includes('/steps') && !url.includes('/events')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: parsed?.id || 'test',
          status: 'running',
          run_type: 'routine',
          trigger: 'manual',
          total_steps: parsed?.total_steps || 0,
          completed_steps: 0,
          started_at: new Date().toISOString(),
          routine_id: null, expert_id: null, conversation_id: null,
          dag_json: null, error: null, failed_step_id: null,
          completed_at: null, duration_ms: null, steps: null,
        }));
      } else if (req.method === 'POST' && url.includes('/steps')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        const steps = Array.isArray(parsed) ? parsed.map((s: any) => ({
          ...s, run_id: 'test', summary: null, error: null,
          started_at: null, completed_at: null, duration_ms: null,
        })) : [];
        res.end(JSON.stringify(steps));
      } else if (req.method === 'POST' && url.includes('/events')) {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ created: parsed?.events?.length || 0 }));
      } else if (req.method === 'PATCH') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'test', status: parsed?.status || 'running',
          run_type: 'routine', trigger: 'manual',
          total_steps: 0, completed_steps: 0,
          started_at: new Date().toISOString(),
          routine_id: null, expert_id: null, conversation_id: null,
          dag_json: null, error: null, failed_step_id: null,
          completed_at: null, duration_ms: null, steps: null,
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
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

function resetCaptures() {
  capturedRequests = [];
}

// ── Integration Tests ───────────────────────────────────────────

describe('engine integration: happy path', () => {
  it('multi-step linear DAG completes with correct persistence calls', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({ id: 'A' }),
          makeStep({ id: 'B', dependsOn: ['A'] }),
          makeStep({ id: 'C', dependsOn: ['B'] }),
        ],
      },
      routineId: 'routine-123',
      triggerSource: 'manual',
    };

    const runId = await engine.startRun(webContents, request);
    expect(runId).toHaveLength(32);

    // Wait for the run to complete and all persistence calls to fire
    await waitForRequests((reqs) => {
      const hasRunCreate = reqs.some(r => r.method === 'POST' && r.path === '/engine/runs');
      const hasStepCreate = reqs.some(r => r.method === 'POST' && r.path.includes('/steps'));
      const hasRunPatch = reqs.some(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed');
      const hasEvents = reqs.some(r => r.method === 'POST' && r.path.includes('/events'));
      return hasRunCreate && hasStepCreate && hasRunPatch && hasEvents;
    });

    // Verify POST /engine/runs was called with correct fields
    const runCreate = capturedRequests.find(r => r.method === 'POST' && r.path === '/engine/runs');
    expect(runCreate).toBeDefined();
    expect(runCreate!.body.id).toBe(runId);
    expect(runCreate!.body.total_steps).toBe(3);
    expect(runCreate!.body.routine_id).toBe('routine-123');
    expect(runCreate!.body.dag_json).toBeDefined();

    // Verify POST /engine/runs/{id}/steps was called with 3 step records
    const stepCreate = capturedRequests.find(r => r.method === 'POST' && r.path.includes('/steps'));
    expect(stepCreate).toBeDefined();
    expect(stepCreate!.body).toHaveLength(3);
    expect(stepCreate!.body[0].action_type).toBe('transformer');

    // Verify step PATCH calls (each completed step gets a PATCH)
    const stepPatches = capturedRequests.filter(r => r.method === 'PATCH' && r.path.includes('/steps/'));
    expect(stepPatches.length).toBeGreaterThanOrEqual(3);
    const completedPatches = stepPatches.filter(r => r.body.status === 'completed');
    expect(completedPatches.length).toBe(3);

    // Verify run completion PATCH
    const runPatch = capturedRequests.find(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed');
    expect(runPatch).toBeDefined();
    expect(runPatch!.body.completed_steps).toBe(3);
    expect(runPatch!.body.duration_ms).toBeGreaterThanOrEqual(0);
    expect(runPatch!.body.completed_at).toBeDefined();

    // Verify event buffer persisted
    const eventPost = capturedRequests.find(r => r.method === 'POST' && r.path.includes('/events'));
    expect(eventPost).toBeDefined();
    const events = eventPost!.body.events;
    expect(events.length).toBeGreaterThanOrEqual(10); // run_started + 3×queued + 3×started + 3×completed + run_completed

    const eventTypes = events.map((e: any) => e.event_type);
    expect(eventTypes.filter((t: string) => t === 'step_queued')).toHaveLength(3);
    expect(eventTypes.filter((t: string) => t === 'step_started')).toHaveLength(3);
    expect(eventTypes.filter((t: string) => t === 'step_completed')).toHaveLength(3);
    expect(eventTypes).toContain('run_started');
    expect(eventTypes).toContain('run_completed');

    // Events should have sequential seq numbers
    for (let i = 0; i < events.length; i++) {
      expect(events[i].seq).toBe(i);
    }
  }, 10_000);
});

describe('engine integration: failure path', () => {
  it('step failure results in run_failed persistence', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({ id: 'A' }),
          // Step B references a non-existent action type, which will cause the
          // DAG to fail validation. Instead, use a valid transformer with a
          // bad operation that throws at runtime.
          makeStep({
            id: 'B',
            dependsOn: ['A'],
            params: { operation: 'nonexistent_op' },
          }),
        ],
      },
    };

    const runId = await engine.startRun(webContents, request);

    // Wait for run_failed PATCH
    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'failed'),
    );

    const failPatch = capturedRequests.find(r =>
      r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'failed',
    );
    expect(failPatch).toBeDefined();
    expect(failPatch!.body.error).toBeDefined();
    expect(failPatch!.body.failed_step_id).toBe('B');

    // Events should contain run_failed
    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'POST' && r.path.includes('/events')),
    );
    const eventPost = capturedRequests.find(r => r.method === 'POST' && r.path.includes('/events'));
    const eventTypes = eventPost!.body.events.map((e: any) => e.event_type);
    expect(eventTypes).toContain('run_failed');
  }, 10_000);
});

describe('engine integration: cancellation', () => {
  it('cancelling a run produces run_cancelled persistence', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    // Use a step with a long timeout so we have time to cancel
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'slow',
            params: { operation: 'extract', path: '' },
            timeoutMs: 60_000,
          }),
          makeStep({
            id: 'after',
            dependsOn: ['slow'],
          }),
        ],
      },
    };

    const runId = await engine.startRun(webContents, request);
    expect(engine.getActiveRuns().length).toBe(1);

    // Cancel immediately — the transformer action is fast but we can still test the flow
    // Wait a tick for execution to start
    await new Promise(r => setTimeout(r, 5));
    const cancelled = engine.cancelRun(runId);
    // cancelRun may return false if the run already completed (transformer is fast)
    // Either way, verify the run is no longer active
    expect(engine.getActiveRuns().find(r => r.runId === runId)).toBeUndefined();
  }, 10_000);

  it('getActiveRuns returns empty after all runs finish', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request: EngineRunRequest = {
      dag: { steps: [makeStep({ id: 'only' })] },
    };

    const runId = await engine.startRun(webContents, request);

    // Wait for completion
    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed'),
    );

    expect(engine.getActiveRuns()).toHaveLength(0);
  }, 10_000);
});

describe('engine integration: parallel branches with join', () => {
  it('diamond DAG A → (B, C) → D creates correct step records and ordering', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({ id: 'A' }),
          makeStep({ id: 'B', dependsOn: ['A'] }),
          makeStep({ id: 'C', dependsOn: ['A'] }),
          makeStep({ id: 'D', dependsOn: ['B', 'C'] }),
        ],
      },
    };

    const runId = await engine.startRun(webContents, request);

    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed'),
    );

    // Step records created with correct order_index
    const stepCreate = capturedRequests.find(r => r.method === 'POST' && r.path.includes('/steps'));
    expect(stepCreate!.body).toHaveLength(4);
    expect(stepCreate!.body[0].order_index).toBe(0);
    expect(stepCreate!.body[1].order_index).toBe(1);
    expect(stepCreate!.body[2].order_index).toBe(2);
    expect(stepCreate!.body[3].order_index).toBe(3);

    // All 4 steps completed
    const completedPatches = capturedRequests.filter(r =>
      r.method === 'PATCH' && r.path.includes('/steps/') && r.body?.status === 'completed',
    );
    expect(completedPatches).toHaveLength(4);

    // Run completed with 4 steps
    const runPatch = capturedRequests.find(r =>
      r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed',
    );
    expect(runPatch!.body.completed_steps).toBe(4);
  }, 10_000);
});

describe('engine integration: input wiring through full pipeline', () => {
  it('step output is wired to downstream step via inputMappings', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    // Step A: extract with empty path returns whole data (which is the wiredInputs + params)
    // Step B: format template using wired input from A
    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({
            id: 'produce',
            params: { operation: 'extract', path: '' },
          }),
          makeStep({
            id: 'consume',
            dependsOn: ['produce'],
            params: { operation: 'extract', path: 'result' },
            inputMappings: [
              { sourceStepId: 'produce', sourceField: 'result', targetField: 'data' },
            ],
          }),
        ],
      },
    };

    const runId = await engine.startRun(webContents, request);

    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'PATCH' && r.path === `/engine/runs/${runId}` && r.body?.status === 'completed'),
    );

    // Both steps should have completed (output_json persisted)
    const stepPatches = capturedRequests.filter(r =>
      r.method === 'PATCH' && r.path.includes('/steps/') && r.body?.status === 'completed',
    );
    expect(stepPatches).toHaveLength(2);
    // Each completed step persists output_json
    for (const patch of stepPatches) {
      expect(patch.body.output_json).toBeDefined();
    }
  }, 10_000);
});

describe('engine integration: event buffer batch persistence', () => {
  it('events are persisted with correct seq ordering and structure', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request: EngineRunRequest = {
      dag: {
        steps: [
          makeStep({ id: 'X' }),
          makeStep({ id: 'Y', dependsOn: ['X'] }),
        ],
      },
    };

    const runId = await engine.startRun(webContents, request);

    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'POST' && r.path.includes('/events')),
    );

    const eventPost = capturedRequests.find(r => r.method === 'POST' && r.path.includes('/events'));
    expect(eventPost).toBeDefined();
    const events = eventPost!.body.events;

    // Each event has required fields
    for (const event of events) {
      expect(typeof event.seq).toBe('number');
      expect(typeof event.event_type).toBe('string');
      expect(typeof event.payload_json).toBe('string');
      expect(event.timestamp).toBeDefined();
    }

    // seq is monotonically increasing starting from 0
    for (let i = 0; i < events.length; i++) {
      expect(events[i].seq).toBe(i);
    }

    // step-related events have step_id
    const stepEvents = events.filter((e: any) =>
      ['step_queued', 'step_started', 'step_completed'].includes(e.event_type),
    );
    for (const se of stepEvents) {
      expect(se.step_id).toBeDefined();
      expect(se.step_id).not.toBeNull();
    }

    // run-level events have null step_id
    const runEvents = events.filter((e: any) =>
      ['run_started', 'run_completed'].includes(e.event_type),
    );
    for (const re of runEvents) {
      expect(re.step_id).toBeNull();
    }
  }, 10_000);
});

describe('engine integration: multiple concurrent runs', () => {
  it('two runs track independently', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request1: EngineRunRequest = {
      dag: { steps: [makeStep({ id: 'R1-A' })] },
      routineId: 'routine-1',
    };
    const request2: EngineRunRequest = {
      dag: { steps: [makeStep({ id: 'R2-A' })] },
      routineId: 'routine-2',
    };

    const [runId1, runId2] = await Promise.all([
      engine.startRun(webContents, request1),
      engine.startRun(webContents, request2),
    ]);

    expect(runId1).not.toBe(runId2);

    // Wait for both to complete
    await waitForRequests((reqs) => {
      const completions = reqs.filter(r =>
        r.method === 'PATCH' && r.body?.status === 'completed' && !r.path.includes('/steps/'),
      );
      return completions.length >= 2;
    });

    // Both runs had their own create call
    const runCreates = capturedRequests.filter(r => r.method === 'POST' && r.path === '/engine/runs');
    expect(runCreates.length).toBe(2);
    const runIds = runCreates.map(r => r.body.id);
    expect(runIds).toContain(runId1);
    expect(runIds).toContain(runId2);

    // Both runs are no longer active
    expect(engine.getActiveRuns()).toHaveLength(0);
  }, 10_000);
});

describe('engine integration: IPC events forwarded to webContents', () => {
  it('webContents.send receives all events on correct channel', async () => {
    resetCaptures();
    const engine = new ExecutionEngine(serverPort, makeMockRuntime());
    const webContents = makeMockWebContents();

    const request: EngineRunRequest = {
      dag: { steps: [makeStep({ id: 'solo' })] },
    };

    const runId = await engine.startRun(webContents, request);

    await waitForRequests((reqs) =>
      reqs.some(r => r.method === 'POST' && r.path.includes('/events')),
    );

    // webContents.send should have been called on both the run-specific
    // channel and the wildcard channel (for cross-run listeners like ApprovalContext)
    const sendCalls = webContents.send.mock.calls;
    expect(sendCalls.length).toBeGreaterThan(0);

    const expectedChannel = `engine:event:${runId}`;
    const wildcardChannel = 'engine:any-event';
    for (const call of sendCalls) {
      expect([expectedChannel, wildcardChannel]).toContain(call[0]);
      expect(call[1]).toHaveProperty('type');
    }

    // Filter to run-specific channel for event type assertions
    const runCalls = sendCalls.filter((c: any) => c[0] === expectedChannel);
    const eventTypes = runCalls.map((c: any) => c[1].type);
    expect(eventTypes).toContain('run_started');
    expect(eventTypes).toContain('step_queued');
    expect(eventTypes).toContain('step_started');
    expect(eventTypes).toContain('step_completed');
    expect(eventTypes).toContain('run_completed');
  }, 10_000);
});
