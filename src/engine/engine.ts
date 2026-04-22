/**
 * ExecutionEngine — top-level orchestrator for DAG-based routine execution.
 *
 * Manages concurrent runs, creates registries populated with all built-in
 * actions, validates DAGs, and coordinates executors with event streaming.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type EventEmitter from 'node:events';
import type { WebContents } from 'electron';
import type { AgentRuntime } from '../agents/runtime';
import type { EngineRunRequest } from './dag/types';
import type { EngineActiveRunInfo } from '../types/ipc';
import type { StepPersistenceUpdate } from './dag/executor';
import { ActionRegistry } from './actions/registry';
import { askAiAction, modelCallAction } from './actions/model-call';
import { transformerAction } from './actions/transformer';
import { createExpertStepAction } from './actions/expert-step';
import { approvalGateAction } from './actions/approval-gate';
import { conditionAction } from './actions/condition';
import { delayAction } from './actions/delay';
import { loopAction } from './actions/loop';
import { classifyAction } from './actions/classify';
import { extractAction } from './actions/extract';
import { summarizeAction } from './actions/summarize';
import { searchMemoryAction } from './actions/search-memory';
import { searchWebAction } from './actions/search-web';
import { searchDocumentsAction } from './actions/search-documents';
import { saveToMemoryAction } from './actions/save-to-memory';
import { httpRequestAction } from './actions/http-request';
import { sendMessageAction } from './actions/send-message';
import { sendNotificationAction } from './actions/send-notification';
import { channelAction } from './actions/channel';
import { runCommandAction } from './actions/run-command';
import { runClaudeCodeAction } from './actions/run-claude-code';
import { waitForWebhookAction } from './actions/wait-for-webhook';
import { runScriptAction } from './actions/run-script';
import { createSendTelegramAction } from './actions/send-telegram-message';
import type { TelegramChannel } from './actions/telegram-channel';
import { RunScratchpad } from './scratchpad';
import { RunEventEmitter } from './events/emitter';
import { validateDAG } from './dag/validator';
import { DAGExecutor, StepFailedError, StepDeniedError } from './dag/executor';
import type { ExecutionEvent } from './events/types';
import type { StepDefinition } from './dag/types';

interface ActiveEngineRun {
  runId: string;
  abortController: AbortController;
  emitter: RunEventEmitter;
  startedAt: number;
  routineId?: string;
}

interface PendingApproval {
  runId: string;
  stepId: string;
  stepRecordId?: string;
  resolve: (approved: boolean) => void;
}

/** How long to keep event buffers after a run finishes (ms). */
const EVENT_BUFFER_TTL_MS = 60_000;

export class ExecutionEngine {
  private backendPort: number;
  private agentRuntime: AgentRuntime;
  private sharedBus?: EventEmitter;
  private telegramChannel: TelegramChannel | null = null;
  private activeRuns = new Map<string, ActiveEngineRun>();
  /** Pending approval promises keyed by approvalId. */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** Buffers of emitted events, kept briefly after run completion for late subscribers. */
  private eventBuffers = new Map<string, ExecutionEvent[]>();

  constructor(backendPort: number, agentRuntime: AgentRuntime, sharedBus?: EventEmitter) {
    this.backendPort = backendPort;
    this.agentRuntime = agentRuntime;
    this.sharedBus = sharedBus;
  }

  /** Late-bind the Telegram bridge so the send_telegram_message action can use it.
   *  Set during main.ts wiring; safe to leave null in tests. */
  setTelegramChannel(channel: TelegramChannel): void {
    this.telegramChannel = channel;
  }

