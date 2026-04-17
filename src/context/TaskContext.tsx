import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { stripMentionSyntax } from '../lib/mentions';

export interface Task {
  id: string;
  title: string;
  description_md: string;
  column: TaskColumn;
  expert_id: string | null;
  parent_task_id: string | null;
  priority: TaskPriority;
  start_at: string | null;
  due_at: string | null;
  position: number;
  run_id: string | null;
  last_error: string | null;
  project_path: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  checklist: ChecklistItem[];
  comment_count: number;
  checklist_total: number;
  checklist_done: number;
}

export type TaskColumn =
  | 'backlog'
  | 'in_progress'
  | 'to_review'
  | 'completed'
  | 'error';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface ChecklistItem {
  id: string;
  task_id: string;
  body: string;
  is_done: boolean;
  position: number;
  promoted_task_id: string | null;
  created_at: string;
}

export interface TaskComment {
  id: string;
  task_id: string;
  kind: 'comment' | 'instruction' | 'system';
  author_kind: 'user' | 'expert' | 'system';
  expert_id: string | null;
  body_md: string;
  triggered_run_id: string | null;
  queue_status: 'pending' | 'delivered' | 'discarded' | null;
  pending_expert_id: string | null;
  created_at: string;
}

export interface FailurePrompt {
  taskId: string;
  taskTitle: string;
  comment: TaskComment;
  targetExpertId: string | null;
  failureReason: string;
}

export interface TaskStats {
  backlog: number;
  in_progress: number;
  to_review: number;
  completed: number;
  error: number;
}

interface CreateTaskInput {
  title: string;
  description_md?: string;
  column?: TaskColumn;
  expert_id?: string | null;
  parent_task_id?: string | null;
  priority?: TaskPriority;
  start_at?: string | null;
  due_at?: string | null;
  project_path?: string | null;
  tags?: string[];
}

interface UpdateTaskInput {
  title?: string;
  description_md?: string;
  expert_id?: string | null;
  priority?: TaskPriority;
  start_at?: string | null;
  due_at?: string | null;
  project_path?: string | null;
  tags?: string[];
}

interface TaskContextValue {
  tasks: Task[];
  stats: TaskStats;
  isLoading: boolean;
  loadTasks: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  updateTask: (id: string, input: UpdateTaskInput) => Promise<void>;
  moveTask: (id: string, column: TaskColumn, position?: number) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  /** Start the Expert working on a task — spawns Claude Code, moves card to In Progress. */
  startTask: (id: string) => Promise<void>;
  /**
   * Post an instruction comment. If the task is currently running, the
   * instruction is queued (drained when the run ends). Otherwise it triggers
   * a follow-up run immediately, reassigning first if targetExpertId differs
   * from the task's current expert.
   */
  sendInstruction: (id: string, instruction: string, targetExpertId: string | null) => Promise<void>;
  /** Flip a pending queued instruction to `discarded`; user cancels the handoff. */
  discardQueuedInstruction: (taskId: string, commentId: string) => Promise<void>;
  /** Pending failure prompts triggered when a run ended while an instruction was queued. */
  pendingFailurePrompts: FailurePrompt[];
  /** User confirmed the failure prompt — drain the queued instruction as a fresh run. */
  confirmFailurePrompt: (taskId: string) => Promise<void>;
  /** User dismissed the failure prompt — discard the queued instruction. */
  dismissFailurePrompt: (taskId: string) => Promise<void>;
  loadComments: (taskId: string) => Promise<TaskComment[]>;
  addComment: (taskId: string, kind: string, bodyMd: string) => Promise<TaskComment>;
  addChecklistItem: (taskId: string, body: string) => Promise<ChecklistItem>;
  updateChecklistItem: (taskId: string, itemId: string, updates: Partial<ChecklistItem>) => Promise<void>;
  deleteChecklistItem: (taskId: string, itemId: string) => Promise<void>;
  promoteChecklistItem: (taskId: string, itemId: string) => Promise<Task>;
  /** Get the active internal Electron runId for a task (may differ from task.run_id on re-runs). */
  getActiveRunId: (taskId: string) => string | null;
}

