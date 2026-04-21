import { describe, it, expect, vi, afterEach } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

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

  // D-U4 — hours conversion: 3_600_000 ms per hour.
  // Uses fake timers so we don't actually wait an hour.
  it('converts hours to milliseconds deterministically', async () => {
    vi.useFakeTimers();
    const promise = delayAction.execute({
      params: { duration: 2, unit: 'hours' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    // 2 hours = 7_200_000 ms. Advance past it.
    await vi.advanceTimersByTimeAsync(7_200_000);
    const result = await promise;
    expect(result.data.delayed_ms).toBe(7_200_000);
  });

  // D-U5 — invalid durations must be rejected up-front with a clear message,
  // not silently coerced to 0 and resolved immediately.
  it.each([
    [0, '0 is not positive'],
    [-1, 'negative'],
    [undefined as unknown as number, 'missing'],
    [null as unknown as number, 'null'],
  ])('throws on invalid duration: %s (%s)', async (duration) => {
    await expect(
      delayAction.execute({
        params: { duration, unit: 'seconds' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/positive duration/);
  });

  // D-U6 — completed_at must be a valid ISO timestamp so downstream steps
  // can treat it as a Date without defensive parsing.
  it('returns completed_at as a valid ISO 8601 timestamp', async () => {
    const result = await delayAction.execute({
      params: { duration: 0.01, unit: 'seconds' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    const completedAt = result.data.completed_at as string;
    expect(completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(new Date(completedAt).getTime())).toBe(false);
  });

  // D-U7 — wiredInputs must pass through unchanged so Delay can be a no-op
  // in the middle of a DAG without losing upstream data.
  it('spreads wiredInputs onto the output alongside delay metadata', async () => {
    const result = await delayAction.execute({
      params: { duration: 0.01, unit: 'seconds' },
      wiredInputs: { a: 1, b: 'two', nested: { x: 9 } },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.data.a).toBe(1);
    expect(result.data.b).toBe('two');
    expect(result.data.nested).toEqual({ x: 9 });
    expect(result.data.delayed_ms).toBe(10);
  });

  // D-U8 — summary surfaces the configured duration + unit for Activity log.
  it('includes the configured duration and unit in the summary', async () => {
    const result = await delayAction.execute({
      params: { duration: 0.01, unit: 'seconds' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(result.summary).toMatch(/0\.01/);
    expect(result.summary).toMatch(/seconds/);
  });
});
