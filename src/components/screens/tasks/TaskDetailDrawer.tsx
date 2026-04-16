import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Maximize2, Minimize2, Trash2, Play, StopCircle } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type Task, type TaskColumn, type TaskPriority } from '../../../context/TaskContext';
import { useExperts } from '../../../context/ExpertContext';
import TaskDescriptionEditor from './TaskDescriptionEditor';
import ChecklistEditor from './ChecklistEditor';
import CommentThread from './CommentThread';
import ExpertConsole from './ExpertConsole';
import LivePreview from './LivePreview';

type Tab = 'details' | 'console' | 'preview' | 'activity';

const COLUMNS: TaskColumn[] = ['backlog', 'in_progress', 'to_review', 'completed', 'error'];
const PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

const COLUMN_LABEL_KEYS: Record<TaskColumn, string> = {
  backlog: 'tasks.column_backlog',
  in_progress: 'tasks.column_in_progress',
  to_review: 'tasks.column_to_review',
  completed: 'tasks.column_completed',
  error: 'tasks.column_error',
};

const COLUMN_COLORS: Record<TaskColumn, string> = {
  backlog: 'bg-zinc-600/20 text-zinc-400',
  in_progress: 'bg-cyan-500/15 text-cyan-400',
  to_review: 'bg-amber-500/15 text-amber-400',
  completed: 'bg-emerald-500/15 text-emerald-400',
  error: 'bg-red-500/15 text-red-400',
};

interface TaskDetailDrawerProps {
  task: Task | null;
  onClose: () => void;
}

