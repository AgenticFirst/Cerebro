import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchDocumentsAction } from '../actions/search-documents';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../../claude-code/single-shot', () => ({
  singleShotClaudeCode: vi.fn(),
}));

vi.mock('../actions/utils/backend-fetch', () => ({
  backendFetch: vi.fn(),
}));

import { singleShotClaudeCode } from '../../claude-code/single-shot';
import { backendFetch } from '../actions/utils/backend-fetch';

const mockSingleShot = vi.mocked(singleShotClaudeCode);
const mockBackendFetch = vi.mocked(backendFetch);

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 55555,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  } as ActionContext;
}

const SAMPLE_CONTENTS = [
  {
    id: 'f1',
    name: 'intro.md',
    ext: 'md',
    mime: 'text/markdown',
    size_bytes: 120,
    abs_path: '/var/data/buckets/onboarding/intro.md',
  },
  {
    id: 'f2',
    name: 'policy.txt',
    ext: 'txt',
    mime: 'text/plain',
    size_bytes: 400,
    abs_path: '/var/data/buckets/onboarding/policy.txt',
  },
];

async function run(
  params: Record<string, unknown>,
  context: ActionContext = makeContext(),
) {
  return searchDocumentsAction.execute({
    params,
    wiredInputs: {},
    scratchpad: new RunScratchpad(),
    context,
  });
}

describe('searchDocumentsAction', () => {
  beforeEach(() => {
    mockSingleShot.mockReset();
    mockBackendFetch.mockReset();
  });

  it('SD-U1: parses well-formed JSON array into results + count', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify([
        {
          path: '/var/data/buckets/onboarding/intro.md',
          snippet: 'Welcome to onboarding.',
          score: 0.95,
        },
        {
          path: '/var/data/buckets/onboarding/policy.txt',
          snippet: 'Policy clause 3.1',
          score: 0.6,
        },
      ]),
    );
    const result = await run({ query: 'onboarding policy', bucket_id: 'bk-1' });
    const results = result.data.results as Array<{ path: string; snippet: string; score: number }>;
    expect(results).toHaveLength(2);
    expect(results[0].path).toBe('/var/data/buckets/onboarding/intro.md');
    expect(results[0].snippet).toBe('Welcome to onboarding.');
    expect(results[0].score).toBe(0.95);
    expect(result.data.count).toBe(2);
  });

  it('SD-U2: strips code fences around the JSON array', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce(
      '```json\n[{"path":"/x.md","snippet":"y","score":0.5}]\n```',
    );
    const result = await run({ query: 'q', bucket_id: 'bk-1' });
    const results = result.data.results as Array<{ path: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/x.md');
  });

  it('SD-U3: returns an empty result set when Claude returns []', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce('[]');
    const result = await run({ query: 'nope', bucket_id: 'bk-1' });
    expect(result.data.results).toEqual([]);
    expect(result.data.count).toBe(0);
  });

  it('SD-U4: returns empty results without calling Claude when the bucket is empty', async () => {
    mockBackendFetch.mockResolvedValueOnce([]);
    const result = await run({ query: 'q', bucket_id: 'bk-empty' });
    expect(result.data.results).toEqual([]);
    expect(result.data.count).toBe(0);
    expect(mockSingleShot).not.toHaveBeenCalled();
  });

  it('SD-U5: caps results to max_results', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    const rows = Array.from({ length: 20 }, (_, i) => ({
      path: `/f${i}.md`,
      snippet: `s${i}`,
      score: 1 - i * 0.01,
    }));
    mockSingleShot.mockResolvedValueOnce(JSON.stringify(rows));
    const result = await run({ query: 'q', bucket_id: 'bk-1', max_results: 3 });
    expect((result.data.results as unknown[]).length).toBe(3);
    expect(result.data.count).toBe(3);
  });

  it('SD-U6: fetches bucket contents from the correct endpoint with limit=50', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'q', bucket_id: 'bucket-with-slash/encoded' });
    expect(mockBackendFetch).toHaveBeenCalledWith(
      55555,
      'GET',
      '/files/buckets/bucket-with-slash%2Fencoded/contents?limit=50',
      null,
      expect.anything(),
    );
  });

  it('SD-U7: includes every bucket file path in the prompt so Claude can Read them', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'q', bucket_id: 'bk-1' });
    const call = mockSingleShot.mock.calls[0][0];
    expect(call.prompt).toContain('/var/data/buckets/onboarding/intro.md');
    expect(call.prompt).toContain('/var/data/buckets/onboarding/policy.txt');
    expect(call.prompt).toContain('q');
  });

  it('SD-U8: passes Read,Glob,Grep as allowedTools and targets cerebro agent', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'q', bucket_id: 'bk-1' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'cerebro',
        allowedTools: 'Read,Glob,Grep',
      }),
    );
  });

  it('SD-U9: forwards a model override when provided', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'q', bucket_id: 'bk-1', model: 'claude-sonnet-4-6' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('SD-U10: throws when query is missing and does not call backend or Claude', async () => {
    await expect(run({ query: '', bucket_id: 'bk-1' })).rejects.toThrow(/requires a query/);
    await expect(run({ query: '   ', bucket_id: 'bk-1' })).rejects.toThrow(/requires a query/);
    expect(mockBackendFetch).not.toHaveBeenCalled();
    expect(mockSingleShot).not.toHaveBeenCalled();
  });

  it('SD-U11: throws when bucket_id is missing', async () => {
    await expect(run({ query: 'something' })).rejects.toThrow(/requires a bucket/);
    expect(mockBackendFetch).not.toHaveBeenCalled();
    expect(mockSingleShot).not.toHaveBeenCalled();
  });

  it('SD-U12: drops malformed hits (non-object, missing path+snippet) but keeps valid ones', async () => {
    mockBackendFetch.mockResolvedValueOnce(SAMPLE_CONTENTS);
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify([
        'not an object',
        {},
        { path: '/ok.md', snippet: 'good', score: 0.8 },
        null,
      ]),
    );
    const result = await run({ query: 'q', bucket_id: 'bk-1' });
    const results = result.data.results as Array<{ path: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('/ok.md');
  });
});
