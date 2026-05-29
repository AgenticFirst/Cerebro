/**
 * expert_step action — delegates to AgentRuntime for full multi-turn agent execution.
 *
 * This is how routines invoke Expert intelligence. The agent can reason,
 * call tools (search, memory, etc.), and produce a thoughtful response.
 * Agent events are forwarded as engine-level execution events.
 */

import type { WebContents } from 'electron';
import type { AgentRuntime } from '../../agents/runtime';
import type { RendererAgentEvent } from '../../agents/types';
import type { ActionDefinition, ActionInput, ActionOutput, ExecutionEvent } from './types';
import { buildRoutineContext } from './routine-context';

// ── Types ───────────────────────────────────────────────────────

interface ExpertStepParams {
  prompt: string;
  expertId?: string;
  additionalContext?: string;
  maxTurns?: number;
  toolAccess?: string[];
  model?: string;
}

// ── Extended ActionContext for expert_step ───────────────────────

export interface ExpertStepContext {
  agentRuntime: AgentRuntime;
  webContents: WebContents;
}

// ── Action factory ──────────────────────────────────────────────

/**
 * Creates the expert_step action definition, capturing the AgentRuntime
 * and WebContents references needed for agent delegation.
 *
 * These are passed as a closure capture rather than through ActionContext
 * because only expert_step needs them.
 */
export function createExpertStepAction(deps: ExpertStepContext): ActionDefinition {
  return {
    type: 'expert_step',
    name: 'Expert Step',
    description: 'Delegates to AgentRuntime for full multi-turn agent execution with tool access.',

    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Instruction for the expert' },
        expertId: { type: 'string', description: 'Which expert to use (null = global/Cerebro)' },
        additionalContext: { type: 'string', description: 'Extra context prepended to the prompt' },
        maxTurns: { type: 'number', description: 'Override max agent turns' },
        toolAccess: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override tool list',
        },
      },
      required: ['prompt'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        response: { type: 'string' },
        toolsUsed: { type: 'array', items: { type: 'string' } },
        turns: { type: 'number' },
        agentRunId: { type: 'string' },
      },
      required: ['response', 'agentRunId'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const params = input.params as unknown as ExpertStepParams;
      const { context } = input;
      const { agentRuntime, webContents } = deps;

      // Fast-fail on missing required inputs. Without this check, the agent
      // subprocess would launch and silently wait for input that never
      // arrives — burning the full step timeout (5 min) for a trivially
      // misconfigured step.
      if (!params.prompt?.trim()) {
        throw new Error(
          'Run Expert: prompt is empty. Open the routine editor and write what you want the expert to do.',
        );
      }

      // Empty-string expertId means "no expert selected" — fall back to the
      // global Cerebro agent. The `?? null` form would have left an empty
      // string here, which the runtime cannot resolve.
      const expertId = params.expertId?.trim() || null;

      // Routine-shape context. Tells the expert "you are step 1 of 2,
      // step 2 will create the HubSpot ticket using your output, the
      // integration is already wired" — so it produces a draft instead
      // of asking for an API token. Empty string for trivial single-step
      // routines, in which case prompt assembly is unchanged.
      const routinePreface = context.dag
        ? buildRoutineContext(context.dag, context.stepId)
        : '';

      // Final prompt: [workflow context] + [user-supplied additional context] + [user prompt].
      const fullPrompt = [routinePreface, params.additionalContext, params.prompt]
        .map((s) => (s ?? '').trim())
        .filter((s) => s.length > 0)
        .join('\n\n');

      // Start the agent run
      context.log(`Starting expert step${expertId ? ` (expert: ${expertId})` : ' (global Cerebro)'}...`);

      const agentRunId = await agentRuntime.startRun(webContents, {
        conversationId: `engine-run:${context.runId}`,
        content: fullPrompt,
        expertId,
        model: params.model?.trim() || undefined,
      });
      context.log('Subprocess spawning, waiting for first agent event...');

      // Heartbeat. Until the first agent event arrives, emit a step_log
      // every 10s so the Activity panel's live feed shows the wait is
      // ongoing. Cleared inside collectAgentResults on the first event.
      const heartbeatStartedAt = Date.now();
      let firstEventReceived = false;
      const heartbeat = setInterval(() => {
        if (firstEventReceived) return;
        const sec = Math.round((Date.now() - heartbeatStartedAt) / 1000);
        context.log(`Still waiting for agent response (${sec}s elapsed)...`);
      }, 10_000);

      // Collect results by listening to the agent event channel. We wrap
      // in try/finally so the heartbeat is cleared whether the run
      // resolves, errors, or is cancelled.
      let result: AgentResult;
      try {
        result = await collectAgentResults(
          agentRuntime,
          agentRunId,
          context.signal,
          (event: RendererAgentEvent) => {
            // First substantive event → cancel heartbeat (idle warnings
            // and stderr lines don't count — they ARE the wait signal).
            if (!firstEventReceived &&
                event.type !== 'agent_idle_warning' &&
                event.type !== 'subprocess_stderr' &&
                event.type !== 'run_start') {
              firstEventReceived = true;
            }
            // Forward agent events as engine execution events
            const engineEvent = translateAgentEvent(event, context.stepId);
            if (engineEvent) {
              context.emitEvent(engineEvent);
            }
            // Idle-warning + stderr → also surface as step_log so the user
            // sees a clear timeline in the Steps tab without having to
            // open the Logs tab.
            if (event.type === 'agent_idle_warning') {
              const sec = Math.round(event.elapsedMs / 1000);
              context.log(`No subprocess output in ${sec}s — Claude Code may not be authenticated. Try \`claude\` in a terminal.`);
            } else if (event.type === 'subprocess_stderr') {
              context.log(`[stderr] ${event.line}`);
            }
          },
        );
      } finally {
        clearInterval(heartbeat);
      }

      const summary = result.response.length > 80
        ? result.response.slice(0, 77) + '...'
        : result.response;

      return {
        data: {
          response: result.response,
          toolsUsed: result.toolsUsed,
          turns: result.turns,
          agentRunId,
        },
        summary: `Expert responded: ${summary}`,
      };
    },
  };
}

