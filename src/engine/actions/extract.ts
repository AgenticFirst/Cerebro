/**
 * extract action — AI-powered structured data extraction via Claude Code.
 *
 * Builds a JSON-extraction prompt and sends it to the Cerebro main subagent
 * as a single one-shot call.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';
import { renderTemplate } from './utils/template';

interface ExtractParams {
  prompt: string;
  schema: Array<{ name: string; type: string; description: string }>;
  agent?: string;
  model?: string;
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
      agent: { type: 'string' },
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

    const fieldList = params.schema
      .map((f) => `- "${f.name}" (${f.type}): ${f.description}`)
      .join('\n');

    // Render Mustache placeholders in the user-supplied prompt against wired
    // inputs — same fix as the classify action. Without this the LLM gets
    // literal "{{...}}" placeholders and returns null for every field.
    const renderedPrompt = renderTemplate(params.prompt ?? '', input.wiredInputs ?? {});

    const fullPrompt = `Extract the following fields from the input text. Return ONLY a valid JSON object (no markdown, no code fences) with these fields:

${fieldList}

If a field cannot be extracted, use null for its value.

---

Input text:

${renderedPrompt}`;

    const response = await singleShotClaudeCode({
      agent: params.agent ?? 'cerebro',
      prompt: fullPrompt,
      signal: context.signal,
      maxTurns: 3,
      model: params.model?.trim() || undefined,
    });

    let extracted: Record<string, unknown>;
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(jsonMatch?.[0] ?? response);
    } catch {
      throw new Error('Failed to parse extraction result as JSON');
    }

    const fieldCount = Object.keys(extracted).filter((k) => extracted[k] != null).length;

    return {
      data: extracted,
      summary: `Extracted ${fieldCount}/${params.schema.length} fields`,
    };
  },
};