  /**
   * Start a new DAG execution run.
   * Returns the runId immediately; execution proceeds asynchronously.
   */
  async startRun(webContents: WebContents, request: EngineRunRequest): Promise<string> {
    const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const abortController = new AbortController();

    // Build registry with all built-in actions
    const registry = this.createRegistry(webContents);

    // Sanitize the incoming DAG: drop dependsOn / inputMappings entries that
    // reference non-step ids (steps that were deleted after the mapping was
    // saved). The synthetic "__trigger__" node is allowed when triggerPayload
    // is provided so steps can read its fields via inputMappings.
    const validSourceIds = new Set(request.dag.steps.map((s) => s.id));
    if (request.triggerPayload) validSourceIds.add('__trigger__');
    for (const step of request.dag.steps) {
      step.dependsOn = step.dependsOn.filter((id) => validSourceIds.has(id));
      step.inputMappings = (step.inputMappings ?? []).filter((m) =>
        validSourceIds.has(m.sourceStepId),
      );
    }

    // Validate DAG before execution
    validateDAG(request.dag, registry);

    // Create per-run resources
    const scratchpad = new RunScratchpad();
    const eventBuffer: ExecutionEvent[] = [];
    this.eventBuffers.set(runId, eventBuffer);
    const emitter = new RunEventEmitter(
      webContents,
      runId,
      (event) => { eventBuffer.push(event); },
      this.sharedBus,
      { routineId: request.routineId },
    );

    // Track this run
    const activeRun: ActiveEngineRun = {
      runId,
      abortController,
      emitter,
      startedAt: Date.now(),
      routineId: request.routineId,
    };
    this.activeRuns.set(runId, activeRun);

    // Persist run record, then batch-create step records. These must be
    // chained — if the step POST races ahead of the run POST the backend
    // returns 404 and step records (incl. output_json) are never persisted.
    const stepRecordIdMap = new Map<string, string>();
    const stepBodies = request.dag.steps.map((step, index) => {
      const stepRecordId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      stepRecordIdMap.set(step.id, stepRecordId);
      return {
        id: stepRecordId,
        step_id: step.id,
        step_name: step.name,
        action_type: step.actionType,
        status: 'pending',
        order_index: index,
      };
    });
    const runPersisted: Promise<unknown> = this.backendRequest('POST', '/engine/runs', {
      id: runId,
      routine_id: request.routineId ?? null,
      run_type: 'routine',
      trigger: request.triggerSource ?? 'manual',
      dag_json: JSON.stringify(request.dag),
      total_steps: request.dag.steps.length,
    })
      .then(() => this.backendRequest('POST', `/engine/runs/${runId}/steps`, stepBodies));
    runPersisted.catch(console.error);

    // Emit run_started
    emitter.emit({
      type: 'run_started',
      runId,
      totalSteps: request.dag.steps.length,
      timestamp: new Date().toISOString(),
    });

    // Step persistence callback (tracks actual completions for the run record).
    // We track every queued PATCH so the terminal (`run_completed`/`_failed`)
    // event is only emitted after step records are durable — otherwise any
    // consumer that fetches `/engine/runs/{id}` in response to that event
    // sees a partially-updated view (steps still `pending`, output_json null).
    let completedStepCount = 0;
    const stepPatchPromises: Promise<unknown>[] = [];
    const onStepUpdate = (stepId: string, update: StepPersistenceUpdate) => {
      const stepRecordId = stepRecordIdMap.get(stepId);
      if (!stepRecordId) return;
      if (update.status === 'completed') completedStepCount++;
      // Chain after run+step POSTs so PATCH can never 404 due to race.
      const patch = runPersisted
        .then(() => this.backendRequest('PATCH', `/engine/runs/${runId}/steps/${stepRecordId}`, update))
        .catch(console.error);
      stepPatchPromises.push(patch);
    };

    // Approval callback: pauses run and waits for user decision
    const onApprovalRequired = (step: StepDefinition): Promise<boolean> => {
      return new Promise<boolean>((resolvePromise) => {
        const approvalId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

        // Prefer the user-authored summary (configured on the Approval Gate
        // step) over the generic fallback — routine authors rely on it to
        // explain *what* the reviewer is being asked to approve.
        const authoredSummary =
          typeof step.params?.summary === 'string' ? step.params.summary.trim() : '';
        const approvalSummary =
          authoredSummary || `Step "${step.name}" requires your approval before execution.`;

        // Persist approval request to backend
        this.backendRequest('POST', '/engine/approvals', {
          id: approvalId,
          run_id: runId,
          step_id: step.id,
          step_name: step.name,
          summary: approvalSummary,
          payload_json: JSON.stringify(step.params),
        }).catch(console.error);

        // Update step record with approval info
        const stepRecordId = stepRecordIdMap.get(step.id);
        if (stepRecordId) {
          this.backendRequest('PATCH', `/engine/runs/${runId}/steps/${stepRecordId}`, {
            approval_id: approvalId,
            approval_status: 'pending',
          }).catch(console.error);
        }

        // Set run status to paused
        this.backendRequest('PATCH', `/engine/runs/${runId}`, {
          status: 'paused',
        }).catch(console.error);

        // Emit approval_requested event
        emitter.emit({
          type: 'approval_requested',
          runId,
          stepId: step.id,
          approvalId,
          summary: approvalSummary,
          payload: step.params,
          timestamp: new Date().toISOString(),
        });

        // Store pending approval for later resolution
        this.pendingApprovals.set(approvalId, {
          runId,
          stepId: step.id,
          stepRecordId,
          resolve: resolvePromise,
        });
      });
    };

    // Create executor
    const executor = new DAGExecutor(
      request.dag,
      registry,
      scratchpad,
      emitter,
      {
        runId,
        backendPort: this.backendPort,
        signal: abortController.signal,
        onStepUpdate,
        onApprovalRequired,
        triggerPayload: request.triggerPayload,
      },
    );

    // Execute asynchronously (non-blocking)
    const startTime = Date.now();
    executor
      .execute()
      .then(async () => {
        // Flush queued step PATCHes before the terminal event fires so the
        // run record is consistent with what the event announces.
        await Promise.all(stepPatchPromises);
        const durationMs = Date.now() - startTime;
        emitter.emit({
          type: 'run_completed',
          runId,
          durationMs,
          timestamp: new Date().toISOString(),
        });

        // Persist run completion
        this.backendRequest('PATCH', `/engine/runs/${runId}`, {
          status: 'completed',
          completed_steps: completedStepCount,
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
        }).catch(console.error);
      })
      .catch(async (err: Error) => {
        // Same flush rationale as the success path.
        await Promise.all(stepPatchPromises);
        const isCancelled = abortController.signal.aborted;
        const isDenied = err instanceof StepDeniedError;

        if (isCancelled || isDenied) {
          emitter.emit({
            type: 'run_cancelled',
            runId,
            reason: isDenied ? 'Approval denied' : 'Run was cancelled',
            timestamp: new Date().toISOString(),
          });
          this.backendRequest('PATCH', `/engine/runs/${runId}`, {
            status: 'cancelled',
            error: isDenied ? 'Approval denied' : undefined,
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
          }).catch(console.error);
        } else {
          const failedStepId = err instanceof StepFailedError ? err.stepId : 'unknown';
          emitter.emit({
            type: 'run_failed',
            runId,
            error: err.message,
            failedStepId,
            timestamp: new Date().toISOString(),
          });
          this.backendRequest('PATCH', `/engine/runs/${runId}`, {
            status: 'failed',
            error: err.message,
            failed_step_id: failedStepId,
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
          }).catch(console.error);
        }
      })
      .finally(() => {
        // Batch-persist event buffer
        const buffer = emitter.getBuffer();
        if (buffer.length > 0) {
          const events = buffer.map((event, i) => ({
            seq: i,
            event_type: event.type,
            step_id: 'stepId' in event ? (event as Record<string, unknown>).stepId as string : null,
            payload_json: JSON.stringify(event),
            timestamp: 'timestamp' in event ? (event as Record<string, unknown>).timestamp as string : new Date().toISOString(),
          }));
          this.backendRequest('POST', `/engine/runs/${runId}/events`, { events })
            .catch(console.error);
        }

        scratchpad.clear();
        this.activeRuns.delete(runId);

        // Keep event buffer briefly for late subscribers, then clean up
        setTimeout(() => this.eventBuffers.delete(runId), EVENT_BUFFER_TTL_MS);
      });

    return runId;
  }

