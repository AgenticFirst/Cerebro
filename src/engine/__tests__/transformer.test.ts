import { describe, it, expect } from 'vitest';
import { transformerAction } from '../actions/transformer';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// ── Test helpers ────────────────────────────────────────────────

function makeContext(): ActionContext {
  return {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: () => {},
    emitEvent: () => {},
    resolveModel: async () => null,
  };
}

async function transform(
  operation: string,
  wiredInputs: Record<string, unknown>,
  extraParams: Record<string, unknown> = {},
) {
  const result = await transformerAction.execute({
    params: { operation, ...extraParams },
    wiredInputs,
    scratchpad: new RunScratchpad(),
    context: makeContext(),
  });
  return result.data.result;
}

// ── format: hand-written regex interpolation ────────────────────

describe('transformer: format', () => {
  it('interpolates nested dot-path keys', async () => {
    const result = await transform('format', { data: { user: { name: 'Eve' } } }, {
      template: 'Welcome {{user.name}}',
    });
    expect(result).toBe('Welcome Eve');
  });

  it('replaces missing keys with empty string (not undefined)', async () => {
    const result = await transform('format', { data: {} }, {
      template: 'Value: {{missing}}',
    });
    expect(result).toBe('Value: ');
  });
});

// ── extract: hand-written dot-path parser ───────────────────────

describe('transformer: extract', () => {
  it('traverses nested object path', async () => {
    const data = { user: { profile: { name: 'Alice' } } };
    const result = await transform('extract', { data }, { path: 'user.profile.name' });
    expect(result).toBe('Alice');
  });

  it('handles array index notation', async () => {
    const data = { events: [{ title: 'Meeting' }, { title: 'Lunch' }] };
    const result = await transform('extract', { data }, { path: 'events[1].title' });
    expect(result).toBe('Lunch');
  });

  it('handles consecutive array indices (matrix[1][0])', async () => {
    const data = { matrix: [[1, 2], [3, 4]] };
    const result = await transform('extract', { data }, { path: 'matrix[1][0]' });
    expect(result).toBe(3);
  });

  it('returns undefined for missing intermediate path', async () => {
    const result = await transform('extract', { data: { a: 1 } }, { path: 'b.c.d' });
    expect(result).toBeUndefined();
  });

  it('returns undefined for out-of-bounds array index', async () => {
    const result = await transform('extract', { data: { items: [1] } }, { path: 'items[99]' });
    expect(result).toBeUndefined();
  });

  it('returns whole data for empty path', async () => {
    const data = { a: 1 };
    const result = await transform('extract', { data }, { path: '' });
    expect(result).toEqual({ a: 1 });
  });
});

// ── filter: expr-eval integration ───────────────────────────────

describe('transformer: filter', () => {
  it('filters by numeric comparison', async () => {
    const items = [{ score: 0.3 }, { score: 0.7 }, { score: 0.9 }];
    const result = await transform('filter', { items }, { predicate: 'score > 0.5' });
    expect(result).toEqual([{ score: 0.7 }, { score: 0.9 }]);
  });

  it('uses expr-eval and/or syntax (not &&/||)', async () => {
    const items = [
      { score: 0.8, priority: 1 },
      { score: 0.3, priority: 1 },
      { score: 0.9, priority: 2 },
    ];
    const result = await transform('filter', { items }, { predicate: 'score > 0.5 and priority == 1' });
    expect(result).toEqual([{ score: 0.8, priority: 1 }]);
  });

  it('skips non-object items without crashing', async () => {
    const items = [42, 'string', null, { score: 1 }];
    const result = await transform('filter', { items }, { predicate: 'score > 0' });
    expect(result).toEqual([{ score: 1 }]);
  });
});

// ── merge: hand-written deep merge logic ────────────────────────

describe('transformer: merge', () => {
  it('shallow merge replaces nested objects entirely', async () => {
    const sources = [
      { config: { a: 1, b: 2 } },
      { config: { a: 99 } },
    ];
    const result = await transform('merge', { sources }, { mergeStrategy: 'shallow' });
    expect(result).toEqual({ config: { a: 99 } });
  });

  it('deep merge recursively merges nested objects', async () => {
    const sources = [
      { config: { a: 1, b: 2, nested: { x: 1 } } },
      { config: { a: 99, nested: { y: 2 } } },
    ];
    const result = await transform('merge', { sources }, { mergeStrategy: 'deep' });
    expect(result).toEqual({
      config: { a: 99, b: 2, nested: { x: 1, y: 2 } },
    });
  });

  it('deep merge replaces arrays (does not concatenate)', async () => {
    const sources = [{ items: [1, 2] }, { items: [3] }];
    const result = await transform('merge', { sources }, { mergeStrategy: 'deep' });
    expect(result).toEqual({ items: [3] });
  });
});

// ── error handling ──────────────────────────────────────────────

describe('transformer: errors', () => {
  it('throws on unknown operation', async () => {
    await expect(
      transform('bogus' as string, {}),
    ).rejects.toThrow('Unknown transformer operation: bogus');
  });
});
