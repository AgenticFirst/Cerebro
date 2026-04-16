import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensors,
  useSensor,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useTasks, type Task, type TaskColumn } from '../../../context/TaskContext';
import KanbanColumn from './KanbanColumn';
import TaskCard from './TaskCard';

const COLUMNS: TaskColumn[] = ['backlog', 'in_progress', 'to_review', 'completed', 'error'];

interface KanbanBoardProps {
  onCardClick: (task: Task) => void;
}

export default function KanbanBoard({ onCardClick }: KanbanBoardProps) {
  const { tasks, moveTask, startTask, deleteTask } = useTasks();
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const tasksByColumn = useMemo(() => {
    const grouped: Record<TaskColumn, Task[]> = {
      backlog: [],
      in_progress: [],
      to_review: [],
      completed: [],
      error: [],
    };
    for (const task of tasks) {
      grouped[task.column]?.push(task);
    }
    for (const col of COLUMNS) {
      grouped[col].sort((a, b) => a.position - b.position);
    }
    return grouped;
  }, [tasks]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [tasks],
  );

  const handleMoveTask = useCallback(
    (taskId: string, column: TaskColumn) => {
      moveTask(taskId, column);
    },
    [moveTask],
  );

  const handleStartTask = useCallback(
    (taskId: string) => {
      startTask(taskId).catch((err) => console.error('[KanbanBoard] startTask failed:', err));
    },
    [startTask],
  );

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      deleteTask(taskId).catch((err) => console.error('[KanbanBoard] deleteTask failed:', err));
    },
    [deleteTask],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;

      // Determine which column was dropped onto — either a column droppable or a card within one
      let targetColumn: TaskColumn | undefined;
      let targetPosition: number | undefined;

      if (COLUMNS.includes(over.id as TaskColumn)) {
        targetColumn = over.id as TaskColumn;
        targetPosition = tasksByColumn[targetColumn].length;
      } else {
        const overTask = tasks.find((t) => t.id === over.id);
        if (overTask) {
          targetColumn = overTask.column;
          const columnTasks = tasksByColumn[targetColumn];
          const overIndex = columnTasks.findIndex((t) => t.id === over.id);
          targetPosition = overIndex >= 0 ? overIndex : columnTasks.length;
        }
      }

      if (!targetColumn) return;

      const sourceTask = tasks.find((t) => t.id === taskId);
      if (sourceTask && (sourceTask.column !== targetColumn || sourceTask.position !== targetPosition)) {
        moveTask(taskId, targetColumn, targetPosition);
      }
    },
    [tasks, tasksByColumn, moveTask],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="h-full flex gap-4 px-5 py-4 overflow-x-auto">
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column}
            column={column}
            tasks={tasksByColumn[column]}
            onCardClick={onCardClick}
            onMoveTask={handleMoveTask}
            onStartTask={handleStartTask}
            onDeleteTask={handleDeleteTask}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="rotate-2 opacity-90">
            <TaskCard task={activeTask} onClick={() => {}} isDragOverlay />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
