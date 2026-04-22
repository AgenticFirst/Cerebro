/**
 * DAGExecutor — executes a validated DAG with topological ordering.
 *
 * Uses Kahn's algorithm to determine execution waves. Steps within
 * the same wave run in parallel via Promise.allSettled(). Error
 * policies (fail/skip/retry) are applied per-step.
 */

import type { ActionRegistry } from '../actions/registry';
import type { ActionContext, ActionOutput } from '../actions/types';
import type { RunScratchpad } from '../scratchpad';
import type { RunEventEmitter } from '../events/emitter';
import type { ExecutionEvent } from '../events/types';
import type { DAGDefinition, StepDefinition } from './types';
import { extractByPath } from '../utils';

// ── Types ────────────────────────────────────────────────────────

export interface StepPersistenceUpdate {
  status: string;
  output_json?: string;
  summary?: string;
  error?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface ExecutorContext {
  runId: string;
  backendPort: number;
  signal: AbortSignal;
  onStepUpdate?: (stepId: string, update: StepPersistenceUpdate) => void;
  onApprovalRequired?: (step: StepDefinition) => Promise<boolean>;
  /** Trigger payload made available to steps via the synthetic '__trigger__'
   *  source step (referenced from inputMappings.sourceStepId). */
  triggerPayload?: Record<string, unknown>;
}

type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

interface StepState {
  status: StepStatus;
  output?: ActionOutput;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

// ── DAGExecutor ──────────────────────────────────────────────────

export class DAGExecutor {
  private dag: DAGDefinition;
  private registry: ActionRegistry;
  private scratchpad: RunScratchpad;
  private emitter: RunEventEmitter;
  private ctx: ExecutorContext;

  private stepStates = new Map<string, StepState>();
  private inDegree = new Map<string, number>();
  private successors = new Map<string, string[]>();

  constructor(
    dag: DAGDefinition,
    registry: ActionRegistry,
    scratchpad: RunScratchpad,
    emitter: RunEventEmitter,
    ctx: ExecutorContext,
  ) {
    this.dag = dag;
    this.registry = registry;
    this.scratchpad = scratchpad;
    this.emitter = emitter;
    this.ctx = ctx;
  }

  /** Execute the entire DAG. Returns when all steps are done. */
  async execute(): Promise<void> {
    this.buildGraph();

    // Emit step_queued for all steps
    const now = new Date().toISOString();
    for (const step of this.dag.steps) {
      this.emitter.emit({
        type: 'step_queued',
        runId: this.ctx.runId,
        stepId: step.id,
        stepName: step.name,
        timestamp: now,
      });
    }

    // Kahn's algorithm: process waves of ready steps
    while (true) {
      if (this.ctx.signal.aborted) {
        throw new Error('Run was cancelled');
      }

      const ready = this.getReadySteps();
      if (ready.length === 0) {
        // Check if all steps are done
        const allDone = this.dag.steps.every((s) => {
          const state = this.stepStates.get(s.id);
          return state && (state.status === 'completed' || state.status === 'skipped');
        });

        if (allDone) break;

        // Some steps remain but none are ready — must be a failure that blocked downstream
        const pending = this.dag.steps.filter((s) => {
          const state = this.stepStates.get(s.id);
          return state && state.status === 'pending';
        });

        if (pending.length > 0) {
          // Skip all pending steps that are blocked by failed upstream
          for (const step of pending) {
            this.stepStates.set(step.id, { status: 'skipped', error: 'Upstream step failed' });
            this.emitter.emit({
              type: 'step_skipped',
              runId: this.ctx.runId,
              stepId: step.id,
              stepName: step.name,
              reason: 'Upstream step failed',
              timestamp: new Date().toISOString(),
            });
          }
          break;
        }

        break;
      }

      // Execute ready steps in parallel
      const results = await Promise.allSettled(
        ready.map((step) => this.executeStep(step)),
      );

      // Check for run-aborting failures
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const step = ready[i];
        const state = this.stepStates.get(step.id)!;

        if (result.status === 'rejected' || state.status === 'failed') {
          // 'fail' always aborts. 'retry' aborts after exhausting retries.
          // Only 'skip' continues (handled in executeStep by setting status to 'skipped').
          if (step.onError !== 'skip') {
            const errorMsg = state.error || (result.status === 'rejected' ? String(result.reason) : 'Unknown error');
            throw new StepFailedError(step.id, errorMsg);
          }
        }
      }

      // Decrement in-degrees for successors of completed/skipped steps
      for (const step of ready) {
        const state = this.stepStates.get(step.id)!;
        if (state.status === 'completed' || state.status === 'skipped') {
          const succs = this.successors.get(step.id) || [];
          for (const succId of succs) {
            this.inDegree.set(succId, (this.inDegree.get(succId) ?? 1) - 1);
          }
        }
      }
    }
  }

