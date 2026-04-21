/**
 * DAG ↔ ReactFlow conversion utilities.
 *
 * dagToFlow: Parses a CanvasDefinition into ReactFlow nodes/edges with dagre auto-layout.
 * flowToDag: Reconstructs a CanvasDefinition from ReactFlow nodes/edges.
 *
 * Backward-compatible: old { steps: [...] } format works transparently.
 * See docs/tech-designs/actions.md for serialization format.
 */

import dagre from '@dagrejs/dagre';
import { MarkerType, type Node, type Edge } from '@xyflow/react';
import type { DAGDefinition, StepDefinition } from '../engine/dag/types';
import { resolveActionType } from './step-defaults';
import { getEdgeColor } from './handle-types';

// ── Constants ─────────────────────────────────────────────────

/** Reserved id for the visual trigger node. Not a step — its payload lives in CanvasDefinition.trigger. */
export const TRIGGER_NODE_ID = '__trigger__';

// ── Types ─────────────────────────────────────────────────────

export interface RoutineStepData extends Record<string, unknown> {
  stepId: string;
  name: string;
  actionType: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  inputMappings: StepDefinition['inputMappings'];
  requiresApproval: boolean;
  onError: 'fail' | 'skip' | 'retry';
  maxRetries?: number;
  timeoutMs?: number;
}

export interface TriggerNodeData {
  triggerType: string;   // trigger_schedule | trigger_manual | trigger_webhook
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface AnnotationNodeData {
  id: string;
  text: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
}

/** Extended DAG format with optional trigger, annotations, and viewport. */
export interface CanvasDefinition extends DAGDefinition {
  trigger?: TriggerNodeData;
  annotations?: AnnotationNodeData[];
  canvasViewport?: { x: number; y: number; zoom: number };
}

// ── Layout constants ──────────────────────────────────────────

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;
const TRIGGER_NODE_WIDTH = 260;
const TRIGGER_NODE_HEIGHT = 90;
const NODESEP = 60;
const RANKSEP = 80;

// ── Auto-layout ───────────────────────────────────────────────

export function autoLayoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: NODESEP, ranksep: RANKSEP });

  for (const node of nodes) {
    const isTrigger = node.type === 'triggerNode';
    const w = isTrigger ? TRIGGER_NODE_WIDTH : NODE_WIDTH;
    const h = isTrigger ? TRIGGER_NODE_HEIGHT : NODE_HEIGHT;
    g.setNode(node.id, { width: w, height: h });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    const isTrigger = node.type === 'triggerNode';
    const w = isTrigger ? TRIGGER_NODE_WIDTH : NODE_WIDTH;
    const h = isTrigger ? TRIGGER_NODE_HEIGHT : NODE_HEIGHT;
    return {
      ...node,
      position: {
        x: pos.x - w / 2,
        y: pos.y - h / 2,
      },
    };
  });
}

// ── Edge styling ──────────────────────────────────────────────

function makeEdgeStyle(sourceActionType: string): Pick<Edge, 'style' | 'markerEnd'> {
  const color = getEdgeColor(sourceActionType);
  return {
    style: { stroke: color, strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color },
  };
}

// ── DAG → ReactFlow ───────────────────────────────────────────

export function dagToFlow(dag: CanvasDefinition): {
  nodes: Node[];
  edges: Edge[];
  triggerNode: Node | null;
  annotationNodes: Node[];
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Action type lookup for edge coloring
  const actionTypeMap = new Map<string, string>();

  // Step nodes (with action type migration)
  if (dag.steps && dag.steps.length > 0) {
    // Migration: drop any dependsOn / inputMappings entries that don't
    // reference a real step (e.g. legacy blobs that serialized the trigger
    // node id, or mappings left dangling after a step was deleted). The
    // next autosave will persist the cleaned form. Without this, the
    // engine validator rejects the DAG at run time.
    const stepIds = new Set(dag.steps.map((s) => s.id));
    for (const step of dag.steps) {
      step.dependsOn = step.dependsOn.filter((id) => stepIds.has(id));
      step.inputMappings = (step.inputMappings ?? []).filter((m) =>
        stepIds.has(m.sourceStepId),
      );
    }

    for (const step of dag.steps) {
      const resolved = resolveActionType(step.actionType);
      actionTypeMap.set(step.id, resolved);

      nodes.push({
        id: step.id,
        type: 'routineStep',
        position: { x: 0, y: 0 },
        data: {
          stepId: step.id,
          name: step.name,
          actionType: resolved,
          params: step.params,
          dependsOn: step.dependsOn,
          inputMappings: step.inputMappings,
          requiresApproval: step.requiresApproval,
          onError: step.onError,
          maxRetries: step.maxRetries,
          timeoutMs: step.timeoutMs,
        } as RoutineStepData,
      });
    }

    for (const step of dag.steps) {
      for (const depId of step.dependsOn) {
        const sourceType = actionTypeMap.get(depId) ?? 'signal';
        edges.push({
          id: `e-${depId}-${step.id}`,
          source: depId,
          target: step.id,
          type: 'smoothstep',
          ...makeEdgeStyle(sourceType),
        });
      }
    }

    // Auto-render trigger → root-step edges so the canvas reflects DAG
    // semantics ("the trigger fires every root step"). Derivation is
    // deterministic, so save → load → save is idempotent.
    if (dag.trigger) {
      for (const step of dag.steps) {
        if (step.dependsOn.length === 0) {
          edges.push({
            id: `e-${TRIGGER_NODE_ID}-${step.id}`,
            source: TRIGGER_NODE_ID,
            target: step.id,
            type: 'smoothstep',
            ...makeEdgeStyle('trigger'),
          });
        }
      }
    }
  }

  // Trigger node
  let triggerNode: Node | null = null;
  if (dag.trigger) {
    triggerNode = {
      id: TRIGGER_NODE_ID,
      type: 'triggerNode',
      position: dag.trigger.position ?? { x: 0, y: 0 },
      data: {
        triggerType: dag.trigger.triggerType,
        config: dag.trigger.config,
      },
      deletable: false,
    };
  }

  // Annotation nodes (sticky notes)
  const annotationNodes: Node[] = (dag.annotations ?? []).map((ann) => ({
    id: ann.id,
    type: 'stickyNote',
    position: ann.position,
    data: {
      text: ann.text,
      width: ann.width ?? 200,
      height: ann.height ?? 120,
    },
  }));

  // Auto-layout step nodes + trigger node (annotations keep their positions)
  const layoutNodes = autoLayoutNodes(
    triggerNode ? [triggerNode, ...nodes] : nodes,
    edges,
  );

  return {
    nodes: layoutNodes.filter((n) => n.type !== 'triggerNode'),
    edges,
    triggerNode: layoutNodes.find((n) => n.type === 'triggerNode') ?? triggerNode,
    annotationNodes,
  };
}

