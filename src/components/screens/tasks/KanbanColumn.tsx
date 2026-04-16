import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus, CheckCircle } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type Task, type TaskColumn } from '../../../context/TaskContext';
import TaskCard from './TaskCard';

interface KanbanColumnProps {
  column: TaskColumn;
  tasks: Task[];
  onCardClick: (task: Task) => void;
  onMoveTask: (taskId: string, column: TaskColumn) => void;
  onStartTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}

export default function KanbanColumn({ column, tasks, onCardClick, onMoveTask, onStartTask, onDeleteTask }: KanbanColumnProps) {
  const { t } = useTranslation();
  const { createTask } = useTasks();
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { setNodeRef, isOver } = useDroppable({ id: column });

  const taskIds = tasks.map((task) => task.id);

  useEffect(() => {
    if (isAdding) inputRef.current?.focus();
  }, [isAdding]);

  const handleSubmit = useCallback(async () => {
    const trimmed = newTitle.trim();
    if (!trimmed) {
      setIsAdding(false);
      return;
    }
    try {
      await createTask({ title: trimmed, column });
    } catch {
      // let TaskContext handle error state
    }
    setNewTitle('');
    setIsAdding(false);
  }, [newTitle, column, createTask]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        setNewTitle('');
        setIsAdding(false);
      }
    },
    [handleSubmit],
  );

  const doneCount = tasks.filter((t) => t.column === 'completed').length;

  return (
    <div
      className={clsx(
        'w-[calc(25%-12px)] flex-shrink-0 flex flex-col',
        'bg-bg-surface/50 border border-border-subtle rounded-xl',
        isOver && 'border-accent/40',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3.5 pb-1">
        <span className="text-sm font-semibold text-text-primary">
          {t(`tasks.column_${column}`)}
        </span>
        <button
          onClick={() => setIsAdding(true)}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Progress bar (for columns with tasks) */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-2 px-4 pb-2">
          <div className="flex-1 h-1 rounded-full bg-bg-hover overflow-hidden">
            <div
              className="h-full rounded-full bg-accent/50 transition-all"
              style={{ width: `${tasks.length > 0 ? (doneCount / tasks.length) * 100 : 0}%` }}
            />
          </div>
          <span className="text-[10px] text-text-tertiary tabular-nums">
            {doneCount}/{tasks.length} {t('tasks.column_completed')}
          </span>
        </div>
      )}

      {/* Add task (top, Blitzit-style) */}
      <div className="px-3 pb-1.5">
        {isAdding ? (
          <input
            ref={inputRef}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSubmit}
            placeholder={t('tasks.addCardPlaceholder')}
            className="w-full text-xs bg-bg-elevated border border-border-default rounded-lg px-3 py-2 text-text-primary placeholder:text-text-tertiary outline-none focus:border-accent/50 transition-colors"
          />
        ) : (
          <button
            onClick={() => setIsAdding(true)}
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary rounded-lg hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <Plus size={12} />
            {t('tasks.addCard').toUpperCase()}
          </button>
        )}
      </div>

      {/* Card area */}
      <div
        ref={setNodeRef}
        className="flex-1 flex flex-col gap-1.5 overflow-y-auto px-2 pb-3 min-h-0"
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onClick={() => onCardClick(task)} onMove={onMoveTask} onStart={onStartTask} onDelete={onDeleteTask} />
          ))}
        </SortableContext>

        {/* Blitzit-style "All Clear" empty state */}
        {tasks.length === 0 && !isAdding && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 min-h-[120px]">
            <CheckCircle size={24} className="text-accent/40" />
            <span className="text-xs text-text-tertiary">
              {t('tasks.allClear')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
