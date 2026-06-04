import { describe, it, expect } from 'vitest';
import { DAGExecutor } from '../dag/executor';
import type { ExecutorContext } from '../dag/executor';
import { ActionRegistry } from '../actions/registry';
import { transformerAction } from '../actions/transformer';
import type { ActionDefinition } from '../actions/types';
import type { DAGDefinition, StepDefinition } from '../dag/types';
import { RunScratchpad } from '../scratchpad';
import { RunEventEmitter } from '../events/emitter';
import type { ExecutionEvent } from '../events/types';

// ── Test helpers ────────────────────────────────────────────────

function makeStep(overrides: Partial<StepDefinition> & { id: string }): StepDefinition {
  return {
    name: overrides.id,
    actionType: 'transformer',
    params: { operation: 'extract', path: '' },
    dependsOn: [],
    inputMappings: [],
    requiresApproval: false,
    onError: 'fail',
    ...overrides,
  };
}

function makeMockEmitter(): { emitter: RunEventEmitter; events: ExecutionEvent[] } {
  const events: ExecutionEvent[] = [];
  const mockWebContents = { isDestroyed: () => false, send: () => {} } as any;
  const emitter = new RunEventEmitter(mockWebContents, 'test-run');
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event: ExecutionEvent) => {
    events.push(event);
    originalEmit(event);
  };
  return { emitter, events };
}

function makeContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  return {
    runId: 'test-run',
    backendPort: 9999,
    signal: new AbortController().signal,
    resolveModel: async () => null,
    ...overrides,
  };
}

function makeRegistry(...extras: ActionDefinition[]): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(transformerAction);
  for (const a of extras) registry.register(a);
  return registry;
}

// ── Topological ordering ────────────────────────────────────────

describe('executor: topological ordering', () => {
  it('executes A -> B -> C in correct order', async () => {
    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A' }),
        makeStep({ id: 'B', dependsOn: ['A'] }),
        makeStep({ id: 'C', dependsOn: ['B'] }),
      ],
    };

    const { emitter, events } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await executor.execute();

    const started = events
      .filter((e) => e.type === 'step_started')
      .map((e) => (e as Extract<ExecutionEvent, { type: 'step_started' }>).stepId);
    expect(started).toEqual(['A', 'B', 'C']);
  });

  it('runs parallel branches and gates the join step', async () => {
    const executionLog: string[] = [];

    const loggingAction: ActionDefinition = {
      ...transformerAction,
      type: 'logging',
      execute: async (input) => {
        executionLog.push(`start:${input.context.stepId}`);
        const result = await transformerAction.execute(input);
        executionLog.push(`end:${input.context.stepId}`);
        return result;
      },
    };

    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A', actionType: 'logging' }),
        makeStep({ id: 'B', actionType: 'logging', dependsOn: ['A'] }),
        makeStep({ id: 'C', actionType: 'logging', dependsOn: ['A'] }),
        makeStep({ id: 'D', actionType: 'logging', dependsOn: ['B', 'C'] }),
      ],
    };

    const { emitter } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(loggingAction),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await executor.execute();

    // B and C both finish before D starts
    expect(executionLog.indexOf('end:B')).toBeLessThan(executionLog.indexOf('start:D'));
    expect(executionLog.indexOf('end:C')).toBeLessThan(executionLog.indexOf('start:D'));
  });
});

// ── Input wiring ────────────────────────────────────────────────

describe('executor: input wiring', () => {
  it('wires output fields into downstream step via dot-path', async () => {
    let receivedInputs: Record<string, unknown> = {};

    const capturingAction: ActionDefinition = {
      ...transformerAction,
      type: 'capturing',
      execute: async (input) => {
        if (input.context.stepId === 'B') {
          receivedInputs = { ...input.wiredInputs };
        }
        if (input.context.stepId === 'A') {
          return {
            data: { response: { items: [{ title: 'hello' }] } },
            summary: 'Produced nested data',
          };
        }
        return transformerAction.execute(input);
      },
    };

    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A', actionType: 'capturing' }),
        makeStep({
          id: 'B',
          actionType: 'capturing',
          dependsOn: ['A'],
          inputMappings: [
            { sourceStepId: 'A', sourceField: 'response.items[0].title', targetField: 'value' },
          ],
        }),
      ],
    };

    const { emitter } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(capturingAction),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await executor.execute();

    expect(receivedInputs.value).toBe('hello');
  });
});

