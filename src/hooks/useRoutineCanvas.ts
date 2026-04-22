/**
 * Canvas state management hook for the Routine Editor.
 *
 * Encapsulates ReactFlow nodes/edges state, serialization to/from CanvasDefinition,
 * node CRUD, trigger/annotation management, connection handling with cycle detection,
 * and save/dirty tracking.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  useNodesState,
  useEdgesState,
  addEdge,
  applyNodeChanges,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import type { Routine } from '../types/routines';
import type { RoutineStepData, CanvasDefinition } from '../utils/dag-flow-mapping';
import { dagToFlow, flowToDag, autoLayoutNodes, TRIGGER_NODE_ID } from '../utils/dag-flow-mapping';
import { getDefaultStepData, ACTION_META, resolveActionType } from '../utils/step-defaults';
import { getEdgeColor } from '../utils/handle-types';
import {
  computeAutoWireMapping,
  sanitizeVarName,
  uniqueVarName,
} from '../utils/action-outputs';
import { useRoutines } from '../context/RoutineContext';

// ── Cycle detection (BFS from target to see if it reaches source) ──

function wouldCreateCycle(
  edges: Edge[],
  source: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const neighbors = adjacency.get(edge.source) ?? [];
    neighbors.push(edge.target);
    adjacency.set(edge.source, neighbors);
  }

  const visited = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      queue.push(neighbor);
    }
  }
  return false;
}

// ── Edge styling ──────────────────────────────────────────────

function makeEdgeProps(sourceActionType: string) {
  const color = getEdgeColor(sourceActionType);
  return {
    type: 'smoothstep' as const,
    style: { stroke: color, strokeWidth: 1.5 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color,
    },
  };
}

/** Look up the action type for a node by ID. */
function getNodeActionType(nodes: Node[], nodeId: string): string {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return 'signal';
  if (node.type === 'triggerNode') return 'trigger';
  const d = node.data as RoutineStepData;
  return resolveActionType(d?.actionType ?? 'signal');
}

/**
 * Drop any inputMapping on a target that referenced a source across every
 * (source, target) pair in `removed`. Skips node re-creation when the mapping
 * list would be unchanged so React doesn't see spurious reference changes.
 */
function stripMappingsForRemovedEdges(
  nodes: Node[],
  removed: { source: string; target: string }[],
): Node[] {
  if (removed.length === 0) return nodes;
  const byTarget = new Map<string, Set<string>>();
  for (const { source, target } of removed) {
    const set = byTarget.get(target) ?? new Set<string>();
    set.add(source);
    byTarget.set(target, set);
  }
  return nodes.map((n) => {
    const sources = byTarget.get(n.id);
    if (!sources) return n;
    const d = n.data as RoutineStepData;
    const existing = d.inputMappings ?? [];
    const filtered = existing.filter((m) => !sources.has(m.sourceStepId));
    if (filtered.length === existing.length) return n;
    return { ...n, data: { ...d, inputMappings: filtered } };
  });
}

// ── Map routine trigger_type to canvas trigger action type ──

export function routineTriggerToActionType(triggerType: string): string {
  switch (triggerType) {
    case 'cron': return 'trigger_schedule';
    case 'webhook': return 'trigger_webhook';
    case 'telegram_message': return 'trigger_telegram_message';
    default: return 'trigger_manual';
  }
}

// ── Pure trigger-node reconciliation (exported for tests) ──

/**
 * Given the previous canvas trigger node (or null) and the current routine
 * state, return the trigger node that should be rendered.
 *
 * Returns `prev` unchanged when already in sync, so callers can short-circuit
 * state updates and avoid marking the canvas dirty unnecessarily.
 *
 * Behavior:
 *   - Preserves the trigger node's position across type switches.
 *   - On a real type switch, resets config (so stale webhook paths / cron
 *     values don't leak across types) — seeding cron_expression if the routine
 *     has one.
 *   - Within the same type, preserves prev config but keeps cron_expression in
 *     sync with the routine when the new type is schedule.
 */
