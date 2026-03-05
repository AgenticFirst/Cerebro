/**
 * Canvas state management hook for the Routine Editor.
 *
 * Encapsulates ReactFlow nodes/edges state, serialization to/from DAGDefinition,
 * node CRUD, connection handling with cycle detection, and save/dirty tracking.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
} from '@xyflow/react';
import type { Routine } from '../types/routines';
import type { DAGDefinition } from '../engine/dag/types';
import type { RoutineStepData } from '../utils/dag-flow-mapping';
import { dagToFlow, flowToDag, autoLayoutNodes } from '../utils/dag-flow-mapping';
import { getDefaultStepData } from '../utils/step-defaults';
import { useRoutines } from '../context/RoutineContext';

// ── Cycle detection (BFS from target to see if it reaches source) ──

function wouldCreateCycle(
  edges: Edge[],
  source: string,
  target: string,
): boolean {
  // Check if there's already a path from target to source (which would form a cycle)
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

// ── Hook ──────────────────────────────────────────────────────

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export function useRoutineCanvas(routine: Routine) {
  const { updateRoutine } = useRoutines();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const initializedRef = useRef(false);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const savedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize from routine.dagJson on first load or routine change
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (routine.dagJson) {
      try {
        const dag: DAGDefinition = JSON.parse(routine.dagJson);
        const { nodes: flowNodes, edges: flowEdges } = dagToFlow(dag);
        setNodes(flowNodes);
        setEdges(flowEdges);
      } catch {
        // Invalid JSON — start with empty canvas
        setNodes([]);
        setEdges([]);
      }
    }
  }, [routine.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Add node ──

  const addNode = useCallback(
    (actionType: string, position: { x: number; y: number }) => {
      const id = crypto.randomUUID();
      const defaults = getDefaultStepData(actionType);
      const newNode: Node = {
        id,
        type: 'routineStep',
        position,
        data: {
          stepId: id,
          name: `New ${actionType.replace('_', ' ')}`,
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
      setNodes((prev) => prev.filter((n) => n.id !== nodeId));
      setEdges((prev) =>
        prev.filter((e) => e.source !== nodeId && e.target !== nodeId),
      );
      if (selectedNodeId === nodeId) setSelectedNodeId(null);
      setIsDirty(true);
    },
    [setNodes, setEdges, selectedNodeId],
  );

  // ── Update node data ──

  const updateNodeData = useCallback(
    (nodeId: string, partial: Partial<RoutineStepData>) => {
      setNodes((prev) =>
        prev.map((node) =>
          node.id === nodeId
            ? { ...node, data: { ...node.data, ...partial } }
            : node,
        ),
      );
      setIsDirty(true);
    },
    [setNodes],
  );

  // ── Connect edges with cycle detection ──

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;

      // Check for duplicate edge
      const exists = edges.some(
        (e) => e.source === connection.source && e.target === connection.target,
      );
      if (exists) return;

      // Cycle detection
      if (wouldCreateCycle(edges, connection.source, connection.target)) return;

      setEdges((prev) =>
        addEdge(
          {
            ...connection,
            type: 'smoothstep',
            markerEnd: { type: MarkerType.ArrowClosed, color: '#06b6d4' },
            style: { stroke: '#06b6d4', strokeWidth: 1.5 },
          },
          prev,
        ),
      );
      setIsDirty(true);
    },
    [edges, setEdges],
  );

  // ── Delete selected elements ──

  const deleteSelected = useCallback(() => {
    // Collect selected node IDs first
    const selectedNodeIds = new Set(
      nodes.filter((n) => n.selected).map((n) => n.id),
    );

    const hasSelectedNodes = selectedNodeIds.size > 0;
    const hasSelectedEdges = edges.some((e) => e.selected);

    if (!hasSelectedNodes && !hasSelectedEdges) return;

    if (hasSelectedNodes) {
      setNodes((prev) => prev.filter((n) => !n.selected));
      if (selectedNodeId && selectedNodeIds.has(selectedNodeId)) {
        setSelectedNodeId(null);
      }
    }

    // Remove edges connected to deleted nodes AND any selected edges
    setEdges((prev) =>
      prev.filter(
        (e) =>
          !selectedNodeIds.has(e.source) &&
          !selectedNodeIds.has(e.target) &&
          !e.selected,
      ),
    );

    setIsDirty(true);
  }, [nodes, edges, setNodes, setEdges, selectedNodeId]);

  // ── Auto-layout ──

  const runAutoLayout = useCallback(() => {
    setNodes((prev) => {
      const laid = autoLayoutNodes(prev, edges);
      return laid;
    });
    setIsDirty(true);
  }, [setNodes, edges]);

  // ── Autosave effect ──

  useEffect(() => {
    if (!isDirty || isSavingRef.current) return;

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);

    autosaveTimerRef.current = setTimeout(async () => {
      isSavingRef.current = true;
      setSaveStatus('saving');
      try {
        const dag = flowToDag(nodes, edges);
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
  }, [nodes, edges, isDirty, routine.id, updateRoutine]);

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
      const dag = flowToDag(nodes, edges);
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
  }, [nodes, edges, routine.id, updateRoutine]);

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    selectedNodeId,
    setSelectedNodeId,
    addNode,
    deleteNode,
    updateNodeData,
    deleteSelected,
    runAutoLayout,
    saveToBackend,
    isDirty,
    saveStatus,
  };
}
