/**
 * model_call action — runs a single Claude Code one-shot inference.
 *
 * Stateless. The system prompt (if any) is prepended to the user prompt
 * and the whole thing is sent to the Cerebro main subagent. Useful for
 * routine LLM steps that don't need streaming or multi-turn behavior.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface ModelCallParams {
  prompt: string;
  systemPrompt?: string;
  /** Optional override of which subagent to invoke. Defaults to "cerebro". */
  agent?: string;
  /** Max conversation turns. Defaults to 5. */
  maxTurns?: number;
}

export const modelCallAction: ActionDefinition = {
  type: 'model_call',
  name: 'Model Call',
  description: 'Runs a single one-shot LLM call via Claude Code.',

  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The user message / instruction' },
      systemPrompt: { type: 'string', description: 'Optional system prompt prepended to the user message' },
      agent: { type: 'string', description: 'Optional subagent name (defaults to "cerebro")' },
      maxTurns: { type: 'number', description: 'Max turns (default 5)' },
    },
    required: ['prompt'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      response: { type: 'string' },
    },
    required: ['response'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ModelCallParams;
    const { context } = input;

    const fullPrompt = params.systemPrompt
      ? `${params.systemPrompt}\n\n---\n\n${params.prompt}`
      : params.prompt;

    const response = await singleShotClaudeCode({
      agent: params.agent ?? 'cerebro',
      prompt: fullPrompt,
      signal: context.signal,
      maxTurns: params.maxTurns,
    });

    context.log(response);

    const summary = response.length > 80
      ? response.slice(0, 77) + '...'
      : response;

    return {
      data: { response },
      summary: `Model responded: ${summary}`,
    };
  },
};
