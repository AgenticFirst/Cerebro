import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { DAGExecutor } from '../dag/executor';
import { ActionRegistry } from '../actions/registry';
import { conditionAction } from '../actions/condition';
import { RunScratchpad } from '../scratchpad';
import { RunEventEmitter } from '../events/emitter';
import type { StepDefinition, DAGDefinition } from '../dag/types';
import type { ActionDefinition, ActionInput, ActionOutput } from '../actions/types';

// A simple passthrough action for testing
const passthroughAction: ActionDefinition = {
  type: 'passthrough',
  name: 'Passthrough',
  description: 'Returns wiredInputs as data',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  execute: async (input: ActionInput): Promise<ActionOutput> => ({
    data: { ...input.wiredInputs },
    summary: 'passthrough',
  }),
};

function makeRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(conditionAction);
  registry.register(passthroughAction);
  return registry;
}

function makeEmitter() {
  const events: unknown[] = [];
  const mockWc = {
    isDestroyed: () => false,
    send: vi.fn(),
    ipc: new EventEmitter(),
  } as any;
  const emitter = new RunEventEmitter(mockWc, 'test-run', (event) => events.push(event));
  return { emitter, events };
}

describe('condition branching in DAGExecutor', () => {
  it('skips steps whose branchCondition does not match', async () => {
    const dag: DAGDefinition = {
      steps: [
        {
          id: 'cond',
          name: 'Condition',
          actionType: 'condition',
          params: { field: 'status', operator: 'equals', value: 'active' },
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'true-branch',
          name: 'True Branch',
          actionType: 'passthrough',
          params: {},
          dependsOn: ['cond'],
          inputMappings: [
            { sourceStepId: 'cond', sourceField: 'passed', targetField: 'passed', branchCondition: 'true' },
          ],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'false-branch',
          name: 'False Branch',
          actionType: 'passthrough',
          params: {},
          dependsOn: ['cond'],
          inputMappings: [
            { sourceStepId: 'cond', sourceField: 'passed', targetField: 'passed', branchCondition: 'false' },
          ],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
    };

    const registry = makeRegistry();
    const { emitter, events } = makeEmitter();

    // The condition will evaluate to TRUE (status === 'active')
    // So true-branch should run, false-branch should be skipped

    // We need to wire the status input -- let's add a first step
    const dagWithInput: DAGDefinition = {
      steps: [
        {
          id: 'input',
          name: 'Input',
          actionType: 'passthrough',
          params: {},
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          ...dag.steps[0],
          dependsOn: ['input'],
          inputMappings: [
            { sourceStepId: 'input', sourceField: 'status', targetField: 'status' },
          ],
        },
        dag.steps[1],
        dag.steps[2],
      ],
    };

    // The passthrough action will output wiredInputs, which starts empty
    // for 'input' step. We need the condition to get its data from wiredInputs.
    // Let's simplify: just test condition directly with static params
    const simpleDag: DAGDefinition = {
      steps: [
        {
          id: 'cond',
          name: 'Condition',
          actionType: 'condition',
          // The condition reads 'status' from wiredInputs, but since there are no
          // input mappings for the condition step itself, wiredInputs is empty.
          // The condition uses extractByPath on wiredInputs. With no input, the field
          // will be undefined. So let's set operator to is_empty which should pass.
          params: { field: 'anything', operator: 'is_empty' },
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'true-branch',
          name: 'True Branch',
          actionType: 'passthrough',
          params: {},
          dependsOn: ['cond'],
          inputMappings: [
            { sourceStepId: 'cond', sourceField: 'passed', targetField: 'passed', branchCondition: 'true' },
          ],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'false-branch',
          name: 'False Branch',
          actionType: 'passthrough',
          params: {},
          dependsOn: ['cond'],
          inputMappings: [
            { sourceStepId: 'cond', sourceField: 'passed', targetField: 'passed', branchCondition: 'false' },
          ],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
    };

    const executor = new DAGExecutor(
      simpleDag,
      registry,
      new RunScratchpad(),
      emitter,
      {
        runId: 'test-run',
        backendPort: 9999,
        signal: new AbortController().signal,
        resolveModel: vi.fn(),
      },
    );

    await executor.execute();

    // Condition evaluates `is_empty` on undefined field -> true
    // true-branch should run (branchCondition 'true' matches)
    // false-branch should be skipped (branchCondition 'false' doesn't match)

    const completedEvents = (events as any[]).filter(e => e.type === 'step_completed');
    const skippedEvents = (events as any[]).filter(e => e.type === 'step_skipped');

    // cond + true-branch completed
    expect(completedEvents.map(e => e.stepId)).toContain('cond');
    expect(completedEvents.map(e => e.stepId)).toContain('true-branch');

    // false-branch skipped
    expect(skippedEvents.map(e => e.stepId)).toContain('false-branch');
  });
});