// ── ReactFlow → DAG ───────────────────────────────────────────

export function flowToDag(
  nodes: Node[],
  edges: Edge[],
  triggerNode?: Node | null,
  annotationNodes?: Node[],
): CanvasDefinition {
  // Only serialize step nodes (filter out trigger/annotation/other types)
  const stepNodes = nodes.filter((n) => n.type === 'routineStep');
  const stepNodeIds = new Set(stepNodes.map((n) => n.id));

  // Only step→step edges contribute to dependsOn / branch handles. Edges
  // sourced at the trigger (or any future meta-node) are visual-only and must
  // not leak into the DAG — the trigger's relationship is encoded in
  // CanvasDefinition.trigger + each step's empty dependsOn (root == triggered).
  const stepEdges = edges.filter(
    (e) => stepNodeIds.has(e.source) && stepNodeIds.has(e.target),
  );

  // Build a map of target node → list of source node ids
  const incomingMap = new Map<string, string[]>();
  for (const edge of stepEdges) {
    const deps = incomingMap.get(edge.target) ?? [];
    deps.push(edge.source);
    incomingMap.set(edge.target, deps);
  }

  // Build a map of edge sourceHandle per source→target pair for branch conditions
  const edgeHandleMap = new Map<string, string | undefined>();
  const nodeTypeMap = new Map<string, string>();
  for (const node of stepNodes) {
    const d = node.data as RoutineStepData;
    nodeTypeMap.set(node.id, d.actionType);
  }
  for (const edge of stepEdges) {
    edgeHandleMap.set(`${edge.source}->${edge.target}`, edge.sourceHandle ?? undefined);
  }

  const steps: StepDefinition[] = stepNodes.map((node) => {
    const d = node.data as RoutineStepData;

    // Build input mappings, adding branchCondition for edges from condition nodes
    const inputMappings = (d.inputMappings ?? []).map((m) => {
      const sourceType = nodeTypeMap.get(m.sourceStepId);
      if (sourceType === 'condition') {
        const handleId = edgeHandleMap.get(`${m.sourceStepId}->${node.id}`);
        if (handleId === 'true' || handleId === 'false') {
          return { ...m, branchCondition: handleId as 'true' | 'false' };
        }
      }
      return m;
    });

    return {
      id: d.stepId,
      name: d.name,
      actionType: d.actionType,
      params: d.params,
      dependsOn: incomingMap.get(node.id) ?? [],
      inputMappings,
      requiresApproval: d.requiresApproval ?? false,
      onError: d.onError ?? 'fail',
      maxRetries: d.maxRetries,
      timeoutMs: d.timeoutMs,
    };
  });

  const result: CanvasDefinition = { steps };

  // Serialize trigger
  if (triggerNode) {
    const td = triggerNode.data as { triggerType: string; config: Record<string, unknown> };
    result.trigger = {
      triggerType: td.triggerType,
      config: td.config ?? {},
      position: triggerNode.position,
    };
  }

  // Serialize annotations
  if (annotationNodes && annotationNodes.length > 0) {
    result.annotations = annotationNodes.map((n) => ({
      id: n.id,
      text: (n.data as { text: string }).text ?? '',
      position: n.position,
      width: (n.data as { width?: number }).width,
      height: (n.data as { height?: number }).height,
    }));
  }

  return result;
}
