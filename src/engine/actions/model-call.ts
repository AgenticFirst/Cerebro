/**
 * model_call action — makes a single LLM call via backend SSE endpoints.
 *
 * One-shot, stateless. No multi-turn agent loop, no tool access.
 * Useful for summarization, formatting, analysis, and other
 * deterministic LLM tasks within a routine.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { streamModelCall, resolveModelForAction, buildLLMRequestBody } from './utils/llm-call';

// ── Params interface ────────────────────────────────────────────

interface ModelCallParams {
  prompt: string;
  systemPrompt?: string;
  model?: { source: 'local' | 'cloud'; provider?: string; modelId: string };
  temperature?: number;
  maxTokens?: number;
}

// ── Action definition ───────────────────────────────────────────

export const modelCallAction: ActionDefinition = {
  type: 'model_call',
  name: 'Model Call',
  description: 'Makes a single LLM call via the backend streaming endpoints.',

  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The user message / instruction' },
      systemPrompt: { type: 'string', description: 'Optional system prompt' },
      temperature: { type: 'number', description: 'Sampling temperature (default 0.7)' },
      maxTokens: { type: 'number', description: 'Max tokens (default 4096)' },
    },
    required: ['prompt'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      response: { type: 'string' },
      tokenCount: { type: 'number' },
    },
    required: ['response'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ModelCallParams;
    const { context } = input;

    // Resolve model — override from params or global
    const model = await resolveModelForAction(params.model, context);

    // Build messages
    const messages: Array<Record<string, unknown>> = [];
    if (params.systemPrompt) {
      messages.push({ role: 'system', content: params.systemPrompt });
    }
    messages.push({ role: 'user', content: params.prompt });

    // Build request
    const { path, body } = buildLLMRequestBody(messages, model, {
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    // Stream from backend, collect response
    const response = await streamModelCall(
      context.backendPort,
      path,
      body,
      context.signal,
      (chunk: string) => context.log(chunk),
    );

    const summary = response.length > 80
      ? response.slice(0, 77) + '...'
      : response;

    return {
      data: { response },
      summary: `Model responded: ${summary}`,
    };
  },
};
