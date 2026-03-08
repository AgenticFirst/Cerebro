/**
 * search_web action — performs web search via the Tavily API endpoint.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';

interface SearchWebParams {
  query: string;
  max_results?: number;
  include_ai_answer?: boolean;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
  answer?: string;
}

export const searchWebAction: ActionDefinition = {
  type: 'search_web',
  name: 'Search Web',
  description: 'Performs a web search via Tavily API.',

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
      include_ai_answer: { type: 'boolean' },
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

    if (!params.query) {
      throw new Error('Web search requires a query');
    }

    const response = await backendFetch<TavilyResponse>(
      context.backendPort,
      'POST',
      '/search',
      {
        query: params.query,
        max_results: params.max_results ?? 5,
        include_answer: params.include_ai_answer ?? false,
      },
      context.signal,
    );

    const results = (response.results ?? []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    }));

    return {
      data: {
        results,
        ai_answer: response.answer ?? null,
      },
      summary: `Found ${results.length} web results`,
    };
  },
};