export function reconcileTriggerNode(
  prev: Node | null,
  routine: Pick<Routine, 'triggerType' | 'cronExpression'>,
): Node {
  const desiredType = routineTriggerToActionType(routine.triggerType);
  const basePosition = prev?.position ?? { x: 0, y: -120 };
  const prevData = (prev?.data ?? {}) as {
    triggerType?: string;
    config?: Record<string, unknown>;
  };
  const typeChanged = prevData.triggerType !== desiredType;

  const nextConfig: Record<string, unknown> = typeChanged
    ? routine.cronExpression
      ? { cron_expression: routine.cronExpression }
      : {}
    : {
        ...(prevData.config ?? {}),
        ...(desiredType === 'trigger_schedule'
          ? { cron_expression: routine.cronExpression ?? '' }
          : {}),
      };

  const sameType = prevData.triggerType === desiredType;
  const sameConfig =
    JSON.stringify(prevData.config ?? {}) === JSON.stringify(nextConfig);
  if (prev && sameType && sameConfig) return prev;

  return {
    id: TRIGGER_NODE_ID,
    type: 'triggerNode',
    position: basePosition,
    data: { triggerType: desiredType, config: nextConfig },
    deletable: false,
  };
}

// ── Hook ──────────────────────────────────────────────────────

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function useRoutineCanvas(routine: Routine) {
  const { updateRoutine } = useRoutines();
  const [nodes, setNodes, baseOnNodesChange] = useNodesState([]);
  const [edges, setEdges, baseOnEdgesChange] = useEdgesState([]);
  const [triggerNode, setTriggerNode] = useState<Node | null>(null);
  const [annotationNodes, setAnnotationNodes] = useState<Node[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const initializedRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const savedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize from routine.dagJson on first load
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    let foundTrigger = false;

    if (routine.dagJson) {
      try {
        const dag: CanvasDefinition = JSON.parse(routine.dagJson);
        const result = dagToFlow(dag);
        setNodes(result.nodes);
        setEdges(result.edges);
        if (result.triggerNode) {
          setTriggerNode(result.triggerNode);
          foundTrigger = true;
        }
        if (result.annotationNodes.length > 0) setAnnotationNodes(result.annotationNodes);
      } catch {
        setNodes([]);
        setEdges([]);
      }
    }

    // Auto-create trigger node from routine's trigger_type if none in DAG
    if (!foundTrigger) {
      const tt = routineTriggerToActionType(routine.triggerType);
      setTriggerNode({
        id: TRIGGER_NODE_ID,
        type: 'triggerNode',
        position: { x: 0, y: -120 },
        data: {
          triggerType: tt,
          config: routine.cronExpression
            ? { cron_expression: routine.cronExpression }
            : {},
        },
        deletable: false,
      });
    }
  }, [routine.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile trigger node when routine.trigger_type / cron_expression changes
  // (e.g. user switches the trigger pill in EditorToolbar). Runs only after
  // initialization so it doesn't fight the DAG-restore path.
  useEffect(() => {
    if (!initializedRef.current) return;
    let changed = false;
    setTriggerNode((prev) => {
      const next = reconcileTriggerNode(prev, routine);
      if (next === prev) return prev;
      changed = true;
      return next;
    });
    if (changed) setIsDirty(true);
  }, [routine.triggerType, routine.cronExpression]); // eslint-disable-line react-hooks/exhaustive-deps

  // Combine all node types for ReactFlow rendering
  const allNodes = useMemo(() => {
    const result: Node[] = [];
    if (triggerNode) result.push(triggerNode);
    result.push(...nodes);
    result.push(...annotationNodes);
    return result;
  }, [triggerNode, nodes, annotationNodes]);

  // ReactFlow emits one onNodesChange stream for every rendered node, but our
  // state lives in three slices. Route each change to the right setter so that
  // drags, selection toggles, and dimension updates land on stickies and the
  // trigger — not just step nodes.
  const annotationIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    annotationIdsRef.current = new Set(annotationNodes.map((n) => n.id));
  }, [annotationNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const stepChanges: NodeChange[] = [];
      const annotationChanges: NodeChange[] = [];
      const triggerChanges: NodeChange[] = [];

      for (const ch of changes) {
        const id = 'id' in ch ? ch.id : undefined;
        if (id === TRIGGER_NODE_ID) triggerChanges.push(ch);
        else if (id && annotationIdsRef.current.has(id)) annotationChanges.push(ch);
        else stepChanges.push(ch);
      }

      if (stepChanges.length) baseOnNodesChange(stepChanges);
      if (annotationChanges.length) {
        setAnnotationNodes((curr) => applyNodeChanges(annotationChanges, curr));
      }
      if (triggerChanges.length) {
        setTriggerNode((curr) => {
          if (!curr) return curr;
          const [next] = applyNodeChanges(triggerChanges, [curr]);
          return next ?? curr;
        });
      }
    },
    [baseOnNodesChange],
  );

  // ── Add step node ──

  const addNode = useCallback(
    (actionType: string, position: { x: number; y: number }) => {
      const id = crypto.randomUUID();
      const defaults = getDefaultStepData(actionType);
      const meta = ACTION_META[actionType];
      const name = meta ? `New ${meta.name}` : `New ${actionType.replace(/_/g, ' ')}`;

      const newNode: Node = {
        id,
        type: 'routineStep',
        position,
        data: {
          stepId: id,
          name,
          actionType,
          params: defaults.params,
          dependsOn: [],
          inputMappings: [],
          requiresApproval: defaults.requiresApproval,
          onError: defaults.onError,
        } as RoutineStepData,
      };
      setNodes((prev) => [...prev, newNode]);
      setIsDirty(true);
      return id;
    },
    [setNodes],
  );

  // ── Delete node ──

  const deleteNode = useCallback(
    (nodeId: string) => {
      // Don't allow deleting trigger node
      if (nodeId === TRIGGER_NODE_ID) return;

      // Check if it's an annotation
      const isAnnotation = annotationNodes.some((n) => n.id === nodeId);
      if (isAnnotation) {
        setAnnotationNodes((prev) => prev.filter((n) => n.id !== nodeId));
      } else {
        const removedPairs = edges
          .filter((e) => e.source === nodeId || e.target === nodeId)
          .map((e) => ({ source: e.source, target: e.target }));
        setNodes((prev) => {
          const without = prev.filter((n) => n.id !== nodeId);
          return stripMappingsForRemovedEdges(without, removedPairs);
        });
        setEdges((prev) =>
          prev.filter((e) => e.source !== nodeId && e.target !== nodeId),
        );
      }

      if (selectedNodeId === nodeId) setSelectedNodeId(null);
      setIsDirty(true);
    },
    [setNodes, setEdges, edges, selectedNodeId, annotationNodes],
  );

  // ── Update node data ──

  const updateNodeData = useCallback(
    (nodeId: string, partial: Record<string, unknown>) => {
      // Trigger node
      if (nodeId === TRIGGER_NODE_ID) {
        setTriggerNode((prev) => {
          if (!prev) return prev;
          return { ...prev, data: { ...prev.data, ...partial } };
        });
        setIsDirty(true);
        return;
      }

      // Annotation node
      const isAnnotation = annotationNodes.some((n) => n.id === nodeId);
      if (isAnnotation) {
        setAnnotationNodes((prev) =>
          prev.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, ...partial } } : n,
          ),
        );
        setIsDirty(true);
        return;
      }

      // Step node — apply the patch, then cascade if the name changed so
      // downstream mappings and template refs stay in sync.
      setNodes((prev) => {
        const current = prev.find((n) => n.id === nodeId);
        if (!current) return prev;
        const currentData = current.data as RoutineStepData;

        const nameIsChanging =
          typeof partial.name === 'string' && partial.name !== currentData.name;
        const oldVar = nameIsChanging ? sanitizeVarName(currentData.name) : '';
        const newVarBase = nameIsChanging
          ? sanitizeVarName(partial.name as string)
          : '';

        // Fast path: nothing to cascade — only the renamed/patched node changes.
        if (!nameIsChanging || !oldVar) {
          return prev.map((node) =>
            node.id === nodeId
              ? { ...node, data: { ...node.data, ...partial } }
              : node,
          );
        }

        const oldTemplate = new RegExp(`\\{\\{\\s*${oldVar}\\s*\\}\\}`, 'g');
        return prev.map((node) => {
          if (node.id === nodeId) {
            return { ...node, data: { ...node.data, ...partial } };
          }
          const d = node.data as RoutineStepData;
          const mappings = d.inputMappings ?? [];
          const affected = mappings.some(
            (m) => m.sourceStepId === nodeId && m.targetField === oldVar,
          );
          if (!affected) return node;

          // Collision-safe new name against mappings that won't be rewritten.
          const keptMappings = mappings.filter(
            (m) => !(m.sourceStepId === nodeId && m.targetField === oldVar),
          );
          const newVar = uniqueVarName(newVarBase, keptMappings, nodeId);

          const rewrittenMappings = mappings.map((m) =>
            m.sourceStepId === nodeId && m.targetField === oldVar
              ? { ...m, targetField: newVar }
              : m,
          );

          // Rewrite {{oldVar}} → {{newVar}} inside string params. A single
          // regex instance is reused (lastIndex is reset between calls because
          // .test + .replace share the global flag).
          oldTemplate.lastIndex = 0;
          const rewrittenParams: Record<string, unknown> = {};
          let paramsChanged = false;
          for (const [k, v] of Object.entries(d.params ?? {})) {
            if (typeof v === 'string') {
              oldTemplate.lastIndex = 0;
              if (oldTemplate.test(v)) {
                rewrittenParams[k] = v.replace(oldTemplate, `{{${newVar}}}`);
                paramsChanged = true;
                continue;
              }
            }
            rewrittenParams[k] = v;
          }

          return {
            ...node,
            data: {
              ...d,
              inputMappings: rewrittenMappings,
              params: paramsChanged ? rewrittenParams : d.params,
            },
          };
        });
      });
      setIsDirty(true);
    },
    [setNodes, annotationNodes],
  );

  // ── Add sticky note ──

  const addStickyNote = useCallback(
    (position: { x: number; y: number }) => {
      const id = `note-${crypto.randomUUID()}`;
      const note: Node = {
        id,
        type: 'stickyNote',
        position,
        data: { text: '', width: 200, height: 120 },
      };
      setAnnotationNodes((prev) => [...prev, note]);
      setIsDirty(true);
      return id;
    },
    [],
  );

  // ── Connect edges with cycle detection ──

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      // Get source action type for edge coloring (node data is stable during connection)
      const sourceType = getNodeActionType(allNodes, connection.source);
      const edgeProps = makeEdgeProps(sourceType);

      let edgeAdded = false;
      setEdges((prev) => {
        const exists = prev.some(
          (e) => e.source === connection.source && e.target === connection.target,
        );
        if (exists) return prev;
        if (wouldCreateCycle(prev, connection.source!, connection.target!)) return prev;
        edgeAdded = true;
        return addEdge({ ...connection, ...edgeProps }, prev);
      });

      if (edgeAdded) {
        // Auto-wire the source's primary output so {{stepName}} resolves at
        // runtime. Triggers, terminal actions, and duplicates return null from
        // computeAutoWireMapping — in those cases we leave the target untouched
        // (the edge still encodes run order).
        const sourceNode = allNodes.find((n) => n.id === connection.source);
        const targetNode = allNodes.find((n) => n.id === connection.target);
        if (
          sourceNode &&
          targetNode &&
          sourceNode.type === 'routineStep' &&
          targetNode.type === 'routineStep'
        ) {
          const sourceData = sourceNode.data as RoutineStepData;
          setNodes((prev) =>
            prev.map((n) => {
              if (n.id !== connection.target) return n;
              const d = n.data as RoutineStepData;
              const mapping = computeAutoWireMapping(
                {
                  id: sourceNode.id,
                  name: sourceData.name,
                  actionType: resolveActionType(sourceData.actionType),
                },
                d.inputMappings,
              );
              if (!mapping) return n;
              return {
                ...n,
                data: { ...d, inputMappings: [...(d.inputMappings ?? []), mapping] },
              };
            }),
          );
        }
      }

      setIsDirty(true);
    },
    [setEdges, setNodes, allNodes],
  );

  // ── Edge changes (wraps ReactFlow's base handler to clean up mappings) ──

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed: { source: string; target: string }[] = [];
      for (const ch of changes) {
        if (ch.type === 'remove') {
          const edge = edges.find((e) => e.id === ch.id);
          if (edge) removed.push({ source: edge.source, target: edge.target });
        }
      }
      baseOnEdgesChange(changes);
      if (removed.length > 0) {
        setNodes((prev) => stripMappingsForRemovedEdges(prev, removed));
      }
    },
    [baseOnEdgesChange, edges, setNodes],
  );

  // ── Delete selected elements ──

  const deleteSelected = useCallback(() => {
    const selectedNodeIds = new Set(
      allNodes.filter((n) => n.selected && n.id !== TRIGGER_NODE_ID).map((n) => n.id),
    );

    const hasSelectedNodes = selectedNodeIds.size > 0;
    const hasSelectedEdges = edges.some((e) => e.selected);

    if (!hasSelectedNodes && !hasSelectedEdges) return;

    // Skip mappings on targets that are being deleted — they're going away anyway.
    const removedPairs = edges
      .filter(
        (e) =>
          (selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target) || e.selected) &&
          !selectedNodeIds.has(e.target),
      )
      .map((e) => ({ source: e.source, target: e.target }));

    if (hasSelectedNodes) {
      setNodes((prev) => {
        const kept = prev.filter((n) => !selectedNodeIds.has(n.id));
        return stripMappingsForRemovedEdges(kept, removedPairs);
      });
      setAnnotationNodes((prev) => prev.filter((n) => !selectedNodeIds.has(n.id)));
      if (selectedNodeId && selectedNodeIds.has(selectedNodeId)) {
        setSelectedNodeId(null);
      }
    } else if (removedPairs.length > 0) {
      setNodes((prev) => stripMappingsForRemovedEdges(prev, removedPairs));
    }

    setEdges((prev) =>
      prev.filter(
        (e) =>
          !selectedNodeIds.has(e.source) &&
          !selectedNodeIds.has(e.target) &&
          !e.selected,
      ),
    );

    setIsDirty(true);
  }, [allNodes, edges, setNodes, setEdges, selectedNodeId]);

  // ── Auto-layout ──

  const runAutoLayout = useCallback(() => {
    const stepAndTrigger = triggerNode ? [triggerNode, ...nodes] : [...nodes];
    const laid = autoLayoutNodes(stepAndTrigger, edges);

    const newTrigger = laid.find((n) => n.id === TRIGGER_NODE_ID);
    const newStepNodes = laid.filter((n) => n.id !== TRIGGER_NODE_ID);

    if (newTrigger) setTriggerNode(newTrigger);
    setNodes(newStepNodes);
    setIsDirty(true);
  }, [triggerNode, nodes, edges, setNodes]);

  // ── Serialize for save ──

  const serialize = useCallback(() => {
    return flowToDag(nodes, edges, triggerNode, annotationNodes);
  }, [nodes, edges, triggerNode, annotationNodes]);

  // ── Autosave effect ──

  useEffect(() => {
    if (!isDirty || isSavingRef.current) return;

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);

    autosaveTimerRef.current = setTimeout(async () => {
      isSavingRef.current = true;
      setSaveStatus('saving');
      try {
        const dag = serialize();
        await updateRoutine(routine.id, { dag_json: JSON.stringify(dag) });
        setIsDirty(false);
        setSaveStatus('saved');
        if (savedResetTimerRef.current) clearTimeout(savedResetTimerRef.current);
        savedResetTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (err) {
        console.error('[Autosave] Failed:', err);
        setSaveStatus('error');
      } finally {
        isSavingRef.current = false;
      }
    }, 1000);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [nodes, edges, triggerNode, annotationNodes, isDirty, routine.id, updateRoutine, serialize]);

  // Listen for sticky note text updates from StickyNoteNode
  useEffect(() => {
    const handler = (e: Event) => {
      const { id, text } = (e as CustomEvent).detail;
      setAnnotationNodes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, text } } : n,
        ),
      );
      setIsDirty(true);
    };
    window.addEventListener('stickyNoteUpdate', handler);
    return () => window.removeEventListener('stickyNoteUpdate', handler);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      if (savedResetTimerRef.current) clearTimeout(savedResetTimerRef.current);
    };
  }, []);

  // ── Save to backend (manual) ──

  const saveToBackend = useCallback(async () => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    isSavingRef.current = true;
    setSaveStatus('saving');
    try {
      const dag = serialize();
      const dagJson = JSON.stringify(dag);
      await updateRoutine(routine.id, { dag_json: dagJson });
      setIsDirty(false);
      setSaveStatus('saved');
      if (savedResetTimerRef.current) clearTimeout(savedResetTimerRef.current);
      savedResetTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('[Save] Failed:', err);
      setSaveStatus('error');
    } finally {
      isSavingRef.current = false;
    }
  }, [routine.id, updateRoutine, serialize]);

  return {
    nodes: allNodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    selectedNodeId,
    setSelectedNodeId,
    addNode,
    updateNodeData,
    addStickyNote,
    deleteSelected,
    runAutoLayout,
    saveToBackend,
    isDirty,
    saveStatus,
    triggerNode,
    annotationNodes,
  };
}