// ── Error policies ──────────────────────────────────────────────

describe('executor: error policies', () => {
  const failingAction: ActionDefinition = {
    ...transformerAction,
    type: 'failing',
    execute: async () => {
      throw new Error('boom');
    },
  };

  it('onError: fail — aborts entire run', async () => {
    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A', actionType: 'failing', onError: 'fail' }),
        makeStep({ id: 'B', dependsOn: ['A'] }),
      ],
    };

    const { emitter, events } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(failingAction),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );

    await expect(executor.execute()).rejects.toThrow('boom');
    expect(events.some((e) => e.type === 'step_failed')).toBe(true);
    // B never started
    const started = events.filter((e) => e.type === 'step_started') as Array<
      Extract<ExecutionEvent, { type: 'step_started' }>
    >;
    expect(started.every((e) => e.stepId !== 'B')).toBe(true);
  });

  it('onError: skip — marks step skipped and downstream gets undefined wiredInputs', async () => {
    let receivedInputs: Record<string, unknown> = {};

    const captureAction: ActionDefinition = {
      ...transformerAction,
      type: 'capture',
      execute: async (input) => {
        receivedInputs = { ...input.wiredInputs };
        return { data: { result: 'ok' }, summary: 'ok' };
      },
    };

    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A', actionType: 'failing', onError: 'skip' }),
        makeStep({
          id: 'B',
          actionType: 'capture',
          dependsOn: ['A'],
          inputMappings: [{ sourceStepId: 'A', sourceField: 'result', targetField: 'data' }],
        }),
      ],
    };

    const { emitter, events } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(failingAction, captureAction),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await executor.execute();

    expect(events.some((e) => e.type === 'step_skipped')).toBe(true);
    expect(events.some((e) => e.type === 'step_completed' && (e as any).stepId === 'B')).toBe(true);
    expect(receivedInputs.data).toBeUndefined();
  });

  it('onError: retry — succeeds after transient failures', async () => {
    let callCount = 0;
    const retryAction: ActionDefinition = {
      ...transformerAction,
      type: 'retry',
      execute: async () => {
        callCount++;
        if (callCount < 3) throw new Error(`fail ${callCount}`);
        return { data: { result: 'ok' }, summary: 'ok' };
      },
    };

    const dag: DAGDefinition = {
      steps: [makeStep({ id: 'A', actionType: 'retry', onError: 'retry', maxRetries: 2 })],
    };

    const { emitter } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(retryAction),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await executor.execute();

    expect(callCount).toBe(3);
  });

  it('onError: retry — aborts after exhausting retries', async () => {
    const alwaysFails: ActionDefinition = {
      ...transformerAction,
      type: 'always_fails',
      execute: async () => {
        throw new Error('persistent');
      },
    };

    const dag: DAGDefinition = {
      steps: [makeStep({ id: 'A', actionType: 'always_fails', onError: 'retry', maxRetries: 1 })],
    };

    const { emitter } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(alwaysFails),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await expect(executor.execute()).rejects.toThrow('persistent');
  });
});

// ── Cancellation and timeout ────────────────────────────────────

describe('executor: cancellation and timeout', () => {
  it('abort signal cancels between waves', async () => {
    const abortController = new AbortController();

    const abortingAction: ActionDefinition = {
      ...transformerAction,
      type: 'aborter',
      execute: async () => {
        abortController.abort();
        return { data: {}, summary: 'done' };
      },
    };

    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A', actionType: 'aborter' }),
        makeStep({ id: 'B', dependsOn: ['A'] }),
      ],
    };

    const { emitter } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(abortingAction),
      new RunScratchpad(),
      emitter,
      makeContext({ signal: abortController.signal }),
    );
    await expect(executor.execute()).rejects.toThrow('cancelled');
  });

  it('step timeout triggers failure', async () => {
    const hangingAction: ActionDefinition = {
      ...transformerAction,
      type: 'hanger',
      execute: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    };

    const dag: DAGDefinition = {
      steps: [makeStep({ id: 'A', actionType: 'hanger', timeoutMs: 50 })],
    };

    const { emitter } = makeMockEmitter();
    const executor = new DAGExecutor(
      dag,
      makeRegistry(hangingAction),
      new RunScratchpad(),
      emitter,
      makeContext(),
    );
    await expect(executor.execute()).rejects.toThrow('timed out');
  }, 10_000);
});
