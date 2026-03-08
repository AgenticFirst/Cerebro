/**
 * classify action — AI-powered categorization.
 *
 * Uses an LLM to classify input text into one of the defined categories.
 * Returns the selected category, confidence level, and reasoning.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { streamModelCall, resolveModelForAction, buildLLMRequestBody } from './utils/llm-call';

interface ClassifyParams {
  prompt: string;
  categories: Array<{ label: string; description: string }>;
  model?: { source: 'local' | 'cloud'; provider?: string; modelId: string };
}

export const classifyAction: ActionDefinition = {
  type: 'classify',
  name: 'Classify',
  description: 'Categorizes input using AI into one of the defined categories.',

  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      categories: { type: 'array' },
      model: { type: 'object' },
    },
    required: ['prompt', 'categories'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string' },
      confidence: { type: 'string' },
      reasoning: { type: 'string' },
    },
    required: ['category'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ClassifyParams;
    const { context } = input;

    if (!params.categories || params.categories.length === 0) {
      throw new Error('Classify requires at least one category');
    }

    const model = await resolveModelForAction(params.model, context);

    const categoryList = params.categories
      .map((c, i) => `${i + 1}. "${c.label}"${c.description ? ` — ${c.description}` : ''}`)
      .join('\n');

    const systemPrompt = `You are a classifier. Given the input, classify it into exactly one of these categories:

${categoryList}

Respond with ONLY a valid JSON object (no markdown, no code fences):
{"category": "<exact category label>", "confidence": "high|medium|low", "reasoning": "<brief explanation>"}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: params.prompt },
    ];

    const { path, body } = buildLLMRequestBody(messages, model, { temperature: 0.3, maxTokens: 512 });

    const response = await streamModelCall(
      context.backendPort,
      path,
      body,
      context.signal,
      () => {},
    );

    // Parse JSON response
    let result: { category: string; confidence?: string; reasoning?: string };
    try {
      // Try to extract JSON from the response (may have markdown wrapping)
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      result = JSON.parse(jsonMatch?.[0] ?? response);
    } catch {
      // Fallback: find the best matching category from the raw text
      const matched = params.categories.find(c =>
        response.toLowerCase().includes(c.label.toLowerCase())
      );
      if (!matched) {
        context.log(`Warning: Could not parse classification result; defaulting to "${params.categories[0].label}"`);
      }
      result = {
        category: matched?.label ?? params.categories[0].label,
        confidence: 'low',
        reasoning: matched ? 'Matched from raw text' : 'Could not parse response; used default',
      };
    }

    return {
      data: {
        category: result.category,
        confidence: result.confidence ?? 'medium',
        reasoning: result.reasoning ?? '',
      },
      summary: `Classified as: ${result.category} (${result.confidence ?? 'medium'})`,
    };
  },
};
