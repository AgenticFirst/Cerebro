import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchMemoryAction } from '../actions/search-memory';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../../claude-code/single-shot', () => ({
  singleShotClaudeCode: vi.fn(),
}));

import { singleShotClaudeCode } from '../../claude-code/single-shot';

const mockSingleShot = vi.mocked(singleShotClaudeCode);

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 0,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
    ...overrides,
  } as ActionContext;
}

async function run(
  params: Record<string, unknown>,
  context: ActionContext = makeContext(),
) {
  return searchMemoryAction.execute({
    params,
    wiredInputs: {},
    scratchpad: new RunScratchpad(),
    context,
  });
}

describe('searchMemoryAction', () => {
  beforeEach(() => {
    mockSingleShot.mockReset();
  });

  it('SM-U1: parses well-formed JSON array into results + count', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify([
        { content: 'First match', source: 'notes/a.md', score: 0.9 },
        { content: 'Second match', source: 'notes/b.md', score: 0.7 },
      ]),
    );
    const result = await run({ query: 'coffee' });
    const results = result.data.results as Array<{ content: string; source: string; score: number }>;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ content: 'First match', source: 'notes/a.md', score: 0.9 });
    expect(results[1]).toEqual({ content: 'Second match', source: 'notes/b.md', score: 0.7 });
    expect(result.data.count).toBe(2);
  });

  it('SM-U2: extracts JSON array even when surrounded by extra prose', async () => {
    mockSingleShot.mockResolvedValueOnce(
      'Here are the matches I found:\n[{"content":"hit","source":null,"score":0.5}]\nHope that helps!',
    );
    const result = await run({ query: 'anything' });
    const results = result.data.results as Array<{ content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('hit');
  });

  it('SM-U3: falls back to a single plain-text row when Claude does not return JSON', async () => {
    mockSingleShot.mockResolvedValueOnce('I could not find anything structured but here is what I know.');
    const result = await run({ query: 'x' });
    const results = result.data.results as Array<{ content: string; source: string | null; score: number }>;
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('I could not find anything structured but here is what I know.');
    expect(results[0].source).toBeNull();
    expect(results[0].score).toBe(0);
  });

  it('SM-U4: returns an empty result set when Claude responds with only whitespace', async () => {
    mockSingleShot.mockResolvedValueOnce('   \n  ');
    const result = await run({ query: 'x' });
    expect(result.data.results).toEqual([]);
    expect(result.data.count).toBe(0);
  });

  it('SM-U5: caps results to max_results (default 5)', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      content: `match ${i}`,
      source: null,
      score: 1 - i * 0.01,
    }));
    mockSingleShot.mockResolvedValueOnce(JSON.stringify(rows));
    const result = await run({ query: 'x' });
    expect((result.data.results as unknown[]).length).toBe(5);
    expect(result.data.count).toBe(5);
  });

  it("SM-U6: defaults agent to 'cerebro' when no agent param is supplied", async () => {
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'hello' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'cerebro' }),
    );
  });

  it('SM-U7: forwards a specific expert agent slug when provided', async () => {
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'hello', agent: 'fitness-coach-ab12' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'fitness-coach-ab12' }),
    );
  });

  it('SM-U8: passes Read,Glob,Grep as the allowedTools whitelist', async () => {
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'hello' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ allowedTools: 'Read,Glob,Grep' }),
    );
  });

  it('SM-U9: forwards a model override when provided', async () => {
    mockSingleShot.mockResolvedValueOnce('[]');
    await run({ query: 'hello', model: 'claude-sonnet-4-6' });
    expect(mockSingleShot).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });

  it('SM-U10: throws when the query is empty and does not spawn Claude Code', async () => {
    await expect(run({ query: '' })).rejects.toThrow(/requires a query/);
    await expect(run({ query: '   ' })).rejects.toThrow(/requires a query/);
    expect(mockSingleShot).not.toHaveBeenCalled();
  });

  it('SM-U11: drops malformed hits (non-object, missing content) but keeps valid ones', async () => {
    mockSingleShot.mockResolvedValueOnce(
      JSON.stringify([
        'not an object',
        { source: 'no-content.md', score: 0.5 },
        { content: 'valid', source: 'ok.md', score: 0.9 },
        null,
      ]),
    );
    const result = await run({ query: 'x' });
    const results = result.data.results as Array<{ content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('valid');
  });
});
