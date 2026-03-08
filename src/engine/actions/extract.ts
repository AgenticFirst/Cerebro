/**
 * extract action — AI-powered structured data extraction.
 *
 * Uses an LLM to extract structured fields from unstructured text,
 * returning them as a typed JSON object.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { streamModelCall, resolveModelForAction, buildLLMRequestBody } from './utils/llm-call';

interface ExtractParams {
  prompt: string;
  schema: Array<{ name: string; type: string; description: string }>;
  model?: { source: 'local' | 'cloud'; provider?: string; modelId: string };
}

export const extractAction: ActionDefinition = {
  type: 'extract',
  name: 'Extract',
  description: 'Extracts structured data from unstructured text using AI.',

  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      schema: { type: 'array' },
      model: { type: 'object' },
    },
    required: ['prompt', 'schema'],
  },

  outputSchema: {
    type: 'object',
    additionalProperties: true,
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ExtractParams;
    const { context } = input;

    if (!params.schema || params.schema.length === 0) {
      throw new Error('Extract requires at least one field in the schema');
    }

    const model = await resolveModelForAction(params.model, context);

    const fieldList = params.schema
      .map((f) => `- "${f.name}" (${f.type}): ${f.description}`)
      .join('\n');

    const systemPrompt = `Extract the following fields from the input text. Return ONLY a valid JSON object (no markdown, no code fences) with these fields:

${fieldList}

If a field cannot be extracted, use null for its value.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: params.prompt },
    ];

    const { path, body } = buildLLMRequestBody(messages, model, { temperature: 0.2, maxTokens: 1024 });

    const response = await streamModelCall(
      context.backendPort,
      path,
      body,
      context.signal,
      () => {},
    );

    // Parse JSON response
    let extracted: Record<string, unknown>;
    try {
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      extracted = JSON.parse(jsonMatch?.[0] ?? response);
    } catch {
      throw new Error('Failed to parse extraction result as JSON');
    }

    // Build summary from extracted fields
    const fieldCount = Object.keys(extracted).filter(k => extracted[k] != null).length;

    return {
      data: extracted,
      summary: `Extracted ${fieldCount}/${params.schema.length} fields`,
    };
  },
};
