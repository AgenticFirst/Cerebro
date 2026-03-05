import { useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  BackgroundVariant,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Routine } from '../../../types/routines';
import { useRoutineCanvas } from '../../../hooks/useRoutineCanvas';
import RoutineStepNode from './RoutineStepNode';
import EditorToolbar from './EditorToolbar';
import NodePalette from './NodePalette';
import StepConfigPanel from './StepConfigPanel';

// Defined outside component to prevent re-renders
const nodeTypes: NodeTypes = {
  routineStep: RoutineStepNode,
};

// ── Inner canvas (needs ReactFlowProvider above it) ──────────

function CanvasInner({ routine }: { routine: Routine }) {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    selectedNodeId,
    setSelectedNodeId,
    addNode,
    updateNodeData,
    deleteSelected,
    runAutoLayout,
    saveToBackend,
    isDirty,
    saveStatus,
  } = useRoutineCanvas(routine);

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  // ── Drag-and-drop from palette ──

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const actionType = e.dataTransfer.getData('application/cerebro-action-type');
      if (!actionType) return;

      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const id = addNode(actionType, position);
      setSelectedNodeId(id);
    },
    [screenToFlowPosition, addNode, setSelectedNodeId],
  );

  // ── Keyboard shortcuts ──

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Delete/Backspace — remove selected nodes/edges (unless typing in an input)
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')
      ) {
        deleteSelected();
      }

      // Ctrl/Cmd + S — save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveToBackend();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected, saveToBackend]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <EditorToolbar
        routine={routine}
        isDirty={isDirty}
        hasNodes={nodes.length > 0}
        saveStatus={saveStatus}
        onSave={saveToBackend}
        onAutoLayout={runAutoLayout}
      />

      <div className="relative flex-1 min-h-0" ref={wrapperRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          onDragOver={onDragOver}
          onDrop={onDrop}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          deleteKeyCode={null} // We handle delete ourselves
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            style={{ width: 140, height: 90 }}
          />
        </ReactFlow>

        {/* Empty state overlay */}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-sm text-text-tertiary mb-1">
                Drag an action from the palette to get started
              </p>
              <p className="text-xs text-text-tertiary/60">
                or click the + button in the bottom-left corner
              </p>
            </div>
          </div>
        )}

        <NodePalette />

        {selectedNode && (
          <StepConfigPanel
            node={selectedNode}
            onUpdate={updateNodeData}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

// ── Outer wrapper (provides ReactFlowProvider) ───────────────

interface RoutineEditorProps {
  routine: Routine;
}

export default function RoutineEditor({ routine }: RoutineEditorProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner routine={routine} />
    </ReactFlowProvider>
  );
}
