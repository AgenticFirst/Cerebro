/**
 * search_memory action — queries the memory system via TF-IDF similarity.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';

interface SearchMemoryParams {
  query: string;
  scope?: string;
  max_results?: number;
}

interface SearchResult {
  content: string;
  score: number;
  source: string | null;
}

export const searchMemoryAction: ActionDefinition = {
  type: 'search_memory',
  name: 'Search Memory',
  description: 'Searches learned facts and memories using TF-IDF similarity.',

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'string' },
      max_results: { type: 'number' },
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

    if (!params.query) {
      throw new Error('Search memory requires a query');
    }

    const response = await backendFetch<{ results: SearchResult[]; total: number }>(
      context.backendPort,
      'POST',
      '/memory/search',
      {
        query: params.query,
        scope: params.scope ?? 'personal',
        max_results: params.max_results ?? 5,
      },
      context.signal,
    );

    return {
      data: {
        results: response.results,
        count: response.results.length,
      },
      summary: `Found ${response.results.length} memory items`,
    };
  },
};
