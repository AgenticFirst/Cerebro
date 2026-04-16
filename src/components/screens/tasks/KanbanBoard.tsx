import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
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
import { X } from 'lucide-react';
import { useTasks, type Task, type TaskColumn } from '../../../context/TaskContext';
import KanbanColumn from './KanbanColumn';
import TaskCard from './TaskCard';

const COLUMNS: TaskColumn[] = ['backlog', 'in_progress', 'to_review', 'completed', 'error'];

interface KanbanBoardProps {
  onCardClick: (task: Task) => void;
}

export default function KanbanBoard({ onCardClick }: KanbanBoardProps) {
  const { t } = useTranslation();
  const { tasks, moveTask, startTask, deleteTask } = useTasks();
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      for (const tag of task.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }));
  }, [tasks]);

  const effectiveTagFilter = tagFilter && allTags.some((tag) => tag.name === tagFilter) ? tagFilter : null;

  // Drag position math reads from the full (unfiltered) grouping so a tag
  // filter can't collapse positions across hidden neighbors.
  const fullTasksByColumn = useMemo(() => {
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

  const tasksByColumn = useMemo(() => {
    if (!effectiveTagFilter) return fullTasksByColumn;
    const filtered: Record<TaskColumn, Task[]> = {
      backlog: [],
      in_progress: [],
      to_review: [],
      completed: [],
      error: [],
    };
    for (const col of COLUMNS) {
      filtered[col] = fullTasksByColumn[col].filter((task) =>
        (task.tags ?? []).includes(effectiveTagFilter),
      );
    }
    return filtered;
  }, [fullTasksByColumn, effectiveTagFilter]);

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

      let targetColumn: TaskColumn | undefined;
      let targetIndex: number | undefined;

      if (COLUMNS.includes(over.id as TaskColumn)) {
        targetColumn = over.id as TaskColumn;
        targetIndex = fullTasksByColumn[targetColumn].length;
      } else {
        const overTask = tasks.find((t) => t.id === over.id);
        if (overTask) {
          targetColumn = overTask.column;
          const columnTasks = fullTasksByColumn[targetColumn];
          const overIndex = columnTasks.findIndex((t) => t.id === over.id);
          targetIndex = overIndex >= 0 ? overIndex : columnTasks.length;
        }
      }

      if (!targetColumn || targetIndex === undefined) return;

      const sourceTask = tasks.find((t) => t.id === taskId);
      if (!sourceTask) return;

      // Backend positions are floats on a 1024 stride — passing a raw array
      // index would corrupt ordering by mixing integers with existing floats.
      const dest = fullTasksByColumn[targetColumn].filter((t) => t.id !== taskId);
      const clamped = Math.max(0, Math.min(targetIndex, dest.length));
      const prev = dest[clamped - 1]?.position;
      const next = dest[clamped]?.position;
      let newPosition: number;
      if (prev === undefined && next === undefined) newPosition = 1024;
      else if (prev === undefined) newPosition = (next as number) - 1024;
      else if (next === undefined) newPosition = prev + 1024;
      else newPosition = (prev + next) / 2;

      if (
        sourceTask.column !== targetColumn ||
        Math.abs(sourceTask.position - newPosition) > 0.001
      ) {
        moveTask(taskId, targetColumn, newPosition);
      }
    },
    [tasks, fullTasksByColumn, moveTask],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="h-full flex flex-col min-h-0">
        {allTags.length > 0 && (
          <div className="flex items-center gap-1.5 px-5 pt-3 pb-2 flex-wrap flex-shrink-0">
            <button
              onClick={() => setTagFilter(null)}
              className={clsx(
                'px-2.5 py-0.5 text-[11px] font-medium rounded-full border transition-colors cursor-pointer',
                !effectiveTagFilter
                  ? 'bg-accent/10 text-accent border-accent/30'
                  : 'text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border-default',
              )}
            >
              {t('tasks.filterAllTags')}
            </button>
            {allTags.map((tag) => (
              <button
                key={tag.name}
                onClick={() =>
                  setTagFilter((current) => (current === tag.name ? null : tag.name))
                }
                className={clsx(
                  'inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full border transition-colors cursor-pointer',
                  effectiveTagFilter === tag.name
                    ? 'bg-accent/10 text-accent border-accent/30'
                    : 'text-text-tertiary border-border-subtle hover:text-text-secondary hover:border-border-default',
                )}
                title={t('tasks.filterByTag')}
              >
                {tag.name}
                <span className="text-[10px] opacity-60">{tag.count}</span>
                {effectiveTagFilter === tag.name && (
                  <X
                    size={10}
                    className="ml-0.5"
                    aria-label={t('tasks.clearTagFilter')}
                  />
                )}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 flex gap-4 px-5 py-4 overflow-x-auto">
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
