import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { TaskReconciler } from '../task-reconciler';
import type { AgentRuntime } from '../../agents/runtime';

// ── Mock helpers ────────────────────────────────────────────────

interface CapturedRequest {
  path: string;
  body: any;
}

/**
 * Backend stub that captures every POST /tasks/reconcile body and replies with
 * a configurable { reconciled } count. `delayMs` lets a test hold the response
 * open to exercise the in-flight concurrency guard.
 */
function createMockBackend(opts: { reconciled?: number; delayMs?: number } = {}) {
  const captured: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = null;
      }
      captured.push({ path: req.url || '', body: parsed });
      const respond = () => {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ reconciled: opts.reconciled ?? 0 }));
      };
      if (opts.delayMs) setTimeout(respond, opts.delayMs);
      else respond();
    });
  });
  return { server, captured };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** Fake runtime exposing only what the reconciler reads. */
function makeRuntime(liveTaskIds: string[], liveRunIds: string[]) {
  const getLiveTaskIds = vi.fn().mockReturnValue(liveTaskIds);
  const getLiveRunIds = vi.fn().mockReturnValue(liveRunIds);
  return {
    runtime: { getLiveTaskIds, getLiveRunIds } as unknown as AgentRuntime,
    getLiveTaskIds,
    getLiveRunIds,
  };
}

describe('TaskReconciler.tick', () => {
  let server: http.Server;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  it('posts live_task_ids AND live_run_ids from the runtime to /tasks/reconcile', async () => {
    const backend = createMockBackend({ reconciled: 0 });
    server = backend.server;
    const port = await listen(server);
    const { runtime, getLiveTaskIds, getLiveRunIds } = makeRuntime(['task-a', 'task-b'], ['run-x']);

    const reconciler = new TaskReconciler(runtime, port);
    await reconciler.tick();

    expect(getLiveTaskIds).toHaveBeenCalledTimes(1);
    expect(getLiveRunIds).toHaveBeenCalledTimes(1);
    expect(backend.captured).toHaveLength(1);
    expect(backend.captured[0].path).toBe('/tasks/reconcile');
    // The bug fix hinges on this exact field — the backend keys liveness on it.
    expect(backend.captured[0].body.live_task_ids).toEqual(['task-a', 'task-b']);
    expect(backend.captured[0].body.live_run_ids).toEqual(['run-x']);
  });

  it('sends an empty live_task_ids array when no task is running (not null/omitted)', async () => {
    // Empty array is the signal "nothing is live" — it MUST still flip the
    // backend into taskId mode (bidirectional). null/omitted would silently
    // fall back to the legacy run-id path and disable Invariant B.
    const backend = createMockBackend({ reconciled: 0 });
    server = backend.server;
    const port = await listen(server);
    const { runtime } = makeRuntime([], []);

    const reconciler = new TaskReconciler(runtime, port);
    await reconciler.tick();

    expect(backend.captured[0].body.live_task_ids).toEqual([]);
    expect(Array.isArray(backend.captured[0].body.live_task_ids)).toBe(true);
  });

  it('does not throw when the backend reports tasks were reconciled', async () => {
    const backend = createMockBackend({ reconciled: 3 });
    server = backend.server;
    const port = await listen(server);
    const { runtime } = makeRuntime(['t1'], ['r1']);

    const reconciler = new TaskReconciler(runtime, port);
    await expect(reconciler.tick()).resolves.toBeUndefined();
    expect(backend.captured).toHaveLength(1);
  });

  it('skips overlapping ticks while one is still in flight (no double-post)', async () => {
    const backend = createMockBackend({ reconciled: 0, delayMs: 80 });
    server = backend.server;
    const port = await listen(server);
    const { runtime, getLiveTaskIds } = makeRuntime(['t1'], ['r1']);

    const reconciler = new TaskReconciler(runtime, port);
    const first = reconciler.tick(); // holds the lock until the slow backend replies
    const second = reconciler.tick(); // must early-return on the `running` guard
    await Promise.all([first, second]);

    expect(getLiveTaskIds).toHaveBeenCalledTimes(1);
    expect(backend.captured).toHaveLength(1);
  });

  it('swallows a backend error so the periodic loop keeps running', async () => {
    // Point at a closed port → the request errors. tick() must resolve, not reject.
    const { runtime } = makeRuntime(['t1'], ['r1']);
    const reconciler = new TaskReconciler(runtime, 1); // nothing listening on :1
    await expect(reconciler.tick()).resolves.toBeUndefined();
  });
});

describe('TaskReconciler lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('start() schedules a repeating tick; stop() halts it', () => {
    vi.useFakeTimers();
    const { runtime } = makeRuntime([], []);
    const reconciler = new TaskReconciler(runtime, 65535);
    const tickSpy = vi.spyOn(reconciler, 'tick').mockResolvedValue(undefined);

    reconciler.start();
    expect(tickSpy).not.toHaveBeenCalled(); // setInterval doesn't fire immediately
    vi.advanceTimersByTime(30_000);
    expect(tickSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(tickSpy).toHaveBeenCalledTimes(2);

    reconciler.stop();
    vi.advanceTimersByTime(120_000);
    expect(tickSpy).toHaveBeenCalledTimes(2); // no further ticks after stop()
  });
});
