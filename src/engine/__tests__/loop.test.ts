import { describe, it, expect, vi } from 'vitest';
import { loopAction } from '../actions/loop';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

function makeContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
    ...overrides,
  };
}

describe('loopAction', () => {
  // L-U1
  it('throws when items_field is missing', async () => {
    await expect(
      loopAction.execute({
        params: { items_field: '' },
        wiredInputs: { anything: [1, 2] },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/items_field/);
  });

  // L-U3
  it('extracts an array by dot-path and returns items + count + variable_name', async () => {
    const result = await loopAction.execute({
      params: { items_field: 'fruits', variable_name: 'fruit' },
      wiredInputs: { fruits: ['apple', 'banana', 'cherry'] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.items).toEqual(['apple', 'banana', 'cherry']);
    expect(result.data.count).toBe(3);
    expect(result.data.variable_name).toBe('fruit');
  });

  // L-U4
  it("defaults variable_name to 'item' when not provided", async () => {
    const result = await loopAction.execute({
      params: { items_field: 'xs' },
      wiredInputs: { xs: [1, 2] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.variable_name).toBe('item');
  });

  // L-U5
  it('supports nested dot-path extraction', async () => {
    const result = await loopAction.execute({
      params: { items_field: 'upstream.data.rows' },
      wiredInputs: { upstream: { data: { rows: [{ id: 1 }, { id: 2 }] } } },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.count).toBe(2);
    expect((result.data.items as Array<{ id: number }>)[1].id).toBe(2);
  });

  // L-U6
  it('accepts an empty array without error', async () => {
    const result = await loopAction.execute({
      params: { items_field: 'xs' },
      wiredInputs: { xs: [] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.items).toEqual([]);
    expect(result.data.count).toBe(0);
  });

  // L-U7
  it('surfaces the count in the summary for the Activity log', async () => {
    const result = await loopAction.execute({
      params: { items_field: 'xs', variable_name: 'x' },
      wiredInputs: { xs: [10, 20, 30, 40] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.summary).toMatch(/4/);
    expect(result.summary).toMatch(/"x"/);
  });

  // L-U2: non-array types must throw — we assert on the type in the message
  // so a regression that silently forwards `undefined` can't sneak through.
  it('throws with `got <type>` when the field is a string', async () => {
    await expect(
      loopAction.execute({
        params: { items_field: 'not_an_array' },
        wiredInputs: { not_an_array: 'oops' },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/got string/);
  });

  it('throws with `got object` when the field is a plain object', async () => {
    await expect(
      loopAction.execute({
        params: { items_field: 'obj' },
        wiredInputs: { obj: { a: 1 } },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/got object/);
  });

  it('throws with `got number` when the field is a number', async () => {
    await expect(
      loopAction.execute({
        params: { items_field: 'n' },
        wiredInputs: { n: 42 },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/got number/);
  });

  it('throws with `got undefined` when the field is missing at runtime', async () => {
    await expect(
      loopAction.execute({
        params: { items_field: 'missing' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/got undefined/);
  });

  it('throws with `got object` when the field is null (typeof null === "object")', async () => {
    await expect(
      loopAction.execute({
        params: { items_field: 'n' },
        wiredInputs: { n: null },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/got object/);
  });

  it('outputSchema declares items and count as required', () => {
    expect(loopAction.outputSchema.required).toEqual(
      expect.arrayContaining(['items', 'count']),
    );
  });
});
