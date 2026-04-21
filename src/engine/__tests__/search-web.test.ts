import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchWebAction } from '../actions/search-web';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../../claude-code/single-shot', () => ({
  singleShotClaudeCode: vi.fn(),
}));

import { singleShotClaudeCode } from '../../claude-code/single-shot';

const mockSingleShot = vi.mocked(singleShotClaudeCode);

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 0,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

describe('searchWebAction', () => {
  beforeEach(() => {
    mockSingleShot.mockReset();
  });

  it('parses JSON results from Claude Code output', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify({
        results: [
          { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result' },
          { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result' },
        ],
        ai_answer: 'AI answer summary',
      }),
    );

    const result = await searchWebAction.execute({
      params: { query: 'test query', max_results: 5, include_ai_answer: true },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    const results = result.data.results as Array<{ title: string; url: string; snippet: string }>;
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Result 1');
    expect(results[0].url).toBe('https://example.com/1');
    expect(results[0].snippet).toBe('First result');
    expect(result.data.ai_answer).toBe('AI answer summary');
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: 'WebSearch,WebFetch' }),
    );
  });

  it('strips code fences around the JSON', async () => {
    mockSingleShot.mockResolvedValueOnce(
      '```json\n{"results":[{"title":"X","url":"https://x.test","snippet":"y"}]}\n```',
    );
    const result = await searchWebAction.execute({
      params: { query: 'q' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    const results = result.data.results as Array<{ url: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://x.test');
  });

  it('suppresses ai_answer when include_ai_answer is false', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify({ results: [], ai_answer: 'should not appear' }),
    );
    const result = await searchWebAction.execute({
      params: { query: 'q', include_ai_answer: false },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.ai_answer).toBeNull();
  });

  it('throws when query is missing', async () => {
    await expect(
      searchWebAction.execute({
        params: { query: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a query');
  });

  it('SW-U5: coerces content→snippet when Claude returns content instead of snippet', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify({
        results: [{ title: 'T', url: 'https://a.test', content: 'body in content key' }],
      }),
    );
    const result = await searchWebAction.execute({
      params: { query: 'q' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    const results = result.data.results as Array<{ snippet: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe('body in content key');
  });

  it('SW-U6: drops rows that have no URL (invalid results)', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify({
        results: [
          { title: 'No URL', snippet: 'skip me' },
          { title: 'Good', url: 'https://ok.test', snippet: 'keep me' },
        ],
      }),
    );
    const result = await searchWebAction.execute({
      params: { query: 'q' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    const results = result.data.results as Array<{ url: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://ok.test');
  });

  it('SW-U7: caps results to max_results', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      title: `T${i}`,
      url: `https://r${i}.test`,
      snippet: `s${i}`,
    }));
    mockSingleShot.mockResolvedValueOnce(JSON.stringify({ results: rows }));
    const result = await searchWebAction.execute({
      params: { query: 'q', max_results: 4 },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect((result.data.results as unknown[]).length).toBe(4);
  });

  it('SW-U8: targets cerebro agent and passes WebSearch,WebFetch as allowedTools', async () => {
    mockSingleShot.mockResolvedValueOnce('{"results": []}');
    await searchWebAction.execute({
      params: { query: 'q' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'cerebro',
        allowedTools: 'WebSearch,WebFetch',
      }),
    );
  });

  it('SW-U9: forwards a model override when provided', async () => {
    mockSingleShot.mockResolvedValueOnce('{"results": []}');
    await searchWebAction.execute({
      params: { query: 'q', model: 'claude-sonnet-4-6' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });
});
