/**
 * search_web action — runs a web search via Claude Code's built-in
 * WebSearch/WebFetch tools. Replaces the previous Tavily-backed endpoint so
 * everything in the routine engine goes through `singleShotClaudeCode`.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface SearchWebParams {
  query: string;
  max_results?: number;
  include_ai_answer?: boolean;
  model?: string;
}

interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

interface ParsedWebResponse {
  results: WebResult[];
  ai_answer: string | null;
}

function parseResponse(text: string): ParsedWebResponse {
  const trimmed = text.trim();
  // Claude sometimes wraps JSON in ```json fences — peel them off first.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  // Find the first '{' and matching final '}' to tolerate leading/trailing prose.
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return { results: [], ai_answer: unfenced || null };
  }
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
    const results: WebResult[] = rawResults
      .map((r: unknown): WebResult | null => {
        if (typeof r !== 'object' || r === null) return null;
        const obj = r as Record<string, unknown>;
        const title = typeof obj.title === 'string' ? obj.title : '';
        const url = typeof obj.url === 'string' ? obj.url : '';
        const snippet =
          typeof obj.snippet === 'string'
            ? obj.snippet
            : typeof obj.content === 'string'
              ? obj.content
              : '';
        if (!url) return null;
        return { title, url, snippet };
      })
      .filter((r: WebResult | null): r is WebResult => r !== null);
    const aiAnswer =
      typeof parsed?.ai_answer === 'string'
        ? parsed.ai_answer
        : typeof parsed?.answer === 'string'
          ? parsed.answer
          : null;
    return { results, ai_answer: aiAnswer };
  } catch {
    return { results: [], ai_answer: unfenced || null };
  }
}

export const searchWebAction: ActionDefinition = {
  type: 'search_web',
  name: 'Search Web',
  description: "Searches the web using Claude Code's WebSearch tool.",

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
      include_ai_answer: { type: 'boolean' },
      model: { type: 'string' },
    },
    required: ['query'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      results: { type: 'array' },
      ai_answer: { type: 'string' },
    },
    required: ['results'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as SearchWebParams;
    const { context } = input;

    if (!params.query || !params.query.trim()) {
      throw new Error('Web search requires a query');
    }

    const maxResults = params.max_results ?? 5;
    const includeAnswer = params.include_ai_answer ?? false;

    const promptLines = [
      `Search the web for: ${params.query.trim()}`,
      `Return the top ${maxResults} results. Use your WebSearch tool; follow up with WebFetch only if a snippet is missing.`,
      '',
      'Respond ONLY with a JSON object (no prose, no code fences) in this exact shape:',
      includeAnswer
        ? '{"results": [{"title": "...", "url": "...", "snippet": "..."}], "ai_answer": "<1-3 sentence synthesis of the results>"}'
        : '{"results": [{"title": "...", "url": "...", "snippet": "..."}]}',
    ];

    const raw = await singleShotClaudeCode({
      agent: 'cerebro',
      prompt: promptLines.join('\n'),
      signal: context.signal,
      maxTurns: 8,
      model: params.model?.trim() || undefined,
      allowedTools: 'WebSearch,WebFetch',
    });

    const parsed = parseResponse(raw);
    const capped = parsed.results.slice(0, maxResults);
    context.log(`Search web → ${capped.length} result(s)`);

    return {
      data: {
        results: capped,
        ai_answer: includeAnswer ? parsed.ai_answer ?? null : null,
      },
      summary: `Found ${capped.length} web result${capped.length === 1 ? '' : 's'}`,
    };
  },
};
