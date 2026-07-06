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
import type { EngineRunRequest, StepDefinition, DAGDefinition } from './dag/types';
import type { EngineActiveRunInfo } from '../types/ipc';
import type { AutoApprovalRule } from '../types/approvals';
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
import { createSendSlackMessageAction } from './actions/send-slack-message';
import { createSendSlackFileAction } from './actions/send-slack-file';
import { createListSlackChannelsAction } from './actions/list-slack-channels';
import {
  createSendTelegramMediaActions,
  createSendTelegramLocationAction,
} from './actions/send-telegram-media';
import {
  createSendWhatsAppMediaActions,
  createSendWhatsAppLocationAction,
} from './actions/send-whatsapp-media';
import type { TelegramChannel } from './actions/telegram-channel';
import type { SlackChannel } from './actions/slack-channel';
import { createSendWhatsAppAction } from './actions/send-whatsapp-message';
import type { WhatsAppChannel } from './actions/whatsapp-channel';
import { createHubSpotCreateTicketAction } from './actions/hubspot-create-ticket';
import { createHubSpotUpsertContactAction } from './actions/hubspot-upsert-contact';
import { createHubSpotSearchContactAction } from './actions/hubspot-search-contact';
import { createHubSpotSearchTicketsAction } from './actions/hubspot-search-tickets';
import { createHubSpotGetTicketAction } from './actions/hubspot-get-ticket';
import { createN8nWorkflowActions } from './actions/n8n-workflows';
import { createN8nExecutionActions } from './actions/n8n-executions';
import { createHubSpotUpdateTicketAction } from './actions/hubspot-update-ticket';
import {
  createHubSpotListObjectsAction,
  createHubSpotCreateObjectAction,
  createHubSpotUpdateObjectAction,
  createHubSpotDeleteObjectAction,
} from './actions/hubspot-crm-objects';
import {
  createHubSpotListListsAction,
  createHubSpotCreateListAction,
  createHubSpotUpdateListAction,
  createHubSpotDeleteListAction,
  createHubSpotListMembershipAction,
} from './actions/hubspot-lists';
import type { HubSpotChannel } from './actions/hubspot-channel';
import type { N8nChannel } from './actions/n8n-channel';
import type { CalendarChannel } from './actions/calendar-channel';
import { createCalendarCreateEventAction } from './actions/calendar-create-event';
import { createCalendarUpdateEventAction } from './actions/calendar-update-event';
import { createCalendarDeleteEventAction } from './actions/calendar-delete-event';
import { createCalendarRsvpAction } from './actions/calendar-rsvp';
import { createCalendarQueryEventsAction } from './actions/calendar-query-events';
import type { GmailChannel } from './actions/gmail-channel';
import { createGmailSearchMessagesAction } from './actions/gmail-search-messages';
import { createGmailGetThreadAction } from './actions/gmail-get-thread';
import { createGmailListLabelsAction } from './actions/gmail-list-labels';
import { createGmailGetContactHistoryAction } from './actions/gmail-get-contact-history';
import { createGmailSendMessageAction } from './actions/gmail-send-message';
import { createGmailCreateDraftAction } from './actions/gmail-create-draft';
import { createGmailModifyLabelsAction } from './actions/gmail-modify-labels';
import { createGmailListAwaitingReplyAction } from './actions/gmail-list-awaiting-reply';
import { createGmailLogToHubSpotAction } from './actions/gmail-log-to-hubspot';
import { createCalendarFindFreeTimeAction } from './actions/calendar-find-free-time';
import { createGitHubCreateIssueAction } from './actions/github-create-issue';
import { createGitHubCommentIssueAction } from './actions/github-comment-issue';
import { createGitHubCommentPrAction } from './actions/github-comment-pr';
import { createGitHubReviewPrAction } from './actions/github-review-pr';
import { createGitHubOpenPrAction } from './actions/github-open-pr';
import { createGitHubFetchIssueAction } from './actions/github-fetch-issue';
import { createGitHubFetchPrAction } from './actions/github-fetch-pr';
import { createGitHubCloneWorktreeAction } from './actions/github-clone-worktree';
import { createGitHubCommitAndPushAction } from './actions/github-commit-and-push';
import type { GitHubChannel } from './actions/github-channel';
import { RunScratchpad } from './scratchpad';
import { RunEventEmitter, ENGINE_EVENT, type EngineEventContext } from './events/emitter';
import { validateDAG } from './dag/validator';
import { DAGExecutor, StepFailedError, StepDeniedError } from './dag/executor';
import type { ExecutionEvent } from './events/types';
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