const TaskContext = createContext<TaskContextValue | null>(null);

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<TaskStats>({
    backlog: 0,
    in_progress: 0,
    to_review: 0,
    completed: 0,
    error: 0,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [pendingFailurePrompts, setPendingFailurePrompts] = useState<FailurePrompt[]>([]);

  // Map of taskId -> unsubscribe function for agent event listeners.
  // Persists across renders so listeners aren't leaked on re-render.
  const runListeners = useRef<Map<string, () => void>>(new Map());

  // Map of taskId -> internal Electron runId. On retries, task.run_id is pinned
  // to the ORIGINAL Claude session, so we can't use it to cancel the live run.
  const activeInternalRunIds = useRef<Map<string, string>>(new Map());

  // Monotonic counter so rapid drag-drops don't race: only the latest
  // moveTask call's loadTasks result is applied.
  const moveSeq = useRef(0);

  // Forward ref to break the cycle:
  //   registerRunListener → handleRunTerminated → drainQueuedInstruction → registerRunListener
  // Listeners only need the *latest* version of handleRunTerminated; sync via useEffect.
  const handleTermRef = useRef<
    | ((taskId: string, runId: string, outcome: 'done' | 'error' | 'cancelled', error?: string) => Promise<void>)
    | null
  >(null);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    try {
      const [tasksRes, statsRes] = await Promise.all([
        window.cerebro.invoke({ method: 'GET', path: '/tasks' }),
        window.cerebro.invoke({ method: 'GET', path: '/tasks/stats' }),
      ]);
      if (tasksRes.ok) setTasks(tasksRes.data);
      if (statsRes.ok) setStats(statsRes.data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // Clean up all event listeners on unmount
  useEffect(() => {
    const listeners = runListeners.current;
    return () => {
      for (const unsub of listeners.values()) {
        try { unsub(); } catch { /* noop */ }
      }
      listeners.clear();
    };
  }, []);

  const createTask = useCallback(async (input: CreateTaskInput): Promise<Task> => {
    const res = await window.cerebro.invoke({
      method: 'POST',
      path: '/tasks',
      body: input,
    });
    if (!res.ok) {
      const detail = (res.data as { detail?: string } | null)?.detail;
      throw new Error(detail || 'Failed to create task');
    }
    await loadTasks();
    return res.data as Task;
  }, [loadTasks]);

  const updateTask = useCallback(async (id: string, input: UpdateTaskInput) => {
    const res = await window.cerebro.invoke({
      method: 'PATCH',
      path: `/tasks/${id}`,
      body: input,
    });
    if (!res.ok) {
      const detail = (res.data as { detail?: string } | null)?.detail;
      throw new Error(detail || 'Failed to update task');
    }
    await loadTasks();
  }, [loadTasks]);

  const moveTask = useCallback(async (id: string, column: TaskColumn, position?: number) => {
    const seq = ++moveSeq.current;
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, column, position: position ?? t.position } : t)),
    );
    const res = await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${id}/move`,
      body: { column, position },
    });
    if (seq !== moveSeq.current) return;
    if (!res.ok) {
      await loadTasks();
      throw new Error('Failed to move task');
    }
    await loadTasks();
  }, [loadTasks]);

  const deleteTask = useCallback(async (id: string) => {
    // Find the task to get its run_id for terminal buffer cleanup
    const task = tasks.find((t) => t.id === id);
    // Clean up active listener
    const unsub = runListeners.current.get(id);
    if (unsub) {
      unsub();
      runListeners.current.delete(id);
    }
    const internalRunId = activeInternalRunIds.current.get(id) ?? task?.run_id;
    activeInternalRunIds.current.delete(id);
    // Kill any active run
    if (internalRunId) {
      try { await window.cerebro.agent.cancel(internalRunId); } catch { /* noop */ }
    }
    const res = await window.cerebro.invoke({
      method: 'DELETE',
      path: `/tasks/${id}`,
    });
    if (!res.ok) throw new Error('Failed to delete task');
    // Permanent cleanup: workspace files + terminal buffer
    await Promise.all([
      window.cerebro.taskTerminal.removeWorkspace(id).catch(() => { /* noop */ }),
      task?.run_id
        ? window.cerebro.taskTerminal.removeBuffer(task.run_id).catch(() => { /* noop */ })
        : Promise.resolve(),
    ]);
    // FK cascade drops the comments backend-side, but local prompt state
    // must match — otherwise a modal would linger pointing at a dead task.
    setPendingFailurePrompts((prev) => prev.filter((p) => p.taskId !== id));
    await loadTasks();
  }, [loadTasks, tasks]);

  const loadComments = useCallback(async (taskId: string): Promise<TaskComment[]> => {
    const res = await window.cerebro.invoke({
      method: 'GET',
      path: `/tasks/${taskId}/comments`,
    });
    return res.ok ? res.data : [];
  }, []);

  const cancelTask = useCallback(async (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (task?.run_id) {
      // Tear down the listener BEFORE cancelling + routing through handleTermRef.
      // Otherwise a late `done`/`error` event from the PTY can fire after cancel
      // and double-post run_completed / double-drain the queued instruction.
      const unsub = runListeners.current.get(id);
      if (unsub) {
        unsub();
        runListeners.current.delete(id);
      }
      // task.run_id may be an older session (on retries). Use the internal
      // runId the runtime knows about to actually kill the PTY.
      const internalRunId = activeInternalRunIds.current.get(id) ?? task.run_id;
      activeInternalRunIds.current.delete(id);
      try {
        await window.cerebro.agent.cancel(internalRunId);
      } catch (err) {
        console.warn('[task] Failed to cancel agent run:', err);
      }
      // Route through the ref so cancel = failure for the queue (prompt surfaces
      // if an instruction was pending).
      await handleTermRef.current?.(id, task.run_id, 'cancelled');
    } else {
      const res = await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${id}/cancel`,
      });
      if (!res.ok) throw new Error('Failed to cancel task');
      await loadTasks();
    }
  }, [tasks, loadTasks]);

  const registerRunListener = useCallback((taskId: string, runId: string, reportedRunId?: string) => {
    // Clean up any prior listener for this task
    const prior = runListeners.current.get(taskId);
    if (prior) prior();

    // reportedRunId is what the backend knows as task.run_id (the original
    // Claude session on retries). Fall back to the internal runId for fresh runs.
    const backendRunId = reportedRunId ?? runId;
    activeInternalRunIds.current.set(taskId, runId);
    const unsub = window.cerebro.agent.onEvent(runId, async (event) => {
      if (event.type === 'done') {
        await handleTermRef.current?.(taskId, backendRunId, 'done');
      } else if (event.type === 'error') {
        await handleTermRef.current?.(taskId, backendRunId, 'error', event.error);
      }
    });
    runListeners.current.set(taskId, unsub);
  }, []);

  // Precedence: explicit task.project_path > hidden per-task workspace fallback.
  const resolveCwd = useCallback(async (task: Task): Promise<string> => {
    if (task.project_path && task.project_path.trim()) {
      return task.project_path;
    }
    return window.cerebro.taskTerminal.createWorkspace(task.id);
  }, []);

  // Helpers: build the direct-execution prompt from a task's fields.
  const buildDirectPrompt = useCallback((
    task: Task,
    instructionComments: TaskComment[],
  ): string => {
    const lines: string[] = [];
    lines.push(`Title: ${task.title}`);
    if (task.description_md?.trim()) {
      lines.push('', '## Description', task.description_md.trim());
    }
    const openItems = task.checklist.filter((i) => !i.is_done);
    if (openItems.length > 0) {
      lines.push('', '## Checklist', ...openItems.map((i) => `- [ ] ${i.body}`));
    }
    if (instructionComments.length > 0) {
      lines.push('', '## Previous instructions from the user');
      for (const c of instructionComments) {
        lines.push(`- ${stripMentionSyntax(c.body_md.trim(), [])}`);
      }
    }
    return lines.join('\n');
  }, []);

  // Build a comprehensive follow-up context so a (possibly newly-assigned)
  // expert has the whole task history — description, checklist state, all
  // prior comments including system events (like "Reassigned to QA").
  const buildFullHistoryContext = useCallback((
    task: Task,
    allComments: TaskComment[],
    excludeCommentId: string | null,
  ): string => {
    const lines: string[] = [];
    lines.push(`Task title: ${task.title}`);
    if (task.description_md?.trim()) {
      lines.push('', '## Description', task.description_md.trim());
    }
    if (task.checklist.length > 0) {
      lines.push('', '## Checklist');
      for (const item of task.checklist) {
        const mark = item.is_done ? '[x]' : '[ ]';
        lines.push(`- ${mark} ${item.body}`);
      }
    }
    const history = allComments.filter((c) => c.id !== excludeCommentId);
    if (history.length > 0) {
      lines.push('', '## History');
      for (const c of history) {
        const when = c.created_at;
        const actor =
          c.kind === 'system'
            ? 'System'
            : c.author_kind === 'user'
              ? 'User'
              : 'Expert';
        const label = c.kind === 'instruction' ? `${actor} (instruction)` : actor;
        const body = stripMentionSyntax(c.body_md.trim(), []);
        lines.push(`- ${when} · ${label}: ${body}`);
      }
    }
    return lines.join('\n');
  }, []);

  const startTask = useCallback(async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    try {
      const [allComments, workspacePath] = await Promise.all([
        loadComments(taskId),
        resolveCwd(task),
      ]);
      const instructions = allComments.filter((c) => c.kind === 'instruction');
      const prompt = buildDirectPrompt(task, instructions);
      // Resume the prior Claude Code session on retry/rerun — preserves
      // the agent's file state and conversation so it can pick up where it
      // stopped (especially when a prior run exited without a deliverable).
      const resumeSessionId = task.run_id || undefined;

      // Clear stale terminal buffer from the previous run so the console
      // starts fresh when ExpertConsole re-mounts with the new runId.
      if (resumeSessionId) {
        window.cerebro.taskTerminal.removeBuffer(resumeSessionId).catch(() => {});
      }

      const runId = await window.cerebro.agent.run({
        conversationId: taskId,
        content: prompt,
        expertId: task.expert_id,
        runType: 'task',
        taskPhase: 'direct',
        workspacePath,
        maxTurns: 30,
        resumeSessionId,
      });

      // Pin task.run_id to the original Claude Code session on retries so
      // subsequent retries keep resuming the same session. Internally, the
      // Electron runId is still used for IPC/event routing and registerRunListener.
      const reportedRunId = resumeSessionId ?? runId;
      await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${taskId}/run-event`,
        body: { type: 'run_started', run_id: reportedRunId },
      });

      registerRunListener(taskId, runId, reportedRunId);
      await loadTasks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await window.cerebro
        .invoke({
          method: 'POST',
          path: `/tasks/${taskId}/run-event`,
          body: { type: 'run_failed', run_id: null, error: `Failed to start: ${message}` },
        })
        .catch(() => { /* noop */ });
      await loadTasks();
      throw err;
    }
  }, [tasks, loadComments, buildDirectPrompt, registerRunListener, loadTasks, resolveCwd]);

  const spawnFollowUpRun = useCallback(async (
    task: Task,
    instruction: string,
    excludeCommentId: string | null,
  ): Promise<string> => {
    const [allComments, workspacePath] = await Promise.all([
      loadComments(task.id),
      resolveCwd(task),
    ]);
    const followUpContext = buildFullHistoryContext(task, allComments, excludeCommentId);
    const agentContent = stripMentionSyntax(instruction, []);
    // Resume the prior Claude Code session on follow-up so the agent keeps
    // its full context and file awareness from the prior deliverable.
    const resumeSessionId = task.run_id || undefined;

    if (resumeSessionId) {
      window.cerebro.taskTerminal.removeBuffer(resumeSessionId).catch(() => {});
    }

    const runId = await window.cerebro.agent.run({
      conversationId: task.id,
      content: agentContent,
      expertId: task.expert_id,
      runType: 'task',
      taskPhase: 'follow_up',
      workspacePath,
      followUpContext,
      maxTurns: 30,
      resumeSessionId,
    });

    const reportedRunId = resumeSessionId ?? runId;
    await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${task.id}/run-event`,
      body: { type: 'run_started', run_id: reportedRunId },
    });

    registerRunListener(task.id, runId, reportedRunId);
    return runId;
  }, [loadComments, resolveCwd, buildFullHistoryContext, registerRunListener]);

  const pushFailurePrompt = useCallback((entry: FailurePrompt) => {
    setPendingFailurePrompts((prev) => [
      ...prev.filter((p) => p.taskId !== entry.taskId),
      entry,
    ]);
  }, []);

  const patchQueueStatus = useCallback(async (
    taskId: string,
    commentId: string,
    status: 'delivered' | 'discarded',
  ): Promise<boolean> => {
    try {
      const res = await window.cerebro.invoke({
        method: 'PATCH',
        path: `/tasks/${taskId}/comments/${commentId}/queue-status`,
        body: { queue_status: status },
      });
      return res.ok;
    } catch (err) {
      console.warn(`[task] Failed to set queue_status=${status}:`, err);
      return false;
    }
  }, []);

  const drainQueuedInstruction = useCallback(async (task: Task, comment: TaskComment) => {
    const taskId = task.id;
    const reassignTo = comment.pending_expert_id;
    let workingTask: Task = task;

    if (reassignTo && reassignTo !== task.expert_id) {
      try {
        await updateTask(taskId, { expert_id: reassignTo });
        workingTask = { ...task, expert_id: reassignTo };
      } catch (err) {
        console.warn('[task] Failed to reassign during drain:', err);
      }
    }

    try {
      await spawnFollowUpRun(workingTask, comment.body_md, comment.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await patchQueueStatus(taskId, comment.id, 'discarded');
      pushFailurePrompt({
        taskId,
        taskTitle: workingTask.title,
        comment,
        targetExpertId: comment.pending_expert_id ?? workingTask.expert_id,
        failureReason: `Failed to start queued run: ${message}`,
      });
      await loadTasks();
      return;
    }

    await patchQueueStatus(taskId, comment.id, 'delivered');
    await loadTasks();
  }, [updateTask, spawnFollowUpRun, pushFailurePrompt, patchQueueStatus, loadTasks]);

  const discardQueuedInstruction = useCallback(async (taskId: string, commentId: string) => {
    await patchQueueStatus(taskId, commentId, 'discarded');
    // Scrub any failure prompt for this task so the modal doesn't linger.
    setPendingFailurePrompts((prev) => prev.filter((p) => p.taskId !== taskId));
    await loadTasks();
  }, [patchQueueStatus, loadTasks]);

  const handleRunTerminated = useCallback(async (
    taskId: string,
    runId: string,
    outcome: 'done' | 'error' | 'cancelled',
    error?: string,
  ): Promise<void> => {
    const eventType =
      outcome === 'done' ? 'run_completed'
        : outcome === 'error' ? 'run_failed'
          : 'run_cancelled';
    try {
      await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${taskId}/run-event`,
        body: {
          type: eventType,
          run_id: runId,
          ...(error ? { error } : {}),
        },
      });
    } catch (err) {
      console.warn(`[task] Failed to post ${eventType}:`, err);
    }

    // Tear down the listener (idempotent — registerRunListener clears prior).
    const u = runListeners.current.get(taskId);
    if (u) u();
    runListeners.current.delete(taskId);
    activeInternalRunIds.current.delete(taskId);

    // Look for a pending queued instruction tied to this task.
    let pending: TaskComment | null = null;
    let freshTask: Task | null = null;
    try {
      const allComments = await loadComments(taskId);
      pending = allComments.find((c) => c.queue_status === 'pending') ?? null;
      if (pending) {
        const taskRes = await window.cerebro.invoke({ method: 'GET', path: `/tasks/${taskId}` });
        if (taskRes.ok) freshTask = taskRes.data as Task;
      }
    } catch (err) {
      console.warn('[task] Failed to check queued instruction on termination:', err);
    }

    if (pending && freshTask) {
      if (outcome === 'done') {
        await drainQueuedInstruction(freshTask, pending);
        return;
      }
      pushFailurePrompt({
        taskId,
        taskTitle: freshTask.title,
        comment: pending,
        targetExpertId: pending.pending_expert_id ?? freshTask.expert_id,
        failureReason: error ?? (outcome === 'cancelled' ? 'Run was cancelled' : 'Run failed'),
      });
    }

    await loadTasks();
  }, [loadTasks, loadComments, drainQueuedInstruction, pushFailurePrompt]);

  // Keep the ref pointing at the latest handler so the stable onEvent closure
  // always invokes fresh state/deps.
  useEffect(() => {
    handleTermRef.current = handleRunTerminated;
  }, [handleRunTerminated]);

  // Orphan recovery: on mount, mark any in_progress task whose run is no
  // longer active as failed, then surface any queued instructions stranded by
  // a crash/close mid-run.
  useEffect(() => {
    let cancelled = false;
    const recover = async () => {
      try {
        const [activeRuns, tasksNow] = await Promise.all([
          window.cerebro.agent.activeRuns(),
          window.cerebro.invoke({ method: 'GET', path: '/tasks' }),
        ]);
        if (cancelled || !tasksNow.ok) return;
        const activeRunIds = new Set(activeRuns.map((r) => r.runId));
        const list = tasksNow.data as Task[];

        const staleRuns = list.filter(
          (t) => t.column === 'in_progress' && t.run_id && !activeRunIds.has(t.run_id),
        );
        if (staleRuns.length > 0) {
          await Promise.all(staleRuns.map((t) =>
            window.cerebro.invoke({
              method: 'POST',
              path: `/tasks/${t.id}/run-event`,
              body: {
                type: 'run_failed',
                run_id: t.run_id,
                error: 'Run was interrupted by app restart',
              },
            }).catch(() => { /* noop */ }),
          ));
        }

        if (cancelled) return;

        const refreshed = staleRuns.length > 0
          ? await window.cerebro.invoke({ method: 'GET', path: '/tasks' })
          : tasksNow;
        if (cancelled) return;
        const refreshedList = refreshed.ok ? (refreshed.data as Task[]) : list;

        // Scan all terminally-stated tasks in parallel for a pending queued comment.
        const scanTargets = refreshedList.filter(
          (t) => !(t.column === 'in_progress' && t.run_id && activeRunIds.has(t.run_id)),
        );
        const scans = await Promise.all(
          scanTargets.map(async (t) => {
            try {
              const comments = await loadComments(t.id);
              const pending = comments.find((c) => c.queue_status === 'pending') ?? null;
              return pending ? { task: t, pending } : null;
            } catch {
              return null;
            }
          }),
        );

        if (cancelled) return;

        for (const entry of scans) {
          if (cancelled || !entry) continue;
          const { task: t, pending } = entry;
          if (t.column === 'to_review' || t.column === 'completed') {
            await drainQueuedInstruction(t, pending);
          } else {
            pushFailurePrompt({
              taskId: t.id,
              taskTitle: t.title,
              comment: pending,
              targetExpertId: pending.pending_expert_id ?? t.expert_id,
              failureReason: t.last_error ?? 'Run did not complete successfully',
            });
          }
        }

        if (!cancelled && staleRuns.length > 0) await loadTasks();
      } catch (err) {
        console.warn('[task] Orphan recovery failed:', err);
      }
    };
    recover();
    return () => { cancelled = true; };
  }, [loadTasks, loadComments, drainQueuedInstruction, pushFailurePrompt]);

  const confirmFailurePrompt = useCallback(async (taskId: string) => {
    const prompt = pendingFailurePrompts.find((p) => p.taskId === taskId);
    if (!prompt) return;
    const taskRes = await window.cerebro.invoke({ method: 'GET', path: `/tasks/${taskId}` });
    if (!taskRes.ok) return;
    // Drop the prompt only after fetch succeeds — else a failed fetch would
    // orphan the queued comment with no way to retry.
    setPendingFailurePrompts((prev) => prev.filter((p) => p.taskId !== taskId));
    await drainQueuedInstruction(taskRes.data as Task, prompt.comment);
  }, [pendingFailurePrompts, drainQueuedInstruction]);

  const dismissFailurePrompt = useCallback(async (taskId: string) => {
    const prompt = pendingFailurePrompts.find((p) => p.taskId === taskId);
    if (!prompt) return;
    await discardQueuedInstruction(taskId, prompt.comment.id);
  }, [pendingFailurePrompts, discardQueuedInstruction]);

  const sendInstruction = useCallback(async (
    taskId: string,
    instruction: string,
    targetExpertId: string | null,
  ) => {
    // Re-fetch — the local list lags real-time run state, and the queue-vs-spawn
    // decision hinges on whether a run is active right now.
    const freshRes = await window.cerebro.invoke({
      method: 'GET',
      path: `/tasks/${taskId}`,
    });
    if (!freshRes.ok) throw new Error(`Task ${taskId} not found`);
    const task = freshRes.data as Task;

    const isRunning = task.column === 'in_progress' && !!task.run_id;
    const needsReassign = !!targetExpertId && targetExpertId !== task.expert_id;

    if (isRunning) {
      // Queue path — no agent.run, reassign deferred to drain time.
      const res = await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${taskId}/comments`,
        body: {
          kind: 'instruction',
          body_md: instruction,
          queue_status: 'pending',
          pending_expert_id: needsReassign ? targetExpertId : null,
        },
      });
      if (!res.ok) {
        const detail = (res.data as { detail?: string } | null)?.detail;
        throw new Error(detail || 'Failed to queue instruction');
      }
      await loadTasks();
      return;
    }

    if (needsReassign) {
      await updateTask(taskId, { expert_id: targetExpertId! });
    }
    const workingTask: Task = needsReassign
      ? { ...task, expert_id: targetExpertId }
      : task;

    // Persist the instruction comment before spawning so the thread shows it
    // immediately and the record survives a spawn failure.
    const newCommentRes = await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${taskId}/comments`,
      body: { kind: 'instruction', body_md: instruction },
    });
    const newCommentId: string | null =
      newCommentRes.ok && newCommentRes.data ? (newCommentRes.data as TaskComment).id : null;

    await spawnFollowUpRun(workingTask, instruction, newCommentId);
    await loadTasks();
  }, [updateTask, spawnFollowUpRun, loadTasks]);

  const addComment = useCallback(async (taskId: string, kind: string, bodyMd: string): Promise<TaskComment> => {
    const res = await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${taskId}/comments`,
      body: { kind, body_md: bodyMd },
    });
    if (!res.ok) throw new Error('Failed to add comment');
    return res.data;
  }, []);

  const addChecklistItem = useCallback(async (taskId: string, body: string): Promise<ChecklistItem> => {
    const res = await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${taskId}/checklist`,
      body: { body },
    });
    if (!res.ok) throw new Error('Failed to add checklist item');
    await loadTasks();
    return res.data;
  }, [loadTasks]);

  const updateChecklistItem = useCallback(async (taskId: string, itemId: string, updates: Partial<ChecklistItem>) => {
    const res = await window.cerebro.invoke({
      method: 'PATCH',
      path: `/tasks/${taskId}/checklist/${itemId}`,
      body: updates,
    });
    if (!res.ok) throw new Error('Failed to update checklist item');
    await loadTasks();
  }, [loadTasks]);

  const deleteChecklistItem = useCallback(async (taskId: string, itemId: string) => {
    const res = await window.cerebro.invoke({
      method: 'DELETE',
      path: `/tasks/${taskId}/checklist/${itemId}`,
    });
    if (!res.ok) throw new Error('Failed to delete checklist item');
    await loadTasks();
  }, [loadTasks]);

  const promoteChecklistItem = useCallback(async (taskId: string, itemId: string): Promise<Task> => {
    const res = await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${taskId}/checklist/${itemId}/promote`,
    });
    if (!res.ok) throw new Error('Failed to promote checklist item');
    await loadTasks();
    return res.data;
  }, [loadTasks]);

  const getActiveRunId = useCallback((taskId: string): string | null => {
    return activeInternalRunIds.current.get(taskId)
      ?? tasks.find((t) => t.id === taskId)?.run_id
      ?? null;
  }, [tasks]);

  return (
    <TaskContext.Provider
      value={{
        tasks,
        stats,
        isLoading,
        loadTasks,
        createTask,
        updateTask,
        moveTask,
        deleteTask,
        cancelTask,
        startTask,
        sendInstruction,
        discardQueuedInstruction,
        pendingFailurePrompts,
        confirmFailurePrompt,
        dismissFailurePrompt,
        loadComments,
        addComment,
        addChecklistItem,
        updateChecklistItem,
        deleteChecklistItem,
        promoteChecklistItem,
        getActiveRunId,
      }}
    >
      {children}
    </TaskContext.Provider>
  );
}

export function useTasks(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTasks must be used within TaskProvider');
  return ctx;
}
