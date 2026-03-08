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
});
