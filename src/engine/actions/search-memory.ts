/**
 * search_memory action — asks Claude Code to search a subagent's memory
 * directory (`<userData>/agent-memory/<agent>/`) for notes matching the query.
 *
 * "Global" memory is the `cerebro` subagent's directory. Picking an expert
 * searches that expert's directory. Claude Code reads the markdown files
 * natively via the Read/Glob/Grep tools when invoked with the target agent.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface SearchMemoryParams {
  query: string;
  agent?: string;
  max_results?: number;
  model?: string;
}

interface MemoryHit {
  content: string;
  source: string | null;
  score: number;
}

function extractJsonArray(text: string): MemoryHit[] | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((h): MemoryHit | null => {
        if (typeof h !== 'object' || h === null) return null;
        const obj = h as Record<string, unknown>;
        const content = typeof obj.content === 'string' ? obj.content : null;
        if (!content) return null;
        return {
          content,
          source: typeof obj.source === 'string' ? obj.source : null,
          score: typeof obj.score === 'number' ? obj.score : 0,
        };
      })
      .filter((h): h is MemoryHit => h !== null);
  } catch {
    return null;
  }
}

export const searchMemoryAction: ActionDefinition = {
  type: 'search_memory',
  name: 'Search Memory',
  description: "Ask Claude Code to search an expert's memory notes.",

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      agent: { type: 'string' },
      max_results: { type: 'number' },
      model: { type: 'string' },
    },
    required: ['query'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      results: { type: 'array' },
      count: { type: 'number' },
    },
    required: ['results', 'count'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as SearchMemoryParams;
    const { context } = input;

    if (!params.query || !params.query.trim()) {
      throw new Error('Search memory requires a query');
    }

    const agent = (params.agent && params.agent.trim()) || 'cerebro';
    const maxResults = params.max_results ?? 5;
    const scopeLabel = agent === 'cerebro' ? 'your global notes' : `your own notes`;

    const prompt = [
      `Search ${scopeLabel} for entries relevant to this query and return the top ${maxResults} matches.`,
      '',
      `QUERY: ${params.query.trim()}`,
      '',
      'Use your Read/Glob/Grep tools on your agent-memory directory to find matches.',
      'Respond ONLY with a JSON array (no prose, no code fences) of objects with this exact shape:',
      '[{"content": "<matching snippet or distilled fact>", "source": "<relative markdown path or null>", "score": <0-1 relevance>}]',
      'If nothing relevant is found, return [].',
    ].join('\n');

    const raw = await singleShotClaudeCode({
      agent,
      prompt,
      signal: context.signal,
      maxTurns: 8,
      model: params.model?.trim() || undefined,
      allowedTools: 'Read,Glob,Grep',
    });

    const parsed = extractJsonArray(raw);
    const results =
      parsed ??
      (raw.trim()
        ? [{ content: raw.trim(), source: null, score: 0 }]
        : []);

    const capped = results.slice(0, maxResults);
    context.log(`Search memory (${agent}) → ${capped.length} result(s)`);

    return {
      data: {
        results: capped,
        count: capped.length,
      },
      summary: `Found ${capped.length} memory match${capped.length === 1 ? '' : 'es'} in ${agent}`,
    };
  },
};
