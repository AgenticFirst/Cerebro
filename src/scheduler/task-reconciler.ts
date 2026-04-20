/**
 * TaskReconciler — periodic cleanup for tasks stuck in_progress after the
 * backing Claude Code run has ended.
 *
 * The normal task-finalize flow is: AgentRuntime emits 'done'/'error' → the
 * renderer catches it via IPC and POSTs /tasks/{id}/run-event → backend
 * flips task.column. That path is fragile. A destroyed webContents, an
 * unfocused renderer, a crashed renderer, or an IPC hiccup can drop the
 * event and strand the task at in_progress indefinitely.
 *
 * This reconciler runs every 2 minutes (double the runtime's 2-min idle
 * timeout so it can't race the per-run watchdog) and gives the backend the
 * set of run IDs currently alive in AgentRuntime. The backend reconciles
 * any in_progress task whose run is NOT in that set, syncing its column
 * with the linked RunRecord's status.
 */

import http from 'node:http';
import type { AgentRuntime } from '../agents/runtime';

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

export class TaskReconciler {
  private runtime: AgentRuntime;
  private backendPort: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(runtime: AgentRuntime, backendPort: number) {
    this.runtime = runtime;
    this.backendPort = backendPort;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.warn('[TaskReconciler] tick failed:', err);
      });
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const liveRunIds = this.runtime.getLiveRunIds();
      const result = await this.post<{ reconciled: number }>(
        '/tasks/reconcile',
        { live_run_ids: liveRunIds },
      );
      if (result && result.reconciled > 0) {
        console.log(`[TaskReconciler] reconciled ${result.reconciled} orphaned task(s)`);
      }
    } finally {
      this.running = false;
    }
  }

  private post<T>(path: string, body: unknown): Promise<T | null> {
    return new Promise((resolve) => {
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
          },
          timeout: 10_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              resolve(null);
              return;
            }
            try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(bodyStr);
      req.end();
    });
  }
}
