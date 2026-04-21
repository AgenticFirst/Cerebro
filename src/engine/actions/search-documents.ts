/**
 * search_documents action — runs a RAG-style query against a Files bucket.
 *
 * Resolves the bucket's file paths via `GET /files/buckets/{id}/contents`,
 * then asks Claude Code (with Read/Glob/Grep tools) to answer the query
 * using those documents. No vector DB — Claude Code reads the files
 * itself, which keeps this zero-setup and consistent with the rest of
 * the Knowledge category.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

interface SearchDocumentsParams {
  query: string;
  bucket_id?: string;
  max_results?: number;
  model?: string;
}

interface BucketContent {
  id: string;
  name: string;
  ext: string;
  mime: string | null;
  size_bytes: number;
  abs_path: string;
}

interface DocumentHit {
  path: string;
  snippet: string;
  score: number;
}

function extractJsonArray(text: string): DocumentHit[] | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((h): DocumentHit | null => {
        if (typeof h !== 'object' || h === null) return null;
        const obj = h as Record<string, unknown>;
        const path = typeof obj.path === 'string' ? obj.path : '';
        const snippet = typeof obj.snippet === 'string' ? obj.snippet : '';
        if (!path && !snippet) return null;
        return {
          path,
          snippet,
          score: typeof obj.score === 'number' ? obj.score : 0,
        };
      })
      .filter((h): h is DocumentHit => h !== null);
  } catch {
    return null;
  }
}

export const searchDocumentsAction: ActionDefinition = {
  type: 'search_documents',
  name: 'Search Documents',
  description: 'Ask Claude Code to answer a query against files in a Files bucket.',

  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      bucket_id: { type: 'string' },
      max_results: { type: 'number' },
      model: { type: 'string' },
    },
    required: ['query', 'bucket_id'],
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
    const params = input.params as unknown as SearchDocumentsParams;
    const { context } = input;

    if (!params.query || !params.query.trim()) {
      throw new Error('Search documents requires a query');
    }
    if (!params.bucket_id) {
      throw new Error('Search documents requires a bucket — pick one in the step config');
    }

    const maxResults = params.max_results ?? 5;

    const contents = await backendFetch<BucketContent[]>(
      context.backendPort,
      'GET',
      `/files/buckets/${encodeURIComponent(params.bucket_id)}/contents?limit=50`,
      null,
      context.signal,
    );

    if (!Array.isArray(contents) || contents.length === 0) {
      context.log(`Bucket ${params.bucket_id} has no files — returning empty result set`);
      return {
        data: { results: [], count: 0 },
        summary: 'Bucket is empty',
      };
    }

    const fileList = contents
      .map((f) => `- ${f.abs_path}   (${f.name}${f.ext ? `, .${f.ext}` : ''})`)
      .join('\n');

    const prompt = [
      `Answer this query using the files listed below. Read each file that looks promising and return the top ${maxResults} relevant passages.`,
      '',
      `QUERY: ${params.query.trim()}`,
      '',
      'FILES:',
      fileList,
      '',
      'Respond ONLY with a JSON array (no prose, no code fences) in this exact shape:',
      '[{"path": "<absolute file path>", "snippet": "<excerpt or summary answering the query>", "score": <0-1 relevance>}]',
      'If nothing in these files answers the query, return [].',
    ].join('\n');

    const raw = await singleShotClaudeCode({
      agent: 'cerebro',
      prompt,
      signal: context.signal,
      maxTurns: 12,
      model: params.model?.trim() || undefined,
      allowedTools: 'Read,Glob,Grep',
    });

    const parsed = extractJsonArray(raw);
    const results = parsed ?? [];
    const capped = results.slice(0, maxResults);
    context.log(`Search documents (${contents.length} files) → ${capped.length} hit(s)`);

    return {
      data: {
        results: capped,
        count: capped.length,
      },
      summary: `Found ${capped.length} passage${capped.length === 1 ? '' : 's'} in bucket`,
    };
  },
};
