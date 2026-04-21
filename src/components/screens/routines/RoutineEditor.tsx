import { useCallback, useRef, useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  BackgroundVariant,
  useReactFlow,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Routine } from '../../../types/routines';
import { useRoutineCanvas } from '../../../hooks/useRoutineCanvas';
import { isTriggerAction } from '../../../utils/step-defaults';
import RoutineStepNode from './RoutineStepNode';
import TriggerNode from './TriggerNode';
import StickyNoteNode from './StickyNoteNode';
import EditorToolbar from './EditorToolbar';
import ActionSidebar from './ActionSidebar';
import StepConfigPanel from './StepConfigPanel';
import TriggerConfigPanel from './TriggerConfigPanel';

// Defined outside component to prevent re-renders
const nodeTypes: NodeTypes = {
  routineStep: RoutineStepNode,
  triggerNode: TriggerNode,
  stickyNote: StickyNoteNode,
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
    addStickyNote,
    updateNodeData,
    deleteSelected,
    runAutoLayout,
    saveToBackend,
    isDirty,
    saveStatus,
  } = useRoutineCanvas(routine);

  const { screenToFlowPosition, getViewport } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // One-time fitView when ReactFlow initializes (fires once, no re-render subscription)
  const handleInit = useCallback((instance: ReactFlowInstance) => {
    // Small delay lets nodes finish measuring before fitting
    setTimeout(() => instance.fitView({ padding: 0.3 }), 50);
  }, []);

  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  const isTriggerSelected = selectedNode?.type === 'triggerNode';
  const isStepSelected = selectedNode?.type === 'routineStep';
  const stepNodes = nodes.filter((n) => n.type === 'routineStep');

  // Close sidebar when a node is selected, and vice versa
  const handleOpenSidebar = useCallback(() => {
    setSelectedNodeId(null);
    setSidebarOpen(true);
  }, [setSelectedNodeId]);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string }) => {
      setSidebarOpen(false);
      setSelectedNodeId(node.id);
    },
    [setSelectedNodeId],
  );

  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // ── Drag-and-drop from sidebar ──

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const actionType = e.dataTransfer.getData('application/cerebro-action-type');
      if (!actionType) return;
      if (isTriggerAction(actionType)) return;

      const position = screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });

      const id = addNode(actionType, position);
      setSelectedNodeId(id);
      setSidebarOpen(false);
    },
    [screenToFlowPosition, addNode, setSelectedNodeId],
  );

  // ── Keyboard shortcuts ──

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isTyping = (e.target as HTMLElement).closest(
        'input, textarea, select, [contenteditable]',
      );

      // Delete/Backspace — remove selected nodes/edges (unless typing)
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping) {
        deleteSelected();
      }

      // Ctrl/Cmd + S — save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveToBackend();
      }

      // A — toggle action sidebar (unless typing)
      if (e.key === 'a' && !isTyping && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }

      // Shift+N — add sticky note at viewport center (unless typing)
      if (e.key === 'N' && e.shiftKey && !isTyping && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const wrapper = wrapperRef.current;
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          const centerPos = screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
          addStickyNote(centerPos);
        } else {
          const vp = getViewport();
          addStickyNote({ x: -vp.x + 400, y: -vp.y + 300 });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelected, saveToBackend, addStickyNote, getViewport, screenToFlowPosition]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <EditorToolbar
        routine={routine}
        isDirty={isDirty}
        hasNodes={stepNodes.length > 0}
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
          onNodeClick={handleNodeClick}
          onPaneClick={handlePaneClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onInit={handleInit}
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            style={{ width: 140, height: 90 }}
          />
        </ReactFlow>

        {/* Empty state hint — sits at the bottom so it doesn't collide with the trigger node */}
        {stepNodes.length === 0 && (
          <div className="absolute left-0 right-0 bottom-6 flex justify-center pointer-events-none">
            <div className="text-center px-3 py-2 rounded-md bg-bg-base/70 backdrop-blur border border-border-subtle/60">
              <p className="text-xs text-text-tertiary mb-1">
                Drag an action from the sidebar to get started
              </p>
              <p className="text-[11px] text-text-tertiary/70">
                Press <kbd className="px-1 py-0.5 bg-bg-hover rounded text-[10px]">A</kbd> to open actions
                {' '}&middot;{' '}
                <kbd className="px-1 py-0.5 bg-bg-hover rounded text-[10px]">Shift+N</kbd> for sticky note
              </p>
            </div>
          </div>
        )}

        <ActionSidebar
          isOpen={sidebarOpen}
          onOpen={handleOpenSidebar}
          onClose={handleCloseSidebar}
        />

        {/* Config panels — mutually exclusive with sidebar */}
        {!sidebarOpen && isTriggerSelected && selectedNode && (
          <TriggerConfigPanel
            node={selectedNode}
            onUpdate={updateNodeData}
            onClose={() => setSelectedNodeId(null)}
          />
        )}

        {!sidebarOpen && isStepSelected && selectedNode && (
          <StepConfigPanel
            node={selectedNode}
            allNodes={nodes}
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
  // key={routine.id} guarantees a full unmount/remount when the user switches
  // to a different routine, so canvas state (trigger node, nodes, edges,
  // stickies, dirty flags) never leaks from the previous routine.
  return (
    <ReactFlowProvider>
      <CanvasInner key={routine.id} routine={routine} />
    </ReactFlowProvider>
  );
}