// ── Agent event collection ──────────────────────────────────────

interface AgentResult {
  response: string;
  toolsUsed: string[];
  turns: number;
}

function collectAgentResults(
  agentRuntime: AgentRuntime,
  agentRunId: string,
  signal: AbortSignal,
  onEvent: (event: RendererAgentEvent) => void,
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const toolsUsed = new Set<string>();
    let turns = 0;

    const handler = (event: RendererAgentEvent) => {
      onEvent(event);

      switch (event.type) {
        case 'turn_start':
          turns = event.turn;
          break;
        case 'tool_start':
          toolsUsed.add(event.toolName);
          break;
        case 'done':
          cleanup();
          resolve({
            response: event.messageContent,
            toolsUsed: Array.from(toolsUsed),
            turns,
          });
          break;
        case 'error':
          cleanup();
          reject(new Error(event.error));
          break;
      }
    };

    // Subscribe to the runtime's main-process bus. Previously this used
    // `webContents.ipc.on`, which only catches messages sent FROM the
    // renderer — the runner's events go renderer-bound via
    // `webContents.send`, so the listener here would never fire. The
    // result was that every run_expert step waited the full 5-minute
    // wall clock before the dag executor killed it. The runtime bus
    // delivers events directly in main, so we actually receive `done` /
    // `error` / `text_delta` and can resolve this promise normally.
    const unsubscribe = agentRuntime.onAgentEvent(agentRunId, handler);

    const cleanup = () => {
      unsubscribe();
    };

    // Handle abort
    signal.addEventListener('abort', () => {
      cleanup();
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

// ── Event translation ───────────────────────────────────────────

function translateAgentEvent(
  event: RendererAgentEvent,
  stepId: string,
): ExecutionEvent | null {
  switch (event.type) {
    case 'text_delta':
      return { type: 'action_text_delta', stepId, delta: event.delta };
    case 'tool_start':
      return {
        type: 'action_tool_start',
        stepId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case 'tool_end':
      return {
        type: 'action_tool_end',
        stepId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
    default:
      return null;
  }
}