/**
 * The input param that names a send action's destination, so a "don't ask
 * again" rule can be scoped to one exact channel / chat / recipient. This map
 * is the **destination resolver only** — it no longer decides eligibility.
 * Eligibility (which actions/modules can have a rule at all) is decided by
 * `autoApprovalSupported()` off the live action catalog, so a per-action ('*')
 * or per-module rule can bypass the gate even for actions absent from this map
 * (e.g. HubSpot/GitHub/calendar writes, which have no single destination param).
 */
export const AUTO_APPROVAL_TARGET_PARAM: Record<string, string> = {
  // Slack — channel id (C…/G…/D…)
  send_slack_message: 'channel',
  send_slack_file: 'channel',
  // Telegram — numeric chat id
  send_telegram_message: 'chat_id',
  send_telegram_photo: 'chat_id',
  send_telegram_document: 'chat_id',
  send_telegram_audio: 'chat_id',
  send_telegram_voice: 'chat_id',
  send_telegram_video: 'chat_id',
  send_telegram_sticker: 'chat_id',
  send_telegram_location: 'chat_id',
  // WhatsApp — phone number (E.164) or full JID
  send_whatsapp_message: 'phone_number',
  send_whatsapp_photo: 'phone_number',
  send_whatsapp_document: 'phone_number',
  send_whatsapp_audio: 'phone_number',
  send_whatsapp_voice: 'phone_number',
  send_whatsapp_video: 'phone_number',
  send_whatsapp_sticker: 'phone_number',
  send_whatsapp_location: 'phone_number',
  // Gmail — recipient address(es)
  gmail_send_message: 'to',
};

/** Sentinel `target_key` meaning "any destination" — used by per-action and
 *  per-module rules (e.g. all HubSpot writes, regardless of which record). */
const AUTO_APPROVAL_ANY_TARGET = '*';

/** Prefix that turns a `chatGroup` into a module-scoped rule's `action_type`
 *  (e.g. `module:hubspot` → every HubSpot write skips the gate). */
const AUTO_APPROVAL_MODULE_PREFIX = 'module:';

export class ExecutionEngine {
  private backendPort: number;
  private agentRuntime: AgentRuntime;
  private sharedBus?: EventEmitter;
  private telegramChannel: TelegramChannel | null = null;
  private slackChannel: SlackChannel | null = null;
  private whatsAppChannel: WhatsAppChannel | null = null;
  private hubSpotChannel: HubSpotChannel | null = null;
  private n8nChannel: N8nChannel | null = null;
  private gitHubChannel: GitHubChannel | null = null;
  private calendarChannel: CalendarChannel | null = null;
  private gmailChannel: GmailChannel | null = null;
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

  /** Late-bind the Slack bridge so send_slack_* actions can use it. */
  setSlackChannel(channel: SlackChannel): void {
    this.slackChannel = channel;
  }

  /** Late-bind the WhatsApp (Baileys) bridge so send_whatsapp_message can use it. */
  setWhatsAppChannel(channel: WhatsAppChannel): void {
    this.whatsAppChannel = channel;
  }

  /** Late-bind the HubSpot credential holder so hubspot_* actions can use it. */
  setHubSpotChannel(channel: HubSpotChannel): void {
    this.hubSpotChannel = channel;
  }

  /** Late-bind the n8n manager so n8n_* actions can use it. */
  setN8nChannel(channel: N8nChannel): void {
    this.n8nChannel = channel;
  }

  /** Late-bind the GitHub bridge so github_* actions can use it. */
  setGitHubChannel(channel: GitHubChannel): void {
    this.gitHubChannel = channel;
  }

  /** Late-bind the Gmail bridge so gmail_* actions can use it. */
  setGmailChannel(channel: GmailChannel): void {
    this.gmailChannel = channel;
  }

