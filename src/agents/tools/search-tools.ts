/**
 * Web search tools for the agent system.
 */

import http from 'node:http';
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { ToolContext } from '../types';

function backendRequest<T>(port: number, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(data as T);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: 'text', text }], details: undefined as any };
}

interface SearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface SearchResponseData {
  query: string;
  results: SearchResultItem[];
  answer: string | null;
}

export function createWebSearch(ctx: ToolContext): AgentTool {
  return {
    name: 'web_search',
    description:
      'Search the web for current information. Use when the user asks about recent events, needs real-time data, or asks questions beyond your training data.',
    label: 'Web Search',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      max_results: Type.Optional(
        Type.Number({ description: 'Max results (default 5)', default: 5 }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      let res: SearchResponseData;
      try {
        res = await backendRequest<SearchResponseData>(ctx.backendPort, 'POST', '/search', {
          query: params.query,
          max_results: params.max_results ?? 5,
        });
      } catch (err) {
        return textResult(`Web search failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Handle error responses from the backend (e.g. no API key)
      if (!res.results) {
        const detail = (res as any)?.detail ?? '';
        if (detail.toLowerCase().includes('no tavily api key') || detail.toLowerCase().includes('api key')) {
          return textResult(
            'Web search is not available — no Tavily API key is configured. ' +
            'Tell the user they can add a free Tavily API key in Integrations → Connected Apps to enable web search.',
          );
        }
        return textResult(`Web search error: ${detail || 'No search results returned.'}`);
      }

      if (res.results.length === 0) {
        return textResult('No search results found.');
      }

      const lines = res.results.map(
        (r, i) => `${i + 1}. **${r.title}**\n   ${r.content}\n   Source: ${r.url}`,
      );
      let text = `Found ${res.results.length} results for "${params.query}":\n\n${lines.join('\n\n')}`;
      if (res.answer) text = `Summary: ${res.answer}\n\n${text}`;
      return textResult(text);
    },
  };
}
