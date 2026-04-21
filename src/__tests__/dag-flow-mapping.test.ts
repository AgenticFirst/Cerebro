import { describe, it, expect } from 'vitest';
import type { Node, Edge } from '@xyflow/react';
import {
  flowToDag,
  dagToFlow,
  TRIGGER_NODE_ID,
  type CanvasDefinition,
  type RoutineStepData,
} from '../utils/dag-flow-mapping';

// ── Helpers ────────────────────────────────────────────────────

function stepNode(
  id: string,
  actionType: string,
  overrides: Partial<RoutineStepData> = {},
): Node {
  return {
    id,
    type: 'routineStep',
    position: { x: 0, y: 0 },
    data: {
      stepId: id,
      name: `Step ${id}`,
      actionType,
      params: {},
      dependsOn: [],
      inputMappings: [],
      requiresApproval: false,
      onError: 'fail',
      ...overrides,
    } as RoutineStepData,
  };
}

function triggerNode(): Node {
  return {
    id: TRIGGER_NODE_ID,
    type: 'triggerNode',
    position: { x: 0, y: -120 },
    data: { triggerType: 'trigger_manual', config: {} },
    deletable: false,
  };
}

function edge(source: string, target: string, id = `e-${source}-${target}`): Edge {
  return { id, source, target, type: 'smoothstep' };
}

// ── flowToDag: trigger edges are stripped ──────────────────────

describe('flowToDag', () => {
  it('drops trigger→step edges from dependsOn (bug: validator rejected __trigger__ deps)', () => {
    const a = stepNode('a', 'ask_ai');
    const b = stepNode('b', 'send_notification');
    const trig = triggerNode();
    const edges: Edge[] = [
      edge(TRIGGER_NODE_ID, 'a'),
      edge(TRIGGER_NODE_ID, 'b'),
      edge('a', 'b'),
    ];

    const dag = flowToDag([a, b], edges, trig, []);

    const stepA = dag.steps.find((s) => s.id === 'a')!;
    const stepB = dag.steps.find((s) => s.id === 'b')!;
    expect(stepA.dependsOn).toEqual([]);
    expect(stepB.dependsOn).toEqual(['a']);
    // Trigger payload still persisted separately
    expect(dag.trigger?.triggerType).toBe('trigger_manual');
  });

  it('serializes step→step edges unchanged when no trigger edges are present', () => {
    const a = stepNode('a', 'ask_ai');
    const b = stepNode('b', 'send_notification');
    const dag = flowToDag([a, b], [edge('a', 'b')], null, []);
    expect(dag.steps.find((s) => s.id === 'b')!.dependsOn).toEqual(['a']);
  });
});

// ── dagToFlow: trigger→root edges are auto-derived ─────────────

describe('dagToFlow', () => {
  it('renders a trigger→step edge for every root step when dag.trigger is present', () => {
    const dag: CanvasDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Ask',
          actionType: 'ask_ai',
          params: {},
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'b',
          name: 'Notify',
          actionType: 'send_notification',
          params: {},
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };

    const { edges } = dagToFlow(dag);
    const triggerEdges = edges.filter((e) => e.source === TRIGGER_NODE_ID);
    expect(triggerEdges.map((e) => e.target).sort()).toEqual(['a', 'b']);
  });

  it('does NOT render trigger edges when no trigger exists', () => {
    const dag: CanvasDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Ask',
          actionType: 'ask_ai',
          params: {},
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
    };
    const { edges } = dagToFlow(dag);
    expect(edges.filter((e) => e.source === TRIGGER_NODE_ID)).toEqual([]);
  });

  it('only roots get a trigger edge, not interior steps', () => {
    const dag: CanvasDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Root',
          actionType: 'ask_ai',
          params: {},
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'b',
          name: 'Child',
          actionType: 'send_notification',
          params: {},
          dependsOn: ['a'],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };
    const { edges } = dagToFlow(dag);
    const triggerTargets = edges
      .filter((e) => e.source === TRIGGER_NODE_ID)
      .map((e) => e.target);
    expect(triggerTargets).toEqual(['a']);
  });

  it('sanitizes stale __trigger__ entries in dependsOn (migration path)', () => {
    const dag: CanvasDefinition = {
      steps: [
        {
          id: 'a',
          name: 'Ask',
          actionType: 'ask_ai',
          params: {},
          dependsOn: [TRIGGER_NODE_ID],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'b',
          name: 'Notify',
          actionType: 'send_notification',
          params: {},
          dependsOn: [TRIGGER_NODE_ID, 'a'],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };

    const { nodes } = dagToFlow(dag);
    const dataA = (nodes.find((n) => n.id === 'a')!.data as RoutineStepData);
    const dataB = (nodes.find((n) => n.id === 'b')!.data as RoutineStepData);
    expect(dataA.dependsOn).toEqual([]);
    expect(dataB.dependsOn).toEqual(['a']);
  });
});

// ── Round-trip: dagToFlow → flowToDag is idempotent ────────────

describe('round-trip (dagToFlow → flowToDag)', () => {
  it('preserves a DAG with parallel roots under a trigger', () => {
    const original: CanvasDefinition = {
      steps: [
        {
          id: 'a',
          name: 'A',
          actionType: 'ask_ai',
          params: { prompt: 'hi' },
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'b',
          name: 'B',
          actionType: 'send_notification',
          params: { title: 'done' },
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };

    const flow = dagToFlow(original);
    const roundTripped = flowToDag(
      flow.nodes,
      flow.edges,
      flow.triggerNode,
      flow.annotationNodes,
    );

    // Steps survive with the same dependsOn shape (no __trigger__ leaks)
    const byId = new Map(roundTripped.steps.map((s) => [s.id, s]));
    expect(byId.get('a')!.dependsOn).toEqual([]);
    expect(byId.get('b')!.dependsOn).toEqual([]);
    expect(roundTripped.trigger?.triggerType).toBe('trigger_manual');
  });

  it('preserves deeper chains with interior dependencies', () => {
    const original: CanvasDefinition = {
      steps: [
        {
          id: 'root',
          name: 'Root',
          actionType: 'ask_ai',
          params: {},
          dependsOn: [],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'mid',
          name: 'Mid',
          actionType: 'summarize',
          params: {},
          dependsOn: ['root'],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
        {
          id: 'leaf',
          name: 'Leaf',
          actionType: 'send_notification',
          params: {},
          dependsOn: ['mid'],
          inputMappings: [],
          requiresApproval: false,
          onError: 'fail',
        },
      ],
      trigger: { triggerType: 'trigger_manual', config: {} },
    };

    const flow = dagToFlow(original);
    const roundTripped = flowToDag(
      flow.nodes,
      flow.edges,
      flow.triggerNode,
      flow.annotationNodes,
    );
    const byId = new Map(roundTripped.steps.map((s) => [s.id, s]));
    expect(byId.get('root')!.dependsOn).toEqual([]);
    expect(byId.get('mid')!.dependsOn).toEqual(['root']);
    expect(byId.get('leaf')!.dependsOn).toEqual(['mid']);
  });
});