  /** Late-bind the Calendar bridge so calendar_* actions can use it. */
  setCalendarChannel(channel: CalendarChannel): void {
    this.calendarChannel = channel;
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
      (event) => {
        eventBuffer.push(event);
      },
      this.sharedBus,
      { routineId: request.routineId, conversationId: request.conversationId },
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
      // Persist the originating conversation so chat-triggered approvals can be
      // surfaced and resolved inline in that chat (InlineApprovals filters on
      // it). Routine/cron runs have no conversation → null, so they stay on the
      // Approvals screen only.
      conversation_id: request.conversationId ?? null,
      run_type: request.runType ?? 'routine',
      trigger: request.triggerSource ?? 'manual',
      dag_json: JSON.stringify(request.dag),
      total_steps: request.dag.steps.length,
    }).then(() => this.backendRequest('POST', `/engine/runs/${runId}/steps`, stepBodies));
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
        .then(() =>
          this.backendRequest('PATCH', `/engine/runs/${runId}/steps/${stepRecordId}`, update),
        )
        .catch(console.error);
      stepPatchPromises.push(patch);
    };

    // In dry-run mode, every approval gate auto-passes. The skill that
    // proposed the routine has already gathered explicit user consent
    // before invoking us, so we don't want to block the test run waiting
    // for clicks on every gate the routine declares.
    const onApprovalRequired = request.dryRun
      ? () => Promise.resolve(true)
      : async (step: StepDefinition): Promise<boolean> => {
          const approvalId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

          // Prefer the user-authored summary (configured on the Approval Gate
          // step) over the generic fallback — routine authors rely on it to
          // explain *what* the reviewer is being asked to approve.
          const authoredSummary =
            typeof step.params?.summary === 'string' ? step.params.summary.trim() : '';
          const approvalSummary =
            authoredSummary || `Step "${step.name}" requires your approval before execution.`;

          const stepRecordId = stepRecordIdMap.get(step.id);

          // Persist (and commit) the approval BEFORE announcing it, chained after
          // the run+step records so it can't 404 ("Run record not found"). The
          // renderer refreshes its pending list the instant it sees
          // approval_requested; awaiting the write here guarantees that refresh's
          // GET sees the committed row instead of racing ahead of the insert —
          // otherwise the badge stays at 0 until the Approvals screen remounts.
          await runPersisted
            .then(() =>
              this.backendRequest('POST', '/engine/approvals', {
                id: approvalId,
                run_id: runId,
                step_id: step.id,
                step_name: step.name,
                summary: approvalSummary,
                payload_json: JSON.stringify(step.params),
              }),
            )
            .catch(console.error);

          // Link the approval to the step record and pause the run. These don't
          // gate the announce, so leave them fire-and-forget — but still chain
          // after runPersisted for the same 404-safety as onStepUpdate.
          if (stepRecordId) {
            runPersisted
              .then(() =>
                this.backendRequest('PATCH', `/engine/runs/${runId}/steps/${stepRecordId}`, {
                  approval_id: approvalId,
                  approval_status: 'pending',
                }),
              )
              .catch(console.error);
          }
          runPersisted
            .then(() =>
              this.backendRequest('PATCH', `/engine/runs/${runId}`, {
                status: 'paused',
              }),
            )
            .catch(console.error);

          return new Promise<boolean>((resolvePromise) => {
            // Emit approval_requested event (the approval row is now durable).
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
    const executor = new DAGExecutor(request.dag, registry, scratchpad, emitter, {
      runId,
      backendPort: this.backendPort,
      signal: abortController.signal,
      onStepUpdate,
      onApprovalRequired,
      triggerPayload: request.triggerPayload,
    });

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
            step_id:
              'stepId' in event ? ((event as Record<string, unknown>).stepId as string) : null,
            payload_json: JSON.stringify(event),
            timestamp:
              'timestamp' in event
                ? ((event as Record<string, unknown>).timestamp as string)
                : new Date().toISOString(),
          }));
          this.backendRequest('POST', `/engine/runs/${runId}/events`, { events }).catch(
            console.error,
          );
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
   * The HubSpot (outbound) action definitions, bound to the live channel
   * singleton. Single source of truth so the chat-exposable list and the
   * dry-run registry can't silently drift apart.
   */
  private n8nActionDefs(): ActionDefinition[] {
    const getChannel = () => this.n8nChannel;
    return [
      ...createN8nWorkflowActions({ getChannel }),
      ...createN8nExecutionActions({ getChannel }),
    ];
  }

  private hubSpotActionDefs(): ActionDefinition[] {
    const getChannel = () => this.hubSpotChannel;
    return [
      createHubSpotCreateTicketAction({ getChannel }),
      createHubSpotUpsertContactAction({ getChannel }),
      createHubSpotSearchContactAction({ getChannel }),
      createHubSpotSearchTicketsAction({ getChannel }),
      createHubSpotGetTicketAction({ getChannel }),
      createHubSpotUpdateTicketAction({ getChannel }),
      createHubSpotListObjectsAction({ getChannel }),
      createHubSpotCreateObjectAction({ getChannel }),
      createHubSpotUpdateObjectAction({ getChannel }),
      createHubSpotDeleteObjectAction({ getChannel }),
      createHubSpotListListsAction({ getChannel }),
      createHubSpotCreateListAction({ getChannel }),
      createHubSpotUpdateListAction({ getChannel }),
      createHubSpotDeleteListAction({ getChannel }),
      createHubSpotListMembershipAction({ getChannel }),
    ];
  }

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
      ...createSendTelegramMediaActions({
        getChannel: () => this.telegramChannel,
        backendPort: () => this.backendPort,
      }),
      createSendTelegramLocationAction({ getChannel: () => this.telegramChannel }),
      createSendSlackMessageAction({ getChannel: () => this.slackChannel }),
      createSendSlackFileAction({ getChannel: () => this.slackChannel }),
      createListSlackChannelsAction({ getChannel: () => this.slackChannel }),
      createSendWhatsAppAction({ getChannel: () => this.whatsAppChannel }),
      ...createSendWhatsAppMediaActions({
        getChannel: () => this.whatsAppChannel,
        backendPort: () => this.backendPort,
      }),
      createSendWhatsAppLocationAction({ getChannel: () => this.whatsAppChannel }),
      ...this.hubSpotActionDefs(),
      ...this.n8nActionDefs(),
      createGitHubCreateIssueAction({ getChannel: () => this.gitHubChannel }),
      createGitHubCommentIssueAction({ getChannel: () => this.gitHubChannel }),
      createGitHubCommentPrAction({ getChannel: () => this.gitHubChannel }),
      createGitHubReviewPrAction({ getChannel: () => this.gitHubChannel }),
      createGitHubOpenPrAction({ getChannel: () => this.gitHubChannel }),
      createCalendarCreateEventAction({ getChannel: () => this.calendarChannel }),
      createCalendarUpdateEventAction({ getChannel: () => this.calendarChannel }),
      createCalendarDeleteEventAction({ getChannel: () => this.calendarChannel }),
      createCalendarRsvpAction({ getChannel: () => this.calendarChannel }),
      createCalendarQueryEventsAction({ getChannel: () => this.calendarChannel }),
      createCalendarFindFreeTimeAction({ getChannel: () => this.calendarChannel }),
      ...this.gmailActionDefs(),
    ];
    return defs.filter((d) => d.chatExposable === true);
  }

  private gmailActionDefs(): ActionDefinition[] {
    return [
      createGmailSearchMessagesAction({ getChannel: () => this.gmailChannel }),
      createGmailGetThreadAction({ getChannel: () => this.gmailChannel }),
      createGmailListLabelsAction({ getChannel: () => this.gmailChannel }),
      createGmailGetContactHistoryAction({ getChannel: () => this.gmailChannel }),
      createGmailSendMessageAction({
        getChannel: () => this.gmailChannel,
        backendPort: () => this.backendPort,
      }),
      createGmailCreateDraftAction({ getChannel: () => this.gmailChannel }),
      createGmailModifyLabelsAction({ getChannel: () => this.gmailChannel }),
      createGmailListAwaitingReplyAction({ getChannel: () => this.gmailChannel }),
      createGmailLogToHubSpotAction({
        getChannel: () => this.gmailChannel,
        getHubSpot: () => this.hubSpotChannel,
      }),
    ];
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
    readOnly: boolean;
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
      // Read-only lookups run without the approval gate (see runChatAction).
      readOnly: def.readOnly === true,
    }));
  }

  /**
   * Run a single chat-triggered action through the routine engine. Writes and
   * sends gate on approval by default; read-only lookups (`def.readOnly`) run
   * immediately without a gate, and a send to a destination with a standing
   * "don't ask again" rule also skips it. Resolves when the underlying run
   * reaches a terminal state. Long-running by design: the chat subprocess holds
   * the HTTP connection open until this returns.
   */
  /**
   * True when a chat-triggered send targets the very channel/chat the current
   * conversation is already replying into — i.e. it would double-post the reply
   * the Slack/Telegram stream sink delivers automatically. Matches on
   * destination only (a send to a different channel/chat is legitimate) and only
   * for text sends — file/media uploads ride a separate path the guardrail
   * explicitly allows in the origin thread. Uses an EXACT conversationId match
   * against the bridges' in-flight runs, so routine runs and unrelated
   * conversations never trip it.
   */
  private detectSelfPost(
    type: string,
    params: Record<string, unknown>,
    conversationId: string | undefined,
  ): boolean {
    if (!conversationId) return false;
    if (type === 'send_slack_message' && this.slackChannel) {
      const origin = this.slackChannel.activeConversationOrigin(conversationId);
      const target = String(params.channel ?? '').trim();
      return !!origin && target !== '' && target === origin.channel;
    }
    if (type === 'send_telegram_message' && this.telegramChannel) {
      const chatId = this.telegramChannel.activeConversationChatId(conversationId);
      const target = String(params.chat_id ?? '').trim();
      return chatId !== null && target !== '' && target === String(chatId);
    }
    return false;
  }

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

    // Deterministic double-post guard. When the conversation originates from
    // Slack/Telegram the agent's reply is auto-delivered to that exact channel/
    // chat by the stream sink — so a send_* action the model fires at that same
    // destination would post the identical content twice. The prompt guardrail
    // (buildOriginPreamble) asks the model not to; this enforces it. Sends to a
    // DIFFERENT destination, file/media uploads, and routine runs (never in the
    // bridges' active-run maps) are untouched.
    if (this.detectSelfPost(def.type, options.params, options.conversationId)) {
      return {
        status: 'succeeded',
        summary: 'Reply already delivered to this conversation; skipped duplicate send.',
        data: { sent: false, skipped: true, reason: 'same_destination_as_origin' },
      };
    }

    // Read-only lookups (search/get/list/fetch/query) never mutate anything, so
    // they run without the approval gate — the same policy routines already use
    // (getStepDefaults defaults requiresApproval:false).
    //
    // Writes/sends pause for approval unless the user has recorded a "don't ask
    // again" rule that covers this action at any scope — this exact destination,
    // this whole action type, or this whole integration module (see
    // `isAutoApproved`). Anything without a matching rule still gates.
    let requiresApproval: boolean;
    if (def.readOnly) {
      requiresApproval = false;
    } else {
      requiresApproval = !(await this.isAutoApproved(def, options.params));
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
          requiresApproval,
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
        conversationId: options.conversationId,
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

      const finish = (result: Awaited<ReturnType<ExecutionEngine['runChatAction']>>) => {
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
              finish({
                status: 'succeeded',
                runId: event.runId,
                approvalId,
                summary: 'Action completed.',
              });
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
    for (const action of createSendTelegramMediaActions({
      getChannel: () => this.telegramChannel,
      backendPort: () => this.backendPort,
    })) {
      registry.register(action);
    }
    registry.register(createSendTelegramLocationAction({ getChannel: () => this.telegramChannel }));
    registry.register(createSendSlackMessageAction({ getChannel: () => this.slackChannel }));
    registry.register(createSendSlackFileAction({ getChannel: () => this.slackChannel }));
    registry.register(createListSlackChannelsAction({ getChannel: () => this.slackChannel }));
    registry.register(createSendWhatsAppAction({ getChannel: () => this.whatsAppChannel }));
    for (const action of createSendWhatsAppMediaActions({
      getChannel: () => this.whatsAppChannel,
      backendPort: () => this.backendPort,
    })) {
      registry.register(action);
    }
    registry.register(createSendWhatsAppLocationAction({ getChannel: () => this.whatsAppChannel }));

    // HubSpot (outbound only)
    for (const action of this.hubSpotActionDefs()) registry.register(action);

    // n8n (managed local instance)
    for (const action of this.n8nActionDefs()) registry.register(action);

    // GitHub
    registry.register(createGitHubCreateIssueAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubCommentIssueAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubCommentPrAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubReviewPrAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubOpenPrAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubFetchIssueAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubFetchPrAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubCloneWorktreeAction({ getChannel: () => this.gitHubChannel }));
    registry.register(createGitHubCommitAndPushAction({ getChannel: () => this.gitHubChannel }));

    // Calendar (Google + Outlook)
    registry.register(createCalendarCreateEventAction({ getChannel: () => this.calendarChannel }));
    registry.register(createCalendarUpdateEventAction({ getChannel: () => this.calendarChannel }));
    registry.register(createCalendarDeleteEventAction({ getChannel: () => this.calendarChannel }));
    registry.register(createCalendarRsvpAction({ getChannel: () => this.calendarChannel }));
    registry.register(createCalendarQueryEventsAction({ getChannel: () => this.calendarChannel }));
    registry.register(createCalendarFindFreeTimeAction({ getChannel: () => this.calendarChannel }));

    // Gmail
    for (const def of this.gmailActionDefs()) registry.register(def);

    // Complex (depend on backend infrastructure)
    registry.register(waitForWebhookAction);
    registry.register(runScriptAction);

    return registry;
  }

  // ── Auto-approval ("don't ask again") rules ──────────────────────

  /**
   * Whether a rule key is eligible for "don't ask again" at all. The bridge
   * rejects rules for anything that could never (meaningfully) skip the gate:
   *  - `module:<group>` — valid when that integration has ≥1 chat-exposable
   *    write action (read-only-only modules would never gate, so no rule needed).
   *  - a concrete action type — valid when it's a chat-exposable write. Read-only
   *    actions never gate (a rule is meaningless) and unknown types are rejected,
   *    so the bridge can surface `not_auto_approvable:<type>`.
   * Scope is independent of `AUTO_APPROVAL_TARGET_PARAM`: a per-action or
   * per-module rule covers actions with no single destination param too.
   */
  autoApprovalSupported(actionType: string): boolean {
    if (actionType.startsWith(AUTO_APPROVAL_MODULE_PREFIX)) {
      const group = actionType.slice(AUTO_APPROVAL_MODULE_PREFIX.length);
      return this.buildChatExposableDefs().some((d) => d.chatGroup === group && !d.readOnly);
    }
    return this.buildChatExposableDefs().some((d) => d.type === actionType && !d.readOnly);
  }

  /**
   * True when a "don't ask again" rule covers this write at any scope. Checks,
   * most-specific first: this exact destination → this whole action type → this
   * whole integration module. Short-circuits on the first match.
   */
  private async isAutoApproved(
    def: ActionDefinition,
    params: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    const candidates: Array<{ actionType: string; targetKey: string }> = [];
    const destination = this.resolveAutoApprovalTarget(def.type, params);
    if (destination) {
      candidates.push({ actionType: def.type, targetKey: destination });
    }
    candidates.push({ actionType: def.type, targetKey: AUTO_APPROVAL_ANY_TARGET });
    if (def.chatGroup) {
      candidates.push({
        actionType: AUTO_APPROVAL_MODULE_PREFIX + def.chatGroup,
        targetKey: AUTO_APPROVAL_ANY_TARGET,
      });
    }
    for (const c of candidates) {
      if (await this.hasAutoApprovalRule(c.actionType, c.targetKey)) return true;
    }
    return false;
  }

  /**
   * The param value that identifies an auto-approvable action's destination
   * (e.g. the Slack channel id), or null if this action type can't be
   * auto-approved or the target param is missing/empty. Used both to look up an
   * existing bypass rule and to record a new one from the chat agent.
   */
  resolveAutoApprovalTarget(
    actionType: string,
    params: Record<string, unknown> | undefined,
  ): string | null {
    const paramName = AUTO_APPROVAL_TARGET_PARAM[actionType];
    if (!paramName) return null;
    const raw = params?.[paramName];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  /** True when a persistent "don't ask again" rule exists for this exact
   *  (actionType, target). Drives the approval-gate bypass in runChatAction. */
  private async hasAutoApprovalRule(actionType: string, targetKey: string): Promise<boolean> {
    const res = await this.backendRequest<{ total: number }>(
      'GET',
      `/engine/auto-approvals?action_type=${encodeURIComponent(actionType)}&target_key=${encodeURIComponent(targetKey)}`,
      null,
    );
    return (res?.total ?? 0) > 0;
  }

  /** Record a persistent "don't ask again" rule. Idempotent on the backend. */
  async addAutoApprovalRule(
    actionType: string,
    targetKey: string,
    targetLabel?: string,
  ): Promise<AutoApprovalRule | null> {
    return this.backendRequest<AutoApprovalRule>('POST', '/engine/auto-approvals', {
      action_type: actionType,
      target_key: targetKey,
      target_label: targetLabel ?? null,
    });
  }

  /** All auto-approval rules, newest first (for the chat listing / revoke UI). */
  async listAutoApprovalRules(): Promise<AutoApprovalRule[]> {
    const res = await this.backendRequest<{ rules: AutoApprovalRule[] }>(
      'GET',
      '/engine/auto-approvals',
      null,
    );
    return res?.rules ?? [];
  }

  /** Revoke every rule matching an exact (actionType, target). Returns count. */
  async removeAutoApprovalRulesByTarget(actionType: string, targetKey: string): Promise<number> {
    const res = await this.backendRequest<{ deleted: number }>(
      'DELETE',
      `/engine/auto-approvals?action_type=${encodeURIComponent(actionType)}&target_key=${encodeURIComponent(targetKey)}`,
      null,
    );
    return res?.deleted ?? 0;
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
