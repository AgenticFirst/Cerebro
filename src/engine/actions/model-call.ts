/**
 * ask_ai action — single Claude Code one-shot inference.
 *
 * Sends the user's prompt (optionally prefixed with a system/role prompt)
 * to the configured subagent via the Claude Code CLI. Stateless: no
 * streaming, no multi-turn conversation.
 *
 * `prompt` and `system_prompt` are rendered with Mustache against
 * `wiredInputs`, so `{{upstream_step_field}}` placeholders resolve to
 * values piped in from edges on the canvas.
 *
 * Legacy action type `model_call` still maps here — registered twice so
 * older DAGs in `dag_json` keep executing.
 */

import Mustache from 'mustache';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface AskAiParams {
  prompt: string;
  system_prompt?: string;
  /** Subagent to invoke. Defaults to "cerebro". */
  agent?: string;
  /** Max conversation turns. Defaults to Claude Code's own default. */
  max_turns?: number;
}

function renderTemplate(source: string, vars: Record<string, unknown>): string {
  if (!source) return '';
  // Disable HTML escaping — prompts are sent to an LLM, not rendered in a browser.
  return Mustache.render(source, vars, undefined, { escape: (v) => String(v) });
}

export const askAiAction: ActionDefinition = {
  type: 'ask_ai',
  name: 'Ask AI',
  description: 'Sends a prompt to a Claude Code subagent and returns the response.',

  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Message sent to the AI. Use {{variable}} to insert values from upstream steps.',
      },
      system_prompt: {
        type: 'string',
        description: 'Optional role or style instructions prepended to the prompt.',
      },
      agent: {
        type: 'string',
        description: 'Subagent name to run this step (defaults to "cerebro").',
      },
      max_turns: {
        type: 'number',
        description: 'Maximum turns before Claude Code stops (optional).',
      },
    },
    required: ['prompt'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      response: { type: 'string', description: 'The AI response text.' },
    },
    required: ['response'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as AskAiParams;
    const { context, wiredInputs } = input;

    const vars = wiredInputs ?? {};
    const prompt = renderTemplate(params.prompt ?? '', vars);
    const systemPrompt = renderTemplate(params.system_prompt ?? '', vars);

    if (!prompt.trim()) {
      throw new Error('Ask AI: prompt is empty. Enter an instruction or wire one in from an upstream step.');
    }

    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${prompt}`
      : prompt;

    const response = await singleShotClaudeCode({
      agent: params.agent?.trim() || 'cerebro',
      prompt: fullPrompt,
      signal: context.signal,
      maxTurns: params.max_turns,
    });

    context.log(response);

    const summary = response.length > 80
      ? response.slice(0, 77) + '...'
      : response;

    return {
      data: { response },
      summary: `AI responded: ${summary}`,
    };
  },
};

/** Legacy alias. Older DAGs in `dag_json` still reference `model_call`. */
export const modelCallAction: ActionDefinition = {
  ...askAiAction,
  type: 'model_call',
  name: 'Ask AI (legacy)',
};
