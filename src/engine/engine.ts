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
import { createSendWhatsAppAction } from './actions/send-whatsapp-message';
import type { WhatsAppChannel } from './actions/whatsapp-channel';
import { createHubSpotCreateTicketAction } from './actions/hubspot-create-ticket';
import { createHubSpotUpsertContactAction } from './actions/hubspot-upsert-contact';
import type { HubSpotChannel } from './actions/hubspot-channel';
import { RunScratchpad } from './scratchpad';
import { RunEventEmitter, ENGINE_EVENT, type EngineEventContext } from './events/emitter';
import { validateDAG } from './dag/validator';
import { DAGExecutor, StepFailedError, StepDeniedError } from './dag/executor';
import type { ExecutionEvent } from './events/types';
import type { StepDefinition, DAGDefinition } from './dag/types';
import type { ActionDefinition, ChatActionAvailability } from './actions/types';
import { wrapForDryRun } from './dry-run-stubs';

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
  private whatsAppChannel: WhatsAppChannel | null = null;
  private hubSpotChannel: HubSpotChannel | null = null;
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

  /** Late-bind the WhatsApp (Baileys) bridge so send_whatsapp_message can use it. */
  setWhatsAppChannel(channel: WhatsAppChannel): void {
    this.whatsAppChannel = channel;
  }

  /** Late-bind the HubSpot credential holder so hubspot_* actions can use it. */
  setHubSpotChannel(channel: HubSpotChannel): void {
    this.hubSpotChannel = channel;
  }

  /**
   * Start a new DAG execution run.
   * Returns the runId immediately; execution proceeds asynchronously.
   */
  async startRun(webContents: WebContents, request: EngineRunRequest): Promise<string> {
    const runId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const abortController = new AbortController();

    // Build registry with all built-in actions. In dry-run mode, every
    // side-effecty action is wrapped to return synthetic success so we
    // exercise the executor end-to-end without real API calls.
    const baseRegistry = this.createRegistry(webContents);
    const registry = request.dryRun ? this.toDryRunRegistry(baseRegistry) : baseRegistry;

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

    // Validate DAG before execution. Tell the validator which synthetic source
    // ids (besides real steps) are legal — currently just the trigger node when
    // a triggerPayload is provided, matching what the executor seeds.
    const extraValidSourceIds = request.triggerPayload
      ? new Set(['__trigger__'])
      : new Set<string>();
    validateDAG(request.dag, registry, extraValidSourceIds);

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
      run_type: request.runType ?? 'routine',
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

    // In dry-run mode, every approval gate auto-passes. The skill that
    // proposed the routine has already gathered explicit user consent
    // before invoking us, so we don't want to block the test run waiting
    // for clicks on every gate the routine declares.
    const onApprovalRequired = request.dryRun
      ? () => Promise.resolve(true)
      : (step: StepDefinition): Promise<boolean> => {
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

  // ── Chat action helpers ──────────────────────────────────────────

  /**
   * Build the list of chat-exposable action definitions. Reuses the same
   * factories as `createRegistry`, so channel-bound actions (HubSpot,
   * Telegram, WhatsApp) read from the live channel singletons. Built on
   * demand and not cached: availability can change between calls.
   *
   * Note: skips actions that need a `WebContents` (e.g. expert_step) — none
   * of them are chat-exposable today.
   */
  private buildChatExposableDefs(): ActionDefinition[] {
    const defs: ActionDefinition[] = [
      httpRequestAction,
      sendNotificationAction,
      createSendTelegramAction({ getChannel: () => this.telegramChannel }),
      createSendWhatsAppAction({ getChannel: () => this.whatsAppChannel }),
      createHubSpotCreateTicketAction({ getChannel: () => this.hubSpotChannel }),
      createHubSpotUpsertContactAction({ getChannel: () => this.hubSpotChannel }),
    ];
    return defs.filter((d) => d.chatExposable === true);
  }

  /**
   * Returns the chat-action catalog the chat skill and Help modal render.
   * `lang` selects the locale of `label`/`description`/`examples`.
   */
  getChatActionCatalog(lang: 'en' | 'es' = 'en'): Array<{
    type: string;
    label: string;
    description: string;
    examples: string[];
    availability: ChatActionAvailability;
    group: string;
    setupHref?: string;
    inputSchema: Record<string, unknown>;
  }> {
    return this.buildChatExposableDefs().map((def) => ({
      type: def.type,
      label: def.chatLabel?.[lang] ?? def.name,
      description: def.chatDescription?.[lang] ?? def.description,
      examples: (def.chatExamples ?? []).map((e) => e[lang]),
      availability: def.availabilityCheck?.() ?? 'available',
      group: def.chatGroup ?? 'other',
      setupHref: def.setupHref,
      inputSchema: def.inputSchema,
    }));
  }

  /**
   * Run a single chat-triggered action through the routine engine. Always
   * gates on approval (per product decision). Resolves when the underlying
   * run reaches a terminal state. Long-running by design: the chat subprocess
   * holds the HTTP connection open until this returns.
   */
  async runChatAction(
    webContents: WebContents,
    options: {
      type: string;
      params: Record<string, unknown>;
      conversationId?: string;
    },
  ): Promise<{
    status: 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'unavailable';
    runId?: string;
    approvalId?: string;
    summary?: string;
    data?: Record<string, unknown>;
    error?: string;
  }> {
    const def = this.buildChatExposableDefs().find((d) => d.type === options.type);
    if (!def) {
      return { status: 'failed', error: `Unknown chat action: ${options.type}` };
    }
    const availability = def.availabilityCheck?.() ?? 'available';
    if (availability !== 'available') {
      return { status: 'unavailable', error: `Action "${def.name}" is not connected.` };
    }

    const stepId = 'step_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const dag = {
      steps: [
        {
          id: stepId,
          name: def.chatLabel?.en ?? def.name,
          actionType: def.type,
          params: options.params,
          dependsOn: [],
          inputMappings: [],
          requiresApproval: true,
          onError: 'fail' as const,
        },
      ],
    };

    let runId: string;
    try {
      runId = await this.startRun(webContents, {
        dag,
        triggerSource: 'chat',
        runType: 'chat_action',
      });
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }

    return new Promise((resolve) => {
      let approvalId: string | undefined;
      let resolved = false;

      const cleanup = () => {
        if (this.sharedBus) {
          this.sharedBus.off(ENGINE_EVENT, listener);
        }
      };

      const finish = (
        result: Awaited<ReturnType<ExecutionEngine['runChatAction']>>,
      ) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      const listener = (event: ExecutionEvent, ctx: EngineEventContext) => {
        if (ctx.runId !== runId) return;
        if (event.type === 'approval_requested') {
          approvalId = event.approvalId;
          return;
        }
        if (event.type === 'run_completed') {
          // Step output lives on the persisted step record. Fetch it so we can
          // return structured data (ticket_id, message_id, etc.) to the chat.
          this.fetchStepOutput(event.runId, stepId)
            .then((step) => {
              finish({
                status: 'succeeded',
                runId: event.runId,
                approvalId,
                summary: step?.summary ?? 'Action completed.',
                data: step?.data ?? {},
              });
            })
            .catch(() => {
              finish({ status: 'succeeded', runId: event.runId, approvalId, summary: 'Action completed.' });
            });
          return;
        }
        if (event.type === 'run_cancelled') {
          finish({
            status: 'denied',
            runId: event.runId,
            approvalId,
            error: event.reason ?? 'Action was cancelled.',
          });
          return;
        }
        if (event.type === 'run_failed') {
          finish({
            status: 'failed',
            runId: event.runId,
            approvalId,
            error: event.error,
          });
        }
      };

      if (this.sharedBus) {
        this.sharedBus.on(ENGINE_EVENT, listener);
      }
    });
  }

  /**
   * Run a candidate routine DAG end-to-end with side-effecty actions stubbed.
   * Used to verify that a Cerebro-proposed routine wires correctly before we
   * persist it. Returns per-step status so the caller can show the user
   * exactly which step failed and why.
   *
   * Long-running by design (a routine with many LLM-shaped or HTTP steps can
   * take a minute or two even with stubs); the chat skill that calls us is
   * expected to tell the user "this can take a couple of minutes".
   */
  async dryRunRoutine(
    webContents: WebContents,
    options: {
      dag: DAGDefinition;
      triggerPayload?: Record<string, unknown>;
    },
  ): Promise<{
    ok: boolean;
    runId: string;
    error?: string;
    failedStepId?: string;
    steps: Array<{
      stepId: string;
      stepName: string;
      actionType: string;
      status: 'completed' | 'failed' | 'skipped' | 'pending';
      summary?: string;
      error?: string;
      durationMs?: number;
    }>;
  }> {
    const stepEvents = new Map<
      string,
      {
        stepId: string;
        stepName: string;
        actionType: string;
        status: 'completed' | 'failed' | 'skipped' | 'pending';
        summary?: string;
        error?: string;
        durationMs?: number;
      }
    >();
    for (const s of options.dag.steps) {
      stepEvents.set(s.id, {
        stepId: s.id,
        stepName: s.name,
        actionType: s.actionType,
        status: 'pending',
      });
    }

    let runId: string;
    try {
      runId = await this.startRun(webContents, {
        dag: options.dag,
        triggerSource: 'manual',
        runType: 'preview',
        triggerPayload: options.triggerPayload,
        dryRun: true,
      });
    } catch (err) {
      return {
        ok: false,
        runId: '',
        error: err instanceof Error ? err.message : String(err),
        steps: Array.from(stepEvents.values()),
      };
    }

    return new Promise((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (this.sharedBus) this.sharedBus.off(ENGINE_EVENT, listener);
      };

      const finish = (ok: boolean, error?: string, failedStepId?: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({
          ok,
          runId,
          error,
          failedStepId,
          steps: options.dag.steps.map((s) => stepEvents.get(s.id)!),
        });
      };

      const listener = (event: ExecutionEvent, ctx: EngineEventContext) => {
        if (ctx.runId !== runId) return;
        if (event.type === 'step_started') {
          const slot = stepEvents.get(event.stepId);
          if (slot) slot.actionType = event.actionType;
        } else if (event.type === 'step_completed') {
          const slot = stepEvents.get(event.stepId);
          if (slot) {
            slot.status = 'completed';
            slot.summary = event.summary;
            slot.durationMs = event.durationMs;
          }
        } else if (event.type === 'step_failed') {
          const slot = stepEvents.get(event.stepId);
          if (slot) {
            slot.status = 'failed';
            slot.error = event.error;
          }
        } else if (event.type === 'step_skipped') {
          const slot = stepEvents.get(event.stepId);
          if (slot) {
            slot.status = 'skipped';
            slot.error = event.reason;
          }
        } else if (event.type === 'run_completed') {
          finish(true);
        } else if (event.type === 'run_failed') {
          finish(false, event.error, event.failedStepId);
        } else if (event.type === 'run_cancelled') {
          finish(false, event.reason ?? 'Dry-run was cancelled');
        }
      };

      if (this.sharedBus) this.sharedBus.on(ENGINE_EVENT, listener);
    });
  }

  /** Helper for runChatAction — read a step record's output and summary. */
  private async fetchStepOutput(
    runId: string,
    stepId: string,
  ): Promise<{ data: Record<string, unknown>; summary: string } | null> {
    const run = await this.backendRequest<{
      steps?: Array<{ step_id: string; output_json: string | null; summary: string | null }>;
    }>('GET', `/engine/runs/${runId}`, null);
    if (!run?.steps) return null;
    const step = run.steps.find((s) => s.step_id === stepId);
    if (!step) return null;
    let data: Record<string, unknown> = {};
    if (step.output_json) {
      try {
        data = JSON.parse(step.output_json) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    return { data, summary: step.summary ?? '' };
  }

  /** Wrap every action in a registry with the dry-run stub. Actions that
   *  don't have a stub (control-flow: condition, loop, delay, transformer)
   *  pass through unchanged so we still exercise the routine's real logic. */
  private toDryRunRegistry(source: ActionRegistry): ActionRegistry {
    const wrapped = new ActionRegistry();
    for (const def of source.list()) {
      wrapped.register(wrapForDryRun(def));
    }
    return wrapped;
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
    registry.register(createSendWhatsAppAction({ getChannel: () => this.whatsAppChannel }));

    // HubSpot (outbound only)
    registry.register(createHubSpotCreateTicketAction({ getChannel: () => this.hubSpotChannel }));
    registry.register(createHubSpotUpsertContactAction({ getChannel: () => this.hubSpotChannel }));

    // Complex (depend on backend infrastructure)
    registry.register(waitForWebhookAction);
    registry.register(runScriptAction);

    return registry;
  }

  /** Fire-and-forget HTTP request to the backend. */
  private backendRequest<T>(method: string, path: string, body: unknown): Promise<T | null> {
    return new Promise((resolve) => {
      const hasBody = body !== null && body !== undefined;
      const bodyStr = hasBody ? JSON.stringify(body) : '';
      const headers: Record<string, string> = {};
      if (hasBody) {
        headers['Content-Type'] = 'application/json';
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
      if (hasBody) req.write(bodyStr);
      req.end();
    });
  }
}
