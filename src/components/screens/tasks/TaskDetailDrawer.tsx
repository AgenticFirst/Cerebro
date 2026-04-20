import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Maximize2, Minimize2, Trash2, Play, StopCircle, RotateCcw, Copy, Terminal } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type Task, type TaskColumn, type TaskPriority } from '../../../context/TaskContext';
import { useExperts } from '../../../context/ExpertContext';
import TaskDescriptionEditor from './TaskDescriptionEditor';
import ChecklistEditor from './ChecklistEditor';
import CommentThread from './CommentThread';
import ActivityTimeline from './ActivityTimeline';
import ExpertConsole from './ExpertConsole';
import LivePreview from './LivePreview';
import TagChipInput from './TagChipInput';
import TaskArtifactStrip from './TaskArtifactStrip';
import ProjectFolderField from './ProjectFolderField';
import AlertModal from '../../ui/AlertModal';

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
  const { tasks, updateTask, moveTask, deleteTask, startTask, cancelTask, getActiveRunId } = useTasks();
  const { experts } = useExperts();

  const tagSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const task of tasks) for (const tag of task.tags ?? []) set.add(tag);
    return Array.from(set).sort();
  }, [tasks]);

  const assignedExpert = useMemo(
    () => experts.find((e) => e.id === task?.expert_id) ?? null,
    [experts, task?.expert_id],
  );

  const [activeTab, setActiveTab] = useState<Tab>('details');
  const [isFullWidth, setIsFullWidth] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [showHardReset, setShowHardReset] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  useEffect(() => {
    if (!task) return;
    // Always land on Details when opening a task — the live-session badge in
    // the header lets users jump to the console on demand. This keeps the
    // entry point friendly for non-coders who don't want to see a terminal.
    setActiveTab('details');
    setIsFullWidth(false);
    setIsEditingTitle(false);
    setShowHardReset(false);
  }, [task?.id]);

  useEffect(() => {
    if (!task) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task, onClose]);

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
    setShowDeleteConfirm(true);
  }, [task]);

  const confirmDelete = useCallback(() => {
    if (!task) return;
    deleteTask(task.id);
    setShowDeleteConfirm(false);
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

  const cancelIfRunning = useCallback(async () => {
    if (task?.column === 'in_progress') {
      try { await cancelTask(task.id); } catch { /* noop */ }
    }
  }, [task, cancelTask]);

  const handleHardReset = useCallback(async () => {
    if (!task?.run_id) return;
    await cancelIfRunning();
    window.cerebro.taskTerminal.removeBuffer(task.run_id).catch(() => {});
    setShowHardReset(true);
    setActiveTab('console');
  }, [task, cancelIfRunning]);

  const handleResume = useCallback(async () => {
    if (!task) return;
    setShowHardReset(false);
    await cancelIfRunning();
    // Re-attach the TUI to the prior session without re-sending the task
    // prompt. The session already has full context from the previous run;
    // the user types whatever they want next.
    setIsStarting(true);
    setIsFullWidth(true);
    try {
      await startTask(task.id, { interactive: true });
      setActiveTab('console');
    } catch (err) {
      console.error('[TaskDetailDrawer] Failed to resume task:', err);
    } finally {
      setIsStarting(false);
    }
  }, [task, cancelIfRunning, startTask]);

  const handleColumnChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (!task) return;
      moveTask(task.id, e.target.value as TaskColumn);
    },
    [task, moveTask],
  );

  const handleFolderChange = useCallback(
    async (folder: string | null) => {
      if (!task) return;
      await updateTask(task.id, { project_path: folder });
    },
    [task, updateTask],
  );

  if (!task) return null;

  const isStartableColumn = task.column === 'backlog' || task.column === 'to_review' || task.column === 'error';
  const hasExpert = !!task.expert_id;
  const canStart = isStartableColumn && hasExpert;
  const isRunning = task.column === 'in_progress';
  const hasRun = !!task.run_id;
  // Console binds to task.run_id (the persistent session id) — the Electron
  // runtime buffers PTY output under this key too, so the console stays
  // populated across rerun cycles. We only fall back to the active internal
  // runId during the brief window between agent.run() and the backend's
  // run_started echo that sets task.run_id.
  const consoleRunId = task.run_id ?? getActiveRunId(task.id);
  const startLabel =
    task.column === 'to_review' ? t('tasks.rerunTask')
    : task.column === 'error' ? t('tasks.retryTask')
    : t('tasks.startTask');

  // Shared between compact and focus modes
  const consolePanel = (
    <div className="flex flex-col h-full min-h-0">
      {hasRun && (
        <div className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-border-subtle bg-bg-surface">
          <Terminal size={13} className="text-text-tertiary mr-1" />
          <div className="flex-1" />
          <button
            onClick={handleHardReset}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded-md transition-colors cursor-pointer"
            title={t('tasks.consoleHardResetTitle')}
          >
            <RotateCcw size={12} />
            {t('tasks.consoleHardReset')}
          </button>
          <button
            onClick={handleResume}
            disabled={isRunning || isStarting}
            className={clsx(
              'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer',
              isRunning || isStarting
                ? 'text-text-tertiary/50 cursor-not-allowed'
                : 'text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10',
            )}
            title={t('tasks.consoleResumeTitle')}
          >
            <Play size={12} />
            {t('tasks.consoleResume')}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {showHardReset && task.run_id ? (
          <div className="w-full h-full bg-[#1a1a1a] flex flex-col items-center justify-center gap-4 p-8">
            <Terminal size={32} className="text-zinc-500" />
            <p className="text-sm text-zinc-400 text-center">{t('tasks.consoleHardResetTitle')}</p>
            <button
              onClick={() => {
                navigator.clipboard.writeText(`claude --resume ${task.run_id}`);
              }}
              className="group flex items-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors cursor-pointer"
            >
              <code className="text-sm text-emerald-400 font-mono">
                claude --resume {task.run_id}
              </code>
              <Copy size={14} className="text-zinc-500 group-hover:text-zinc-300 transition-colors" />
            </button>
          </div>
        ) : (
          <ExpertConsole runId={consoleRunId} />
        )}
      </div>
    </div>
  );

  const tabs: { key: Tab; label: string }[] = [
    { key: 'details', label: t('tasks.tabDetails') },
    { key: 'console', label: t('tasks.tabConsole') },
    { key: 'preview', label: t('tasks.tabPreview') },
    { key: 'activity', label: t('tasks.tabActivity') },
  ];

  // Shared header + metadata (used in both compact and focus modes)
  // In focus mode the drawer spans the full window on macOS (`titleBarStyle: 'hiddenInset'`),
  // so the header runs under the traffic-light controls at x≈16–70. Pad the left edge
  // to clear them; compact mode is anchored right and unaffected.
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
  const renderHeader = () => (
    <>
      <div
        className={clsx(
          'flex items-center gap-2 py-3 pr-5 border-b border-border-subtle flex-shrink-0',
          isFullWidth && isMac ? 'pl-[88px]' : 'pl-5',
        )}
      >
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

        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-text-tertiary text-xs">{t('tasks.drawerProjectFolder')}</span>
          <ProjectFolderField
            value={task.project_path}
            onChange={handleFolderChange}
            variant="compact"
          />
        </div>
      </div>

      {isRunning && !isFullWidth && (
        <button
          type="button"
          onClick={() => setActiveTab('console')}
          className="group flex items-center gap-2.5 px-5 py-2 border-b border-cyan-500/20 bg-cyan-500/5 hover:bg-cyan-500/10 transition-colors cursor-pointer text-left w-full"
          title={t('tasks.viewLiveConsoleTitle')}
        >
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
          </span>
          <span className="text-xs font-medium text-cyan-300 truncate">
            {assignedExpert
              ? t('tasks.expertWorking', { expert: assignedExpert.name })
              : t('tasks.taskRunningLive')}
          </span>
          <span className="ml-auto text-[11px] font-medium text-cyan-400/80 group-hover:text-cyan-300 flex-shrink-0">
            {t('tasks.viewLiveConsole')} →
          </span>
        </button>
      )}

      <div className="flex items-start gap-2 px-5 py-2 border-b border-border-subtle">
        <span className="text-text-tertiary text-xs pt-1.5 flex-shrink-0">{t('tasks.drawerTags')}</span>
        <div className="flex-1 min-w-0">
          <TagChipInput
            tags={task.tags ?? []}
            onChange={(tags) => updateTask(task.id, { tags })}
            suggestions={tagSuggestions}
          />
        </div>
      </div>
    </>
  );

  // Details content: description + checklist + Comments section (Trello-style).
  // System comments live in the Activity tab; the comments section shows
  // user/expert conversation only.
  const detailsContent = (
    <div className="p-5 space-y-5 overflow-y-auto">
      <TaskDescriptionEditor
        taskId={task.id}
        value={task.description_md}
        onSave={handleDescriptionSave}
      />
      <ChecklistEditor task={task} />
      <div className="pt-4 border-t border-border-subtle">
        <span className="block text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
          {t('tasks.commentsLabel')}
        </span>
        <CommentThread
          taskId={task.id}
          currentExpertId={task.expert_id}
          filterSystem
        />
      </div>
    </div>
  );

  // Activity content: read-only chronological timeline of all events.
  const activityContent = (
    <div className="p-5 overflow-y-auto">
      <ActivityTimeline taskId={task.id} />
    </div>
  );

  // Focus-mode left panel mirrors the compact Details content.
  const focusLeftPanel = (
    <div className="flex flex-col min-h-0 overflow-y-auto">
      {detailsContent}
    </div>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-30" onClick={onClose} />

      <div
        className={clsx(
          'app-no-drag fixed inset-y-0 right-0 z-40 flex flex-col',
          'bg-bg-base border-l border-border-subtle shadow-2xl',
          'transition-[width] duration-200 ease-out',
          isFullWidth ? 'w-full' : 'w-[60%] min-w-[480px] max-w-[800px]',
        )}
      >
        {renderHeader()}

        <TaskArtifactStrip
          taskId={task.id}
          projectPath={task.project_path}
          runId={task.run_id}
          onOpenFile={() => setActiveTab('preview')}
        />

        {isFullWidth ? (
          // ── Focus Mode: 3-panel split ──
          <div className="flex-1 min-h-0 flex">
            {/* Details panel (30%) */}
            <div className="w-[30%] min-w-[320px] max-w-[480px] border-r border-border-subtle flex flex-col min-h-0">
              {focusLeftPanel}
            </div>
            {/* Console panel (40%) */}
            <div className="flex-1 border-r border-border-subtle min-w-0 min-h-0">
              {consolePanel}
            </div>
            {/* Preview panel (30%) */}
            <div className="w-[30%] min-w-[320px] max-w-[520px] min-h-0">
              <LivePreview taskId={task.id} runId={consoleRunId} isRunning={isRunning} projectPath={task.project_path} />
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
                  {consolePanel}
                </div>
              )}
              {activeTab === 'preview' && (
                <div className="flex-1 min-h-0">
                  <LivePreview taskId={task.id} runId={consoleRunId} isRunning={isRunning} projectPath={task.project_path} />
                </div>
              )}
              {activeTab === 'activity' && activityContent}
            </div>
          </>
        )}
      </div>

      {showDeleteConfirm && task && (
        <AlertModal
          icon={<Trash2 size={18} className="text-red-400" />}
          iconTone="danger"
          title={t('tasks.deleteTaskTitle')}
          message={t('tasks.deleteTaskMessage', { title: task.title })}
          onClose={() => setShowDeleteConfirm(false)}
          actions={[
            { label: t('common.cancel'), onClick: () => setShowDeleteConfirm(false) },
            {
              label: t('common.delete'),
              primary: true,
              variant: 'danger',
              onClick: confirmDelete,
            },
          ]}
        />
      )}
    </>
  );
}