  /** Execute a single step with error handling and retries. */
  private async executeStep(step: StepDefinition): Promise<void> {
    // ── Branch condition check ──────────────────────────────────
    if (this.shouldSkipForBranch(step)) {
      this.stepStates.set(step.id, { status: 'skipped', error: 'Branch condition not met' });
      this.emitter.emit({
        type: 'step_skipped',
        runId: this.ctx.runId,
        stepId: step.id,
        stepName: step.name,
        reason: 'Branch condition not met',
        timestamp: new Date().toISOString(),
      });
      this.ctx.onStepUpdate?.(step.id, {
        status: 'skipped',
        error: 'Branch condition not met',
        completed_at: new Date().toISOString(),
      });
      return;
    }

    // ── Approval gate ──────────────────────────────────────────
    if (step.requiresApproval && this.ctx.onApprovalRequired) {
      const approved = await this.ctx.onApprovalRequired(step);
      if (!approved) {
        this.stepStates.set(step.id, { status: 'failed', error: 'Approval denied' });
        this.ctx.onStepUpdate?.(step.id, {
          status: 'failed',
          error: 'Approval denied',
          completed_at: new Date().toISOString(),
        });
        throw new StepDeniedError(step.id, 'Approval denied');
      }
    }

    const maxAttempts = step.onError === 'retry' ? (step.maxRetries ?? 1) + 1 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.runStepOnce(step, attempt);
        return; // Success
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        if (attempt < maxAttempts) {
          // Will retry
          this.emitter.emit({
            type: 'step_log',
            runId: this.ctx.runId,
            stepId: step.id,
            message: `Attempt ${attempt} failed (${errorMsg}), retrying...`,
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        // Final failure
        this.stepStates.set(step.id, { status: 'failed', error: errorMsg });
        this.emitter.emit({
          type: 'step_failed',
          runId: this.ctx.runId,
          stepId: step.id,
          stepName: step.name,
          error: errorMsg,
          timestamp: new Date().toISOString(),
        });

        if (step.onError === 'skip') {
          // Mark as skipped so downstream can continue
          this.stepStates.set(step.id, { status: 'skipped', error: errorMsg });
          this.emitter.emit({
            type: 'step_skipped',
            runId: this.ctx.runId,
            stepId: step.id,
            stepName: step.name,
            reason: errorMsg,
            timestamp: new Date().toISOString(),
          });

          // Persist step skip
          this.ctx.onStepUpdate?.(step.id, {
            status: 'skipped',
            error: errorMsg,
            completed_at: new Date().toISOString(),
          });
          return;
        }

        // Persist step failure
        this.ctx.onStepUpdate?.(step.id, {
          status: 'failed',
          error: errorMsg,
          completed_at: new Date().toISOString(),
        });

        // 'fail' or 'retry' exhausted — throw to signal run abort
        throw err;
      }
    }
  }

  /** Run a single attempt of a step. */
  private async runStepOnce(step: StepDefinition, attempt: number): Promise<void> {
    this.stepStates.set(step.id, { status: 'running' });

    const startTime = Date.now();
    this.emitter.emit({
      type: 'step_started',
      runId: this.ctx.runId,
      stepId: step.id,
      stepName: step.name,
      actionType: step.actionType,
      timestamp: new Date().toISOString(),
    });

    // Resolve wired inputs from input mappings
    const wiredInputs = this.resolveInputMappings(step);

    // Look up action in registry
    const action = this.registry.get(step.actionType);
    if (!action) {
      throw new Error(`Action type "${step.actionType}" not found in registry`);
    }

    // Build step-scoped ActionContext
    const stepContext: ActionContext = {
      runId: this.ctx.runId,
      stepId: step.id,
      backendPort: this.ctx.backendPort,
      signal: this.ctx.signal,
      log: (message: string) => {
        this.emitter.emit({
          type: 'step_log',
          runId: this.ctx.runId,
          stepId: step.id,
          message,
          timestamp: new Date().toISOString(),
        });
      },
      emitEvent: (event: ExecutionEvent) => {
        // Enrich action events with runId (actions emit without runId)
        const enriched = { ...event, runId: this.ctx.runId } as ExecutionEvent;
        this.emitter.emit(enriched);
      },
    };

    // Execute with timeout
    const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const output = await executeWithTimeout(
      action.execute({
        params: step.params,
        wiredInputs,
        scratchpad: this.scratchpad,
        context: stepContext,
      }),
      timeoutMs,
      step.id,
    );

    // Store output and emit completion
    const durationMs = Date.now() - startTime;
    this.stepStates.set(step.id, { status: 'completed', output });
    this.emitter.emit({
      type: 'step_completed',
      runId: this.ctx.runId,
      stepId: step.id,
      stepName: step.name,
      summary: output.summary,
      durationMs,
      timestamp: new Date().toISOString(),
    });

    // Persist step completion
    this.ctx.onStepUpdate?.(step.id, {
      status: 'completed',
      output_json: JSON.stringify(output.data),
      summary: output.summary,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    });
  }

  /**
   * Check if a step should be skipped because a branch condition doesn't match.
   * If any inputMapping has a branchCondition, the source step's output.data.branch
   * must match it. If it doesn't match, this step is on the "other" branch.
   */
  private shouldSkipForBranch(step: StepDefinition): boolean {
    for (const mapping of step.inputMappings) {
      if (!mapping.branchCondition) continue;

      const sourceState = this.stepStates.get(mapping.sourceStepId);
      if (!sourceState?.output) continue; // source skipped — skip us too

      const branch = sourceState.output.data.branch;
      if (String(branch) !== mapping.branchCondition) {
        return true;
      }
    }
    return false;
  }

  /** Resolve input mappings by reading outputs from completed dependency steps. */
  private resolveInputMappings(step: StepDefinition): Record<string, unknown> {
    const wiredInputs: Record<string, unknown> = {};

    // Splat trigger payload fields first so explicit input mappings always win
    // on key collisions. This lets steps reference `{{chat_id}}`,
    // `{{message_text}}`, etc. without needing the user to draw a wire from
    // the trigger node — which the trigger panel UI doesn't expose. Only
    // primitives are splatted to avoid leaking deep structures into templates.
    if (this.ctx.triggerPayload) {
      for (const [key, value] of Object.entries(this.ctx.triggerPayload)) {
        const t = typeof value;
        if (value === null || t === 'string' || t === 'number' || t === 'boolean') {
          wiredInputs[key] = value;
        }
      }
    }

    for (const mapping of step.inputMappings) {
      const sourceState = this.stepStates.get(mapping.sourceStepId);
      if (!sourceState?.output) {
        // Source step was skipped or has no output
        wiredInputs[mapping.targetField] = undefined;
        continue;
      }

      const value = extractByPath(sourceState.output.data, mapping.sourceField);
      wiredInputs[mapping.targetField] = value;
    }

    return wiredInputs;
  }

  /** Build the in-degree and successor maps from the DAG. */
  private buildGraph(): void {
    // Seed a synthetic '__trigger__' step state so steps can wire its fields
    // via inputMappings (sourceStepId='__trigger__'). Trigger payloads
    // typically come from cron, webhooks, or inbound chat platform events.
    const triggerActive = !!this.ctx.triggerPayload;
    if (triggerActive) {
      this.stepStates.set('__trigger__', {
        status: 'completed',
        output: { data: this.ctx.triggerPayload },
      });
    }

    for (const step of this.dag.steps) {
      this.stepStates.set(step.id, { status: 'pending' });
      // Trigger deps are pre-satisfied (the synthetic node has no execution),
      // so don't count them toward this step's in-degree.
      const realDepCount = triggerActive
        ? step.dependsOn.filter((id) => id !== '__trigger__').length
        : step.dependsOn.length;
      this.inDegree.set(step.id, realDepCount);
      this.successors.set(step.id, []);
    }

    for (const step of this.dag.steps) {
      for (const depId of step.dependsOn) {
        const succs = this.successors.get(depId);
        if (succs) {
          succs.push(step.id);
        }
      }
    }
  }

  /** Get steps that are pending with in-degree 0. */
  private getReadySteps(): StepDefinition[] {
    return this.dag.steps.filter((step) => {
      const state = this.stepStates.get(step.id);
      return state?.status === 'pending' && (this.inDegree.get(step.id) ?? 0) === 0;
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────

export class StepFailedError extends Error {
  public stepId: string;

  constructor(stepId: string, message: string) {
    super(message);
    this.name = 'StepFailedError';
    this.stepId = stepId;
  }
}

export class StepDeniedError extends StepFailedError {
  constructor(stepId: string, message: string) {
    super(stepId, message);
    this.name = 'StepDeniedError';
  }
}

function executeWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stepId: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Step "${stepId}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
