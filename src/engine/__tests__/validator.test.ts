import { describe, it, expect } from 'vitest';
import { validateDAG, DAGValidationError } from '../dag/validator';
import { ActionRegistry } from '../actions/registry';
import { transformerAction } from '../actions/transformer';
import { modelCallAction } from '../actions/model-call';
import type { DAGDefinition, StepDefinition } from '../dag/types';

// ── Test helpers ────────────────────────────────────────────────

function makeRegistry(): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register(transformerAction);
  registry.register(modelCallAction);
  return registry;
}

function makeStep(overrides: Partial<StepDefinition> & { id: string }): StepDefinition {
  return {
    name: overrides.id,
    actionType: 'transformer',
    params: { operation: 'extract', path: 'value' },
    dependsOn: [],
    inputMappings: [],
    requiresApproval: false,
    onError: 'fail',
    ...overrides,
  };
}

// ── Cycle detection ─────────────────────────────────────────────

describe('validator: cycle detection', () => {
  it('detects a cycle and reports path', () => {
    const dag: DAGDefinition = {
      steps: [makeStep({ id: 'A', dependsOn: ['B'] }), makeStep({ id: 'B', dependsOn: ['A'] })],
    };

    expect(() => validateDAG(dag, makeRegistry())).toThrow(DAGValidationError);
    try {
      validateDAG(dag, makeRegistry());
    } catch (err) {
      expect((err as DAGValidationError).details.some((d) => d.includes('Cycle detected'))).toBe(
        true,
      );
    }
  });

  it('passes a valid diamond DAG', () => {
    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A' }),
        makeStep({ id: 'B', dependsOn: ['A'] }),
        makeStep({ id: 'C', dependsOn: ['A'] }),
        makeStep({ id: 'D', dependsOn: ['B', 'C'] }),
      ],
    };

    expect(validateDAG(dag, makeRegistry()).valid).toBe(true);
  });
});

// ── Action type checks ──────────────────────────────────────────

describe('validator: action type existence', () => {
  it('rejects unknown action types', () => {
    const dag: DAGDefinition = {
      steps: [makeStep({ id: 'A', actionType: 'nonexistent_action' })],
    };

    expect(() => validateDAG(dag, makeRegistry())).toThrow(DAGValidationError);
    try {
      validateDAG(dag, makeRegistry());
    } catch (err) {
      expect(
        (err as DAGValidationError).details.some((d) =>
          d.includes('unknown action type "nonexistent_action"'),
        ),
      ).toBe(true);
    }
  });
});

// ── Input mapping validation ────────────────────────────────────

describe('validator: input mapping validity', () => {
  it('rejects input mappings referencing non-existent steps', () => {
    const dag: DAGDefinition = {
      steps: [
        makeStep({
          id: 'A',
          inputMappings: [
            { sourceStepId: 'nonexistent', sourceField: 'result', targetField: 'data' },
          ],
        }),
      ],
    };

    expect(() => validateDAG(dag, makeRegistry())).toThrow(DAGValidationError);
    try {
      validateDAG(dag, makeRegistry());
    } catch (err) {
      expect(
        (err as DAGValidationError).details.some((d) =>
          d.includes('non-existent step "nonexistent"'),
        ),
      ).toBe(true);
    }
  });

  it('rejects input mappings from steps not in dependency chain', () => {
    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A' }),
        makeStep({ id: 'B' }),
        makeStep({
          id: 'C',
          dependsOn: ['A'],
          inputMappings: [{ sourceStepId: 'B', sourceField: 'result', targetField: 'data' }],
        }),
      ],
    };

    expect(() => validateDAG(dag, makeRegistry())).toThrow(DAGValidationError);
    try {
      validateDAG(dag, makeRegistry());
    } catch (err) {
      expect(
        (err as DAGValidationError).details.some((d) => d.includes('not in its dependency chain')),
      ).toBe(true);
    }
  });

  it('accepts input mappings from transitive dependencies', () => {
    const dag: DAGDefinition = {
      steps: [
        makeStep({ id: 'A' }),
        makeStep({ id: 'B', dependsOn: ['A'] }),
        makeStep({
          id: 'C',
          dependsOn: ['B'],
          inputMappings: [{ sourceStepId: 'A', sourceField: 'result', targetField: 'upstream' }],
        }),
      ],
    };

    expect(validateDAG(dag, makeRegistry()).valid).toBe(true);
  });
});
