import { useState, useRef, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageCircle, Calendar, ArrowUp, Play, ChevronDown, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { Task, TaskColumn } from '../../../context/TaskContext';

// ── Constants ─────────────────────────────────────────────────

const COLUMNS: TaskColumn[] = ['backlog', 'in_progress', 'to_review', 'completed', 'error'];

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-red-400',
  high: 'bg-amber-400',
  normal: '',
  low: 'bg-zinc-500',
};

const COLUMN_PILL_COLORS: Record<TaskColumn, string> = {
  backlog: 'bg-zinc-600/30 text-zinc-400',
  in_progress: 'bg-cyan-500/15 text-cyan-400',
  to_review: 'bg-amber-500/15 text-amber-400',
  completed: 'bg-emerald-500/15 text-emerald-400',
  error: 'bg-red-500/15 text-red-400',
};

// ── Helpers ───────────────────────────────────────────────────

function relativeDate(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { label: string; color: string } {
  const now = new Date();
  const target = new Date(iso);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const diffMs = targetDay.getTime() - todayStart.getTime();
  const diffDays = Math.round(diffMs / 86_400_000);

  if (diffDays < 0) return { label: t('tasks.overdue'), color: 'text-red-400' };
  if (diffDays === 0) return { label: t('tasks.dueToday'), color: 'text-amber-400' };
  return {
    label: targetDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    color: 'text-text-tertiary',
  };
}

function expertInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

// ── Component ─────────────────────────────────────────────────

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onMove?: (taskId: string, column: TaskColumn) => void;
  /** Called when user clicks the Start button — spawns the Expert run. */
  onStart?: (taskId: string) => void;
  /** Called when user clicks the Delete button — permanently deletes the task. */
  onDelete?: (taskId: string) => void;
  expertName?: string;
  isDragOverlay?: boolean;
}

export default function TaskCard({ task, onClick, onMove, onStart, onDelete, expertName, isDragOverlay }: TaskCardProps) {
  const { t } = useTranslation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { column: task.column },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const priorityDot = PRIORITY_DOT[task.priority] ?? '';
  const showPriorityDot = task.priority !== 'normal';
  const due = task.due_at ? relativeDate(task.due_at, t) : null;
  const hasChecklist = task.checklist_total > 0;
  const checklistPct =
    hasChecklist ? Math.round((task.checklist_done / task.checklist_total) * 100) : 0;

  const isStartableColumn = task.column === 'backlog' || task.column === 'to_review' || task.column === 'error';
  const hasExpert = !!task.expert_id;
  const canStart = isStartableColumn && hasExpert;
  const startLabel =
    task.column === 'to_review' ? t('tasks.rerunTask')
    : task.column === 'error' ? t('tasks.retryTask')
    : t('tasks.startTask');

  const handleStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onStart) {
      onStart(task.id);
    } else {
      // Fallback: just move the card (used for drag overlay, etc.)
      onMove?.(task.id, 'in_progress');
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onDelete) return;
    const confirmed = window.confirm(
      `Permanently delete "${task.title}"?\n\nThis will remove the task, all comments, checklist items, and the entire workspace directory. This cannot be undone.`,
    );
    if (confirmed) onDelete(task.id);
  };

  const handleColumnSelect = (e: React.MouseEvent, col: TaskColumn) => {
    e.stopPropagation();
    setDropdownOpen(false);
    if (col !== task.column) onMove?.(task.id, col);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={clsx(
        'group bg-bg-surface border border-border-subtle rounded-lg p-3 cursor-pointer',
        'hover:border-border-default transition-colors',
        isDragging && 'opacity-50',
      )}
    >
      {/* Title row */}
      <div className="flex items-start gap-2">
        {showPriorityDot && (
          <span
            className={clsx('mt-1.5 w-2 h-2 rounded-full flex-shrink-0', priorityDot)}
            title={t(`tasks.priority_${task.priority}`)}
          />
        )}
        <span className="flex-1 text-sm text-text-primary line-clamp-2 leading-snug">
          {task.title}
        </span>
        {task.expert_id && expertName && (
          <span
            className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/15 text-accent text-[10px] font-medium flex items-center justify-center"
            title={expertName}
          >
            {expertInitials(expertName)}
          </span>
        )}
        {onDelete && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={handleDelete}
            className="flex-shrink-0 p-0.5 rounded text-text-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
            title={t('tasks.deleteTask')}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {task.parent_task_id && (
          <span className="inline-flex items-center text-[10px] text-text-tertiary" title={t('tasks.subtask')}>
            <ArrowUp size={10} className="mr-0.5" />
          </span>
        )}

        {/* Column move dropdown */}
        {onMove && (
          <div ref={dropdownRef} className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setDropdownOpen((v) => !v); }}
              className={clsx(
                'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium transition-colors cursor-pointer',
                COLUMN_PILL_COLORS[task.column],
              )}
            >
              {t(`tasks.column_${task.column}`)}
              <ChevronDown size={10} />
            </button>
            {dropdownOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl py-1 min-w-[140px]">
                {COLUMNS.map((col) => (
                  <button
                    key={col}
                    onClick={(e) => handleColumnSelect(e, col)}
                    className={clsx(
                      'w-full px-3 py-1.5 text-left text-xs transition-colors cursor-pointer',
                      col === task.column
                        ? 'text-accent bg-accent/10'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
                    )}
                  >
                    {t(`tasks.column_${col}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {due && (
          <span className={clsx('inline-flex items-center gap-1 text-[11px]', due.color)}>
            <Calendar size={10} />
            {due.label}
          </span>
        )}

        {hasChecklist && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
            <span>{task.checklist_done}/{task.checklist_total}</span>
            <span className="relative w-8 h-1 rounded-full bg-bg-hover overflow-hidden">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-accent/60"
                style={{ width: `${checklistPct}%` }}
              />
            </span>
          </span>
        )}

        {task.comment_count > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-text-tertiary ml-auto">
            <MessageCircle size={10} />
            {task.comment_count}
          </span>
        )}
      </div>

      {/* Start button — disabled for unassigned tasks */}
      {isStartableColumn && (onStart || onMove) && (
        <button
          onClick={canStart ? handleStart : (e) => e.stopPropagation()}
          disabled={!canStart}
          title={!hasExpert ? t('tasks.startNeedsExpert') : undefined}
          className={clsx(
            'mt-2.5 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors border',
            canStart
              ? 'bg-accent/10 text-accent hover:bg-accent/20 border-accent/20 cursor-pointer'
              : 'bg-bg-hover text-text-tertiary border-border-subtle cursor-not-allowed',
          )}
        >
          <Play size={12} className={canStart ? 'fill-current' : ''} />
          {startLabel}
        </button>
      )}
    </div>
  );
}
