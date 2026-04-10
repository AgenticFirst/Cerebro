/**
 * summarize action — AI-powered text condensation via Claude Code.
 *
 * Builds a summarization prompt and sends it to the Cerebro main subagent
 * as a single one-shot call.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';
import { extractByPath } from '../utils';

interface SummarizeParams {
  input_field: string;
  max_length: 'short' | 'medium' | 'long';
  focus?: string;
  agent?: string;
}

const LENGTH_INSTRUCTIONS: Record<string, string> = {
  short: 'Provide a brief summary in 1-2 sentences.',
  medium: 'Provide a summary in one concise paragraph.',
  long: 'Provide a detailed summary covering all key points.',
};

export const summarizeAction: ActionDefinition = {
  type: 'summarize',
  name: 'Summarize',
  description: 'Condenses text to a specified length using AI.',

  inputSchema: {
    type: 'object',
    properties: {
      input_field: { type: 'string' },
      max_length: { type: 'string', enum: ['short', 'medium', 'long'] },
      focus: { type: 'string' },
      agent: { type: 'string' },
    },
    required: ['input_field'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      original_length: { type: 'number' },
    },
    required: ['summary', 'original_length'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as SummarizeParams;
    const { context } = input;

    const text = extractByPath(input.wiredInputs, params.input_field);
    if (!text || typeof text !== 'string') {
      throw new Error(`Input field "${params.input_field}" is empty or not a string`);
    }

    const lengthInstruction = LENGTH_INSTRUCTIONS[params.max_length] ?? LENGTH_INSTRUCTIONS.medium;
    const focusInstruction = params.focus ? `\nFocus on: ${params.focus}` : '';

    const fullPrompt = `Summarize the following text. ${lengthInstruction}${focusInstruction}

Respond with ONLY the summary text, no preamble.

---

Text:

${text}`;

    const summary = await singleShotClaudeCode({
      agent: params.agent ?? 'cerebro',
      prompt: fullPrompt,
      signal: context.signal,
      maxTurns: 3,
    });

    context.log(summary);

    return {
      data: {
        summary: summary.trim(),
        original_length: text.length,
      },
      summary: `Summarized ${text.length} chars to ${summary.trim().length} chars`,
    };
  },
};