  /** Cancel a running DAG execution. */
  cancelRun(runId: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run) return false;

    // Deny all pending approvals for this run
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.runId === runId) {
        pending.resolve(false);
        this.pendingApprovals.delete(approvalId);

        // Persist denial to backend
        this.backendRequest('PATCH', `/engine/approvals/${approvalId}/resolve`, {
          decision: 'denied',
          reason: 'Run was cancelled',
        }).catch(console.error);

        // Emit denial event
        run.emitter.emit({
          type: 'approval_denied',
          runId,
          stepId: pending.stepId,
          approvalId,
          reason: 'Run was cancelled',
          timestamp: new Date().toISOString(),
        });
      }
    }

    run.abortController.abort();
    this.activeRuns.delete(runId);
    return true;
  }

  /** Resolve a pending approval request. */
  async resolveApproval(approvalId: string, approved: boolean, reason?: string): Promise<boolean> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;

    this.pendingApprovals.delete(approvalId);

    // Persist decision to backend
    await this.backendRequest('PATCH', `/engine/approvals/${approvalId}/resolve`, {
      decision: approved ? 'approved' : 'denied',
      reason: reason ?? null,
    });

    // Update step record's approval_status
    if (pending.stepRecordId) {
      this.backendRequest('PATCH', `/engine/runs/${pending.runId}/steps/${pending.stepRecordId}`, {
        approval_status: approved ? 'approved' : 'denied',
      }).catch(console.error);
    }

    // Get the emitter for this run
    const run = this.activeRuns.get(pending.runId);
    if (run) {
      if (approved) {
        // Resume run
        this.backendRequest('PATCH', `/engine/runs/${pending.runId}`, {
          status: 'running',
        }).catch(console.error);
        run.emitter.emit({
          type: 'approval_granted',
          runId: pending.runId,
          stepId: pending.stepId,
          approvalId,
          timestamp: new Date().toISOString(),
        });
      } else {
        run.emitter.emit({
          type: 'approval_denied',
          runId: pending.runId,
          stepId: pending.stepId,
          approvalId,
          reason,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Resolve the promise to unblock the executor
    pending.resolve(approved);
    return true;
  }

  /** Get info about all active runs. */
  getActiveRuns(): EngineActiveRunInfo[] {
    return Array.from(this.activeRuns.values()).map((run) => ({
      runId: run.runId,
      routineId: run.routineId,
      startedAt: run.startedAt,
    }));
  }

  /** Get buffered events for a run (active or recently completed). */
  getBufferedEvents(runId: string): ExecutionEvent[] {
    return this.eventBuffers.get(runId) ?? [];
  }

  /** Create an ActionRegistry populated with all built-in actions. */
  private createRegistry(webContents: WebContents): ActionRegistry {
    const registry = new ActionRegistry();

    // Core / legacy
    registry.register(askAiAction);
    registry.register(modelCallAction); // legacy alias for old DAGs
    registry.register(transformerAction);
    const expertStepAction = createExpertStepAction({
      agentRuntime: this.agentRuntime,
      webContents,
    });
    registry.register(expertStepAction);
    // UI-facing alias: the canvas serializes steps with actionType "run_expert"
    // (see ACTION_META), but the engine's action identifier is "expert_step".
    // Register the same definition under both keys so routines built in the
    // UI execute without needing a separate migration pass.
    registry.register({ ...expertStepAction, type: 'run_expert' });
    registry.register(approvalGateAction);

    // Logic
    registry.register(conditionAction);
    registry.register(delayAction);
    registry.register(loopAction);

    // AI
    registry.register(classifyAction);
    registry.register(extractAction);
    registry.register(summarizeAction);

    // Knowledge
    registry.register(searchMemoryAction);
    registry.register(searchWebAction);
    registry.register(searchDocumentsAction);
    registry.register(saveToMemoryAction);

    // Integrations
    registry.register(httpRequestAction);
    registry.register(runCommandAction);
    registry.register(runClaudeCodeAction);

    // Output
    registry.register(sendMessageAction);
    registry.register(sendNotificationAction);
    registry.register(channelAction);
    // Resolve the channel lazily (via getter) so calling setTelegramChannel
    // after registry construction still works, and so each run picks up the
    // currently-bound bridge instance.
    registry.register(createSendTelegramAction({ getChannel: () => this.telegramChannel }));

    // Complex (depend on backend infrastructure)
    registry.register(waitForWebhookAction);
    registry.register(runScriptAction);

    return registry;
  }

  /** Fire-and-forget HTTP request to the backend. */
  private backendRequest<T>(method: string, path: string, body: unknown): Promise<T | null> {
    return new Promise((resolve) => {
      const bodyStr = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.backendPort,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr).toString(),
          },
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
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(bodyStr);
      req.end();
    });
  }
}