export default function TaskDetailDrawer({ task, onClose }: TaskDetailDrawerProps) {
  const { t } = useTranslation();
  const { updateTask, moveTask, deleteTask, startTask, cancelTask } = useTasks();
  const { experts } = useExperts();

  const [activeTab, setActiveTab] = useState<Tab>('details');
  const [isFullWidth, setIsFullWidth] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const prevColumnRef = useRef<TaskColumn | null>(null);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  useEffect(() => {
    if (!task) return;
    // When opening a task: default to Console if already running, otherwise Details
    setActiveTab(task.column === 'in_progress' ? 'console' : 'details');
    setIsFullWidth(false);
    setIsEditingTitle(false);
    prevColumnRef.current = task.column;
  }, [task?.id]);

  // Auto-switch to Console when a task first transitions to in_progress
  useEffect(() => {
    if (!task) return;
    if (prevColumnRef.current !== task.column) {
      if (task.column === 'in_progress') {
        setActiveTab('console');
      }
      prevColumnRef.current = task.column;
    }
  }, [task?.column]);

  const handleTitleClick = useCallback(() => {
    if (!task) return;
    setEditTitle(task.title);
    setIsEditingTitle(true);
  }, [task]);

  const handleTitleSave = useCallback(() => {
    if (!task) return;
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== task.title) {
      updateTask(task.id, { title: trimmed });
    }
    setIsEditingTitle(false);
  }, [task, editTitle, updateTask]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleTitleSave();
      if (e.key === 'Escape') setIsEditingTitle(false);
    },
    [handleTitleSave],
  );

  const handleDelete = useCallback(() => {
    if (!task) return;
    const confirmed = window.confirm(
      `Permanently delete "${task.title}"?\n\nThis will remove the task, all comments, checklist items, and the entire workspace directory. This cannot be undone.`,
    );
    if (!confirmed) return;
    deleteTask(task.id);
    onClose();
  }, [task, deleteTask, onClose]);

  const handleDescriptionSave = useCallback(
    (md: string) => {
      if (task) updateTask(task.id, { description_md: md });
    },
    [task, updateTask],
  );

  const handleStart = useCallback(async () => {
    if (!task) return;
    setIsStarting(true);
    // Auto-enter Focus Mode when starting
    setIsFullWidth(true);
    try {
      await startTask(task.id);
      setActiveTab('console');
    } catch (err) {
      console.error('[TaskDetailDrawer] Failed to start task:', err);
    } finally {
      setIsStarting(false);
    }
  }, [task, startTask]);

  const handleCancel = useCallback(async () => {
    if (!task) return;
    try {
      await cancelTask(task.id);
    } catch (err) {
      console.error('[TaskDetailDrawer] Failed to cancel task:', err);
    }
  }, [task, cancelTask]);

  const handleColumnChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!task) return;
      moveTask(task.id, e.target.value as TaskColumn);
    },
    [task, moveTask],
  );

  if (!task) return null;

  const isStartableColumn = task.column === 'backlog' || task.column === 'to_review' || task.column === 'error';
  const hasExpert = !!task.expert_id;
  const canStart = isStartableColumn && hasExpert;
  const isRunning = task.column === 'in_progress';
  const hasRun = !!task.run_id;
  const startLabel =
    task.column === 'to_review' ? t('tasks.rerunTask')
    : task.column === 'error' ? t('tasks.retryTask')
    : t('tasks.startTask');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'details', label: t('tasks.tabDetails') },
    { key: 'console', label: t('tasks.tabConsole') },
    { key: 'preview', label: t('tasks.tabPreview') },
    { key: 'activity', label: t('tasks.tabActivity') },
  ];

  // Shared header + metadata (used in both compact and focus modes)
  const renderHeader = () => (
    <>
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={handleTitleKeyDown}
              className="flex-1 text-base font-semibold text-text-primary bg-transparent border-b border-accent outline-none"
            />
          ) : (
            <h2
              onClick={handleTitleClick}
              className="flex-1 text-base font-semibold text-text-primary truncate cursor-pointer hover:text-accent transition-colors"
            >
              {task.title}
            </h2>
          )}

          <select
            value={task.column}
            onChange={handleColumnChange}
            className={clsx(
              'flex-shrink-0 px-2 py-0.5 text-[11px] font-medium rounded-full border-none outline-none cursor-pointer appearance-none pr-5',
              COLUMN_COLORS[task.column],
            )}
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
          >
            {COLUMNS.map((col) => (
              <option key={col} value={col}>
                {t(COLUMN_LABEL_KEYS[col])}
              </option>
            ))}
          </select>
        </div>

        {/* Start / Stop action button */}
        {isStartableColumn && (
          <button
            onClick={handleStart}
            disabled={!canStart || isStarting}
            title={!hasExpert ? t('tasks.startNeedsExpert') : undefined}
            className={clsx(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors text-xs font-semibold',
              canStart
                ? 'bg-accent text-white hover:bg-accent/90 cursor-pointer disabled:opacity-50 disabled:cursor-wait'
                : 'bg-bg-hover text-text-tertiary border border-border-subtle cursor-not-allowed',
            )}
          >
            <Play size={13} className={canStart ? 'fill-current' : ''} />
            {startLabel}
          </button>
        )}
        {isRunning && (
          <button
            onClick={handleCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors cursor-pointer text-xs font-semibold border border-red-500/20"
          >
            <StopCircle size={13} />
            {t('tasks.cancelTask')}
          </button>
        )}

        <button
          onClick={() => setIsFullWidth((v) => !v)}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={isFullWidth ? t('tasks.exitFocusMode') : t('tasks.focusMode')}
        >
          {isFullWidth ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>

        <button
          onClick={handleDelete}
          className="p-1.5 rounded-md text-text-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
          title={t('tasks.drawerDelete')}
        >
          <Trash2 size={16} />
        </button>

        <button
          onClick={onClose}
          className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <X size={16} />
        </button>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-4 px-5 py-2.5 border-b border-border-subtle text-sm flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-text-tertiary text-xs">{t('tasks.drawerExpert')}</span>
          <select
            value={task.expert_id ?? ''}
            onChange={(e) => updateTask(task.id, { expert_id: e.target.value || null })}
            className="bg-bg-elevated text-text-primary text-xs rounded-md px-2 py-1 border border-border-subtle outline-none focus:border-accent cursor-pointer"
          >
            <option value="">{t('tasks.drawerUnassigned')}</option>
            {experts
              .filter((e) => e.type === 'expert' && e.isEnabled)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-text-tertiary text-xs">{t('tasks.drawerPriority')}</span>
          <select
            value={task.priority}
            onChange={(e) => updateTask(task.id, { priority: e.target.value as TaskPriority })}
            className="bg-bg-elevated text-text-primary text-xs rounded-md px-2 py-1 border border-border-subtle outline-none focus:border-accent cursor-pointer capitalize"
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-text-tertiary text-xs">{t('tasks.drawerStartAt')}</span>
          <input
            type="date"
            value={task.start_at?.slice(0, 10) ?? ''}
            onChange={(e) => updateTask(task.id, { start_at: e.target.value || null })}
            className="bg-bg-elevated text-text-primary text-xs rounded-md px-2 py-1 border border-border-subtle outline-none focus:border-accent cursor-pointer"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-text-tertiary text-xs">{t('tasks.drawerDueAt')}</span>
          <input
            type="date"
            value={task.due_at?.slice(0, 10) ?? ''}
            onChange={(e) => updateTask(task.id, { due_at: e.target.value || null })}
            className="bg-bg-elevated text-text-primary text-xs rounded-md px-2 py-1 border border-border-subtle outline-none focus:border-accent cursor-pointer"
          />
        </div>
      </div>
    </>
  );

  // Details content (description + checklist) — used in both modes
  const detailsContent = (
    <div className="p-5 space-y-5 overflow-y-auto">
      <TaskDescriptionEditor
        taskId={task.id}
        value={task.description_md}
        onSave={handleDescriptionSave}
      />
      <ChecklistEditor task={task} />
    </div>
  );

  // Activity content (comment thread + composer)
  const activityContent = (
    <div className="p-5 overflow-y-auto">
      <CommentThread taskId={task.id} />
    </div>
  );

  // Focus-mode left panel combines details + activity
  const focusLeftPanel = (
    <div className="flex flex-col min-h-0 overflow-y-auto">
      <div className="p-5 space-y-5">
        <TaskDescriptionEditor
          taskId={task.id}
          value={task.description_md}
          onSave={handleDescriptionSave}
        />
        <ChecklistEditor task={task} />
        <div className="pt-4 border-t border-border-subtle">
          <CommentThread taskId={task.id} />
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-30" onClick={onClose} />

      <div
        className={clsx(
          'fixed inset-y-0 right-0 z-40 flex flex-col',
          'bg-bg-base border-l border-border-subtle shadow-2xl',
          'transition-[width] duration-200 ease-out',
          isFullWidth ? 'w-full' : 'w-[60%] min-w-[480px] max-w-[800px]',
        )}
      >
        {renderHeader()}

        {isFullWidth ? (
          // ── Focus Mode: 3-panel split ──
          <div className="flex-1 min-h-0 flex">
            {/* Details panel (30%) */}
            <div className="w-[30%] min-w-[320px] max-w-[480px] border-r border-border-subtle flex flex-col min-h-0">
              {focusLeftPanel}
            </div>
            {/* Console panel (40%) */}
            <div className="flex-1 border-r border-border-subtle min-w-0 min-h-0">
              <ExpertConsole runId={task.run_id} />
            </div>
            {/* Preview panel (30%) */}
            <div className="w-[30%] min-w-[320px] max-w-[520px] min-h-0">
              <LivePreview taskId={task.id} runId={task.run_id} />
            </div>
          </div>
        ) : (
          // ── Compact Mode: tabs ──
          <>
            <div className="flex px-5 border-b border-border-subtle flex-shrink-0">
              {tabs.map((tab) => {
                // Hide Preview and Console tabs if task hasn't started yet
                if ((tab.key === 'console' || tab.key === 'preview') && !hasRun) return null;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={clsx(
                      'px-3 py-2 text-sm font-medium transition-colors cursor-pointer',
                      activeTab === tab.key
                        ? 'text-accent border-b-2 border-accent'
                        : 'text-text-tertiary hover:text-text-secondary border-b-2 border-transparent',
                    )}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-h-0 flex flex-col">
              {activeTab === 'details' && detailsContent}
              {activeTab === 'console' && (
                <div className="flex-1 min-h-0">
                  <ExpertConsole runId={task.run_id} />
                </div>
              )}
              {activeTab === 'preview' && (
                <div className="flex-1 min-h-0">
                  <LivePreview taskId={task.id} runId={task.run_id} />
                </div>
              )}
              {activeTab === 'activity' && activityContent}
            </div>
          </>
        )}
      </div>
    </>
  );
}
