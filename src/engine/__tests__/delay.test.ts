import { describe, it, expect, vi } from 'vitest';
import { delayAction } from '../actions/delay';
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

describe('delayAction', () => {
  it('delays for the specified time in seconds', async () => {
    const start = Date.now();
    const result = await delayAction.execute({
      params: { duration: 0.05, unit: 'seconds' },
      wiredInputs: { upstream: 'data' },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(result.data.delayed_ms).toBe(50);
    expect(result.data.completed_at).toBeDefined();
    // Passes through wiredInputs
    expect(result.data.upstream).toBe('data');
  });

  it('converts minutes to milliseconds', async () => {
    const result = await delayAction.execute({
      params: { duration: 0.001, unit: 'minutes' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.delayed_ms).toBe(60);
  });

  it('rejects when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      delayAction.execute({
        params: { duration: 1, unit: 'seconds' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext({ signal: ac.signal }),
      }),
    ).rejects.toThrow('Aborted');
  });

  it('rejects when signal is aborted during wait', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);

    await expect(
      delayAction.execute({
        params: { duration: 10, unit: 'seconds' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext({ signal: ac.signal }),
      }),
    ).rejects.toThrow('Aborted');
  });
});
