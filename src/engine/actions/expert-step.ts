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

      // Build the prompt with optional additional context
      const fullPrompt = params.additionalContext
        ? `${params.additionalContext}\n\n${params.prompt}`
        : params.prompt;

      // Start the agent run
      context.log(`Starting expert step${params.expertId ? ` (expert: ${params.expertId})` : ''}...`);

      const agentRunId = await agentRuntime.startRun(webContents, {
        conversationId: `engine-run:${context.runId}`,
        content: fullPrompt,
        expertId: params.expertId ?? null,
        model: params.model?.trim() || undefined,
      });

      // Collect results by listening to the agent event channel
      const result = await collectAgentResults(
        webContents,
        agentRunId,
        context.signal,
        (event: RendererAgentEvent) => {
          // Forward agent events as engine execution events
          const engineEvent = translateAgentEvent(event, context.stepId);
          if (engineEvent) {
            context.emitEvent(engineEvent);
          }
        },
      );

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
  webContents: WebContents,
  agentRunId: string,
  signal: AbortSignal,
  onEvent: (event: RendererAgentEvent) => void,
): Promise<AgentResult> {
  return new Promise((resolve, reject) => {
    const channel = `agent:event:${agentRunId}`;
    const toolsUsed = new Set<string>();
    let turns = 0;

    const handler = (_ipcEvent: unknown, event: RendererAgentEvent) => {
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

    const cleanup = () => {
      webContents.ipc.removeListener(channel, handler);
    };

    // Listen for agent events sent to the renderer
    webContents.ipc.on(channel, handler);

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
