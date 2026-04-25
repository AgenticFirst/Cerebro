/**
 * classify action — AI-powered categorization via Claude Code.
 *
 * Builds a classification prompt and sends it to the Cerebro main subagent
 * as a single one-shot call.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';
import { renderTemplate } from './utils/template';

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

    // Render Mustache placeholders in the user-supplied prompt against the
    // step's wired inputs. Without this the prompt would carry literal
    // "{{conversation_history}}" / "{{latest_message}}" placeholders all the
    // way to the LLM, which then has no real input to classify.
    const renderedPrompt = renderTemplate(params.prompt ?? '', input.wiredInputs ?? {});

    const fullPrompt = `You are a classifier. Given the input, classify it into exactly one of these categories:

${categoryList}

Respond with ONLY a valid JSON object (no markdown, no code fences):
{"category": "<exact category label>", "confidence": "high|medium|low", "reasoning": "<brief explanation>"}

---

Input:

${renderedPrompt}`;

    const response = await singleShotClaudeCode({
      agent: params.agent ?? 'cerebro',
      prompt: fullPrompt,
      signal: context.signal,
      maxTurns: 3,
      model: params.model?.trim() || undefined,
    });


    let result: { category: string; confidence?: string; reasoning?: string } | null = null;

    // Try every {...} block in the response, preferring the LAST valid parse.
    // The greedy single-match used to be `response.match(/\{[\s\S]*\}/)` which
    // captures from the first `{` to the last `}` — that breaks when the
    // subagent emits multiple JSON-ish objects (e.g. memory writes, tool
    // calls, then the final answer). The actual classification is almost
    // always in the last JSON block.
    const candidates = response.match(/\{[^{}]*"category"[^{}]*\}/g) ?? [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(candidates[i]);
        if (typeof parsed?.category === 'string') {
          result = parsed;
          break;
        }
      } catch { /* try the next candidate */ }
    }

    if (!result) {
      // Fallback: word-boundary match. Prefer longer / more-specific labels
      // first so e.g. "ready_for_ticket" beats "greeting" when both appear in
      // the subagent's reasoning text.
      const sorted = [...params.categories].sort((a, b) => b.label.length - a.label.length);
      const matched = sorted.find((c) =>
        new RegExp(`\\b${c.label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(response),
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
