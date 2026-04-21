import { describe, it, expect, vi } from 'vitest';
import { conditionAction } from '../actions/condition';
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

describe('conditionAction', () => {
  it('evaluates equals operator — true', async () => {
    const result = await conditionAction.execute({
      params: { field: 'status', operator: 'equals', value: 'active' },
      wiredInputs: { status: 'active' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
    expect(result.data.branch).toBe('true');
  });

  it('evaluates equals operator — false', async () => {
    const result = await conditionAction.execute({
      params: { field: 'status', operator: 'equals', value: 'active' },
      wiredInputs: { status: 'inactive' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(false);
    expect(result.data.branch).toBe('false');
  });

  it('evaluates not_equals operator', async () => {
    const result = await conditionAction.execute({
      params: { field: 'status', operator: 'not_equals', value: 'active' },
      wiredInputs: { status: 'inactive' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates contains operator', async () => {
    const result = await conditionAction.execute({
      params: { field: 'text', operator: 'contains', value: 'hello' },
      wiredInputs: { text: 'say hello world' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates not_contains operator', async () => {
    const result = await conditionAction.execute({
      params: { field: 'text', operator: 'not_contains', value: 'goodbye' },
      wiredInputs: { text: 'hello world' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates greater_than operator', async () => {
    const result = await conditionAction.execute({
      params: { field: 'count', operator: 'greater_than', value: '5' },
      wiredInputs: { count: 10 },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates less_than operator', async () => {
    const result = await conditionAction.execute({
      params: { field: 'count', operator: 'less_than', value: '5' },
      wiredInputs: { count: 3 },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates is_empty for empty string', async () => {
    const result = await conditionAction.execute({
      params: { field: 'val', operator: 'is_empty' },
      wiredInputs: { val: '' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates is_empty for null', async () => {
    const result = await conditionAction.execute({
      params: { field: 'val', operator: 'is_empty' },
      wiredInputs: { val: null },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates is_not_empty', async () => {
    const result = await conditionAction.execute({
      params: { field: 'val', operator: 'is_not_empty' },
      wiredInputs: { val: 'something' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('evaluates matches_regex', async () => {
    const result = await conditionAction.execute({
      params: { field: 'email', operator: 'matches_regex', value: '^[^@]+@[^@]+$' },
      wiredInputs: { email: 'user@example.com' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('handles invalid regex gracefully', async () => {
    const result = await conditionAction.execute({
      params: { field: 'val', operator: 'matches_regex', value: '[invalid' },
      wiredInputs: { val: 'test' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(false);
  });

  it('supports dot-path field access', async () => {
    const result = await conditionAction.execute({
      params: { field: 'user.role', operator: 'equals', value: 'admin' },
      wiredInputs: { user: { role: 'admin' } },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
    expect(result.data.evaluated_value).toBe('admin');
  });

  it('throws when field is missing', async () => {
    await expect(
      conditionAction.execute({
        params: { field: '', operator: 'equals', value: 'test' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('Condition requires a field');
  });

  it('type-coerces numbers in equals', async () => {
    const result = await conditionAction.execute({
      params: { field: 'count', operator: 'equals', value: '42' },
      wiredInputs: { count: 42 },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  // C-U9 — ReDoS protection: patterns longer than 200 chars must short-circuit
  // to `false` without constructing a RegExp. A pathological alternation of
  // `(a|a)` groups can blow up a backtracking engine; we don't let it run.
  it('rejects regex patterns longer than 200 chars as false (ReDoS guard)', async () => {
    const longPattern = '(a|a)'.repeat(50); // 250 chars > 200-char cap
    expect(longPattern.length).toBeGreaterThan(200);
    const result = await conditionAction.execute({
      params: { field: 'val', operator: 'matches_regex', value: longPattern },
      wiredInputs: { val: 'aaaaaa' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(false);
    expect(result.data.branch).toBe('false');
  });

  // C-U10 — arrays must stringify for equals/contains so user can match on
  // JSON payloads end-to-end, but `is_empty` is length-aware (not stringified).
  it('treats an empty array as is_empty=true', async () => {
    const result = await conditionAction.execute({
      params: { field: 'items', operator: 'is_empty' },
      wiredInputs: { items: [] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('treats a non-empty array as is_not_empty=true', async () => {
    const result = await conditionAction.execute({
      params: { field: 'items', operator: 'is_not_empty' },
      wiredInputs: { items: [1] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  // C-U11 — arrays must stringify to JSON for `contains`, so users can match
  // against entries by substring rather than needing to hand-roll a regex.
  it('stringifies arrays as JSON for contains', async () => {
    const result = await conditionAction.execute({
      params: { field: 'tags', operator: 'contains', value: 'alpha' },
      wiredInputs: { tags: ['alpha', 'beta'] },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  it('stringifies objects as JSON for contains', async () => {
    const result = await conditionAction.execute({
      params: { field: 'user', operator: 'contains', value: '"role":"admin"' },
      wiredInputs: { user: { role: 'admin', name: 'Alice' } },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
  });

  // C-U12 — evaluated_value must always be present on the output so the
  // Activity log / variable chips can surface what was actually compared.
  it('always returns evaluated_value even on false result', async () => {
    const result = await conditionAction.execute({
      params: { field: 'count', operator: 'equals', value: '99' },
      wiredInputs: { count: 7 },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(false);
    expect(result.data.evaluated_value).toBe(7);
  });

  it('returns undefined for evaluated_value when the field is missing', async () => {
    const result = await conditionAction.execute({
      params: { field: 'missing', operator: 'is_empty' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(true);
    expect(result.data.evaluated_value).toBeUndefined();
  });

  // C-U13 — non-numeric values in comparison operators must not coerce to 0
  // and pass; they must cleanly fail. Otherwise `NaN > 5 → false` but
  // `"" |> Number(0) > -1 → true` would be a silent correctness bug.
  it('returns false for greater_than when the field is non-numeric', async () => {
    const result = await conditionAction.execute({
      params: { field: 'name', operator: 'greater_than', value: '0' },
      wiredInputs: { name: 'Alice' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(false);
  });

  it('returns false for less_than when the comparison value is non-numeric', async () => {
    const result = await conditionAction.execute({
      params: { field: 'count', operator: 'less_than', value: 'not-a-number' },
      wiredInputs: { count: 10 },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.passed).toBe(false);
  });
});
