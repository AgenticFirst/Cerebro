/**
 * RoutineScheduler — manages node-cron jobs for scheduled routines.
 *
 * Fetches enabled cron routines from the backend, reconciles with active
 * cron jobs, and fires DAG executions via the ExecutionEngine.
 */

import cron from 'node-cron';
import http from 'node:http';
import type { WebContents } from 'electron';
import type { ExecutionEngine } from '../engine/engine';
import { compileLinearDAG } from '../engine/dag/compiler';
import type { DAGDefinition } from '../engine/dag/types';

interface CronRoutine {
  id: string;
  name: string;
  trigger_type: string;
  cron_expression: string | null;
  is_enabled: boolean;
  dag_json: string | null;
  plain_english_steps: string[] | null;
  default_runner_id: string | null;
  approval_gates: string[] | null;
}

interface ActiveJob {
  task: cron.ScheduledTask;
  cronExpression: string;
  routineName: string;
}

const RESYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class RoutineScheduler {
  private engine: ExecutionEngine;
  private backendPort: number;
  private webContents: WebContents | null = null;
  private jobs = new Map<string, ActiveJob>();
  private resyncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: ExecutionEngine, backendPort: number) {
    this.engine = engine;
    this.backendPort = backendPort;
  }

  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  /** Start periodic re-sync to self-heal after missed mutations or backend restarts. */
  startPeriodicSync(): void {
    this.stopPeriodicSync();
    this.resyncTimer = setInterval(() => {
      this.sync().catch((err) => {
        console.warn('[Scheduler] Periodic re-sync failed:', err);
      });
    }, RESYNC_INTERVAL_MS);
  }

  /** Stop periodic re-sync. */
  stopPeriodicSync(): void {
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  /**
   * Sync cron jobs with backend state.
   * Removes stale jobs, adds/recreates changed ones.
   */
  async sync(): Promise<void> {
    let routines: CronRoutine[];
    try {
      routines = await this.fetchCronRoutines();
    } catch (err) {
      console.error('[Scheduler] Failed to fetch routines:', err);
      return;
    }

    const activeIds = new Set<string>();

    for (const routine of routines) {
      if (!routine.cron_expression || !cron.validate(routine.cron_expression)) {
        console.warn(`[Scheduler] Skipping "${routine.name}" — invalid cron: ${routine.cron_expression}`);
        continue;
      }

      activeIds.add(routine.id);
      const existing = this.jobs.get(routine.id);

      // If job exists and cron hasn't changed, keep it
      if (existing && existing.cronExpression === routine.cron_expression) {
        continue;
      }

      // Remove old job if cron changed
      if (existing) {
        existing.task.stop();
        this.jobs.delete(routine.id);
      }

      // Schedule new job — capture only id/name; executeRoutine re-fetches fresh data
      const routineId = routine.id;
      const routineName = routine.name;
      const task = cron.schedule(
        routine.cron_expression,
        () => {
          this.executeRoutine(routineId, routineName);
        },
        { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      );

      this.jobs.set(routine.id, {
        task,
        cronExpression: routine.cron_expression,
        routineName: routine.name,
      });
    }

    // Remove jobs for routines that are no longer active
    for (const [id, job] of this.jobs) {
      if (!activeIds.has(id)) {
        job.task.stop();
        this.jobs.delete(id);
      }
    }

    console.log(`[Scheduler] Synced ${this.jobs.size} cron jobs`);
  }

  /** Stop all cron jobs and periodic sync. */
  stopAll(): void {
    this.stopPeriodicSync();
    for (const [, job] of this.jobs) {
      job.task.stop();
    }
    this.jobs.clear();
    console.log('[Scheduler] All cron jobs stopped');
  }

  private async executeRoutine(routineId: string, routineName: string): Promise<void> {
    if (!this.webContents || this.webContents.isDestroyed()) {
      console.warn(`[Scheduler] No webContents — skipping "${routineName}"`);
      return;
    }

    // Re-fetch fresh routine data to avoid stale dag_json/steps (retry up to 3× on transient failures)
    let routine: CronRoutine;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        routine = await this.fetchRoutineById(routineId);
        break;
      } catch (err) {
        if (attempt === 3) {
          console.error(`[Scheduler] Failed to fetch routine "${routineName}" after 3 attempts:`, err);
          return;
        }
        console.warn(`[Scheduler] Fetch attempt ${attempt} failed for "${routineName}", retrying...`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    // TypeScript narrowing — loop guarantees assignment or return
    routine = routine!;

    // Verify still enabled
    if (!routine.is_enabled) {
      console.log(`[Scheduler] Routine "${routineName}" is disabled — skipping`);
      return;
    }

    console.log(`[Scheduler] Executing scheduled routine: "${routine.name}"`);

    // Build DAG from dag_json or compile from plain_english_steps
    let dag: DAGDefinition;
    if (routine.dag_json) {
      try {
        dag = JSON.parse(routine.dag_json);
      } catch {
        console.error(`[Scheduler] Invalid DAG JSON for "${routine.name}"`);
        return;
      }
    } else if (routine.plain_english_steps?.length) {
      dag = compileLinearDAG({
        steps: routine.plain_english_steps,
        defaultRunnerId: routine.default_runner_id ?? undefined,
        approvalGates: routine.approval_gates ?? [],
      });
    } else {
      console.warn(`[Scheduler] No DAG or steps for "${routine.name}" — skipping`);
      return;
    }

    // Bump backend run metadata
    try {
      await this.backendRequest('POST', `/routines/${routine.id}/run`);
    } catch {
      // Non-critical
    }

    // Execute
    try {
      const runId = await this.engine.startRun(this.webContents, {
        dag,
        routineId: routine.id,
        triggerSource: 'schedule',
      });
      console.log(`[Scheduler] Started run ${runId} for "${routine.name}"`);
    } catch (err) {
      console.error(`[Scheduler] Failed to execute "${routine.name}":`, err);
    }
  }

  private async fetchRoutineById(id: string): Promise<CronRoutine> {
    return this.backendRequest<CronRoutine>('GET', `/routines/${id}`);
  }

  private async fetchCronRoutines(): Promise<CronRoutine[]> {
    const data = await this.backendRequest<{ routines: CronRoutine[] }>(
      'GET',
      '/routines?trigger_type=cron&is_enabled=true&limit=200',
    );
    return data.routines;
  }

  private backendRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const bodyStr = body != null ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (bodyStr) {
        headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path,
          method,
          headers,
          timeout: 10_000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              reject(new Error(`Invalid JSON response from ${path}`));
            }
          });
        },
      );
      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${path} timed out`));
      });
      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }
}
