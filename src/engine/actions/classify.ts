/**
 * classify action — AI-powered categorization via Claude Code.
 *
 * Builds a classification prompt and sends it to the Cerebro main subagent
 * as a single one-shot call.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface ClassifyParams {
  prompt: string;
  categories: Array<{ label: string; description: string }>;
  agent?: string;
  model?: string;
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
      agent: { type: 'string' },
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

    const categoryList = params.categories
      .map((c, i) => `${i + 1}. "${c.label}"${c.description ? ` — ${c.description}` : ''}`)
      .join('\n');

    const fullPrompt = `You are a classifier. Given the input, classify it into exactly one of these categories:

${categoryList}

Respond with ONLY a valid JSON object (no markdown, no code fences):
{"category": "<exact category label>", "confidence": "high|medium|low", "reasoning": "<brief explanation>"}

---

Input:

${params.prompt}`;

    const response = await singleShotClaudeCode({
      agent: params.agent ?? 'cerebro',
      prompt: fullPrompt,
      signal: context.signal,
      maxTurns: 3,
      model: params.model?.trim() || undefined,
    });

    let result: { category: string; confidence?: string; reasoning?: string };
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch?.[0] ?? response);
    } catch {
      const matched = params.categories.find((c) =>
        response.toLowerCase().includes(c.label.toLowerCase()),
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
