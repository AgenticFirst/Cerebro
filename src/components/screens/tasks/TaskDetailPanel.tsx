import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Square, Play, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useTasks } from '../../../context/TaskContext';
import { STATUS_CONFIG, formatElapsed } from './helpers';
import TaskPlanView from './TaskPlanView';
import TaskConsoleView from './TaskConsoleView';
import TaskDeliverableView from './TaskDeliverableView';
import TaskClarificationPanel from './TaskClarificationPanel';
import TaskWorkspaceView from './TaskWorkspaceView';
import TaskPreviewView from './TaskPreviewView';
import type { TaskDetail } from './types';

interface TaskDetailPanelProps {
  taskId: string;
}

type TabId = 'plan' | 'console' | 'deliverable' | 'workspace' | 'preview';

export default function TaskDetailPanel({ taskId }: TaskDetailPanelProps) {
  const { t } = useTranslation();
  const { tasks, liveTask, cancelTask, deleteTask, approvePlan, watchTask, unwatchTask } = useTasks();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('plan');
  const [approving, setApproving] = useState(false);

  const task = tasks.find((tk) => tk.id === taskId) ?? null;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await window.cerebro.invoke<TaskDetail>({
        method: 'GET',
        path: `/tasks/${taskId}`,
      });
      if (!cancelled && res.ok) setDetail(res.data);
    };
    load();
    return () => { cancelled = true; };
  }, [taskId, task?.status]);

  useEffect(() => {
    if (task) watchTask(taskId);
    return () => unwatchTask();
  }, [taskId, task?.status]);

  // Auto-switch to preview tab once when deliverableKind becomes code_app/mixed.
  // Uses a ref for activeTab so the effect fires only on deliverableKind changes,
  // not on every tab navigation (which would re-yank the user to preview).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  useEffect(() => {
    if (
      liveTask?.taskId === taskId &&
      (liveTask.deliverableKind === 'code_app' || liveTask.deliverableKind === 'mixed') &&
      activeTabRef.current === 'plan' &&
      task?.status === 'running'
    ) {
      setActiveTab('preview');
    }
  }, [liveTask?.deliverableKind, liveTask?.taskId, taskId, task?.status]);

  // When the task is awaiting plan approval, pull the user to the Plan tab
  // so they can review the checklist before approving.
  const awaitingApproval = task?.status === 'awaiting_plan_approval';
  useEffect(() => {
    if (awaitingApproval) setActiveTab('plan');
  }, [awaitingApproval]);

  useEffect(() => {
    if (liveTask && liveTask.taskId === taskId) {
      const timer = setInterval(() => {
        window.cerebro.invoke<TaskDetail>({
          method: 'GET',
          path: `/tasks/${taskId}`,
        }).then((res) => {
          if (res.ok) setDetail(res.data);
        });
      }, 3000);
      return () => clearInterval(timer);
    }
  }, [taskId, liveTask?.taskId]);

  const handleCancel = useCallback(async () => {
    await cancelTask(taskId);
  }, [cancelTask, taskId]);

  const handleDelete = useCallback(async () => {
    await deleteTask(taskId);
  }, [deleteTask, taskId]);

  const handleApprove = useCallback(async () => {
    setApproving(true);
    try {
      await approvePlan(taskId);
    } finally {
      setApproving(false);
    }
  }, [approvePlan, taskId]);

  // Derive values safely before any early returns so hook count is stable
  const style = task ? (STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending) : STATUS_CONFIG.pending;
  const isActive = task != null && (task.status === 'running' || task.status === 'clarifying' || task.status === 'planning');
  const isTerminal = task != null && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled');
  const showClarification = task?.status === 'awaiting_clarification';

  const hasWorkspace = task != null && (task.deliverable_kind === 'code_app' || task.deliverable_kind === 'mixed');
  // Show preview tab during execution (even before deliverable_kind is known)
  // or for completed code_app/mixed tasks
  const showPreview = hasWorkspace || isActive;
  const tabs = useMemo<Array<{ id: TabId; label: string }>>(() => [
    { id: 'plan', label: t('taskDetail.tabPlan') },
    { id: 'console', label: t('taskDetail.tabConsole') },
    { id: 'deliverable', label: t('taskDetail.tabDeliverable') },
    ...(hasWorkspace ? [
      { id: 'workspace' as const, label: t('taskDetail.tabWorkspace') },
    ] : []),
    ...(showPreview ? [
      { id: 'preview' as const, label: t('taskDetail.tabPreview') },
    ] : []),
  ], [t, hasWorkspace, showPreview]);

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        {t('taskDetail.taskNotFound')}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-5 pt-4 pb-3 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-text-primary truncate flex-1 mr-4">
            {task.title}
          </h2>
          <div className="flex items-center gap-1.5">
            {awaitingApproval && (
              <button
                onClick={handleApprove}
                disabled={approving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
                title={t('taskDetail.approveAndExecute')}
              >
                {approving
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Play size={12} />}
                {t('taskDetail.approveAndExecute')}
              </button>
            )}
            {isActive && (
              <button
                onClick={handleCancel}
                className="p-1.5 rounded-md hover:bg-bg-secondary text-text-tertiary hover:text-red-400 transition-colors cursor-pointer"
                title={t('taskDetail.cancelTask')}
              >
                <Square size={14} />
              </button>
            )}
            {isTerminal && (
              <button
                onClick={handleDelete}
                className="p-1.5 rounded-md hover:bg-bg-secondary text-text-tertiary hover:text-red-400 transition-colors cursor-pointer"
                title={t('taskDetail.deleteTask')}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>

        <p className="text-xs text-text-tertiary line-clamp-2 mb-2">{task.goal}</p>

        <div className="flex items-center gap-3 text-xs">
          <span className={clsx('flex items-center gap-1.5', style.text)}>
            <span
              className={clsx('w-1.5 h-1.5 rounded-full', style.dot)}
              style={style.glow ? { boxShadow: '0 0 6px currentColor' } : undefined}
            />
            {style.label}
          </span>
          {(task.started_at || task.completed_at) && (
            <span className="text-text-tertiary">
              {formatElapsed(task.started_at, task.completed_at)}
            </span>
          )}
        </div>
      </div>

      {/* Clarification overlay */}
      {showClarification && task.clarifications?.questions ? (
        <TaskClarificationPanel
          taskId={taskId}
          questions={task.clarifications.questions}
          goal={task.goal}
        />
      ) : (
        <>
          {/* Tabs */}
          <div className="px-5 pt-2 flex gap-4 border-b border-border-subtle">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={clsx(
                  'pb-2 text-sm font-medium border-b-2 transition-colors cursor-pointer',
                  activeTab === tab.id
                    ? 'border-accent text-text-primary'
                    : 'border-transparent text-text-tertiary hover:text-text-secondary',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — Console and Preview manage their own scroll */}
          <div className={clsx(
            'flex-1 min-h-0',
            activeTab === 'console' || activeTab === 'preview'
              ? 'flex flex-col'
              : 'overflow-y-auto',
          )}>
            {activeTab === 'plan' && (
              <TaskPlanView task={task} liveTask={liveTask} />
            )}
            {activeTab === 'console' && (
              <TaskConsoleView task={task} liveTask={liveTask} />
            )}
            {activeTab === 'deliverable' && (
              <TaskDeliverableView task={task} detail={detail} />
            )}
            {activeTab === 'workspace' && hasWorkspace && (
              <TaskWorkspaceView task={task} />
            )}
            {activeTab === 'preview' && showPreview && (
              <TaskPreviewView task={task} detail={detail} liveTask={liveTask} />
            )}
          </div>

        </>
      )}
    </div>
  );
}
