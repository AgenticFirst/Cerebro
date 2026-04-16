import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

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
  created_at: string;
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
  /** Post an instruction comment AND trigger a follow-up Expert run in the same workspace. */
  sendInstruction: (id: string, instruction: string) => Promise<void>;
  loadComments: (taskId: string) => Promise<TaskComment[]>;
  addComment: (taskId: string, kind: string, bodyMd: string) => Promise<TaskComment>;
  addChecklistItem: (taskId: string, body: string) => Promise<ChecklistItem>;
  updateChecklistItem: (taskId: string, itemId: string, updates: Partial<ChecklistItem>) => Promise<void>;
  deleteChecklistItem: (taskId: string, itemId: string) => Promise<void>;
  promoteChecklistItem: (taskId: string, itemId: string) => Promise<Task>;
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

  // Map of taskId -> unsubscribe function for agent event listeners.
  // Persists across renders so listeners aren't leaked on re-render.
  const runListeners = useRef<Map<string, () => void>>(new Map());

  // Monotonic counter so rapid drag-drops don't race: only the latest
  // moveTask call's loadTasks result is applied.
  const moveSeq = useRef(0);

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

  // Orphan recovery: on mount, find any in_progress tasks whose runs are no longer
  // active (e.g. app was killed mid-run) and transition them to error.
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
        let recovered = 0;
        for (const t of list) {
          if (cancelled) return;
          if (t.column === 'in_progress' && t.run_id && !activeRunIds.has(t.run_id)) {
            await window.cerebro.invoke({
              method: 'POST',
              path: `/tasks/${t.id}/run-event`,
              body: {
                type: 'run_failed',
                run_id: t.run_id,
                error: 'Run was interrupted by app restart',
              },
            });
            recovered++;
          }
        }
        if (!cancelled && recovered > 0) await loadTasks();
      } catch (err) {
        console.warn('[task] Orphan recovery failed:', err);
      }
    };
    recover();
    return () => { cancelled = true; };
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
    // Kill any active run
    if (task?.run_id) {
      try { await window.cerebro.agent.cancel(task.run_id); } catch { /* noop */ }
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
    // Find the task to get its run_id
    const task = tasks.find((t) => t.id === id);
    // Kill the PTY if there's an active run
    if (task?.run_id) {
      try {
        await window.cerebro.agent.cancel(task.run_id);
      } catch (err) {
        console.warn('[task] Failed to cancel agent run:', err);
      }
      // Clean up event listener
      const unsub = runListeners.current.get(id);
      if (unsub) {
        unsub();
        runListeners.current.delete(id);
      }
      // Fire run_cancelled event to transition card
      try {
        await window.cerebro.invoke({
          method: 'POST',
          path: `/tasks/${id}/run-event`,
          body: { type: 'run_cancelled', run_id: task.run_id },
        });
      } catch (err) {
        console.warn('[task] Failed to post run_cancelled:', err);
      }
    } else {
      // No active run — fall back to backend cancel endpoint
      const res = await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${id}/cancel`,
      });
      if (!res.ok) throw new Error('Failed to cancel task');
    }
    await loadTasks();
  }, [loadTasks, tasks]);

  // Register an agent event listener that auto-transitions the card on done/error.
  const registerRunListener = useCallback((taskId: string, runId: string) => {
    // Clean up any prior listener for this task
    const prior = runListeners.current.get(taskId);
    if (prior) prior();

    const unsub = window.cerebro.agent.onEvent(runId, async (event) => {
      if (event.type === 'done') {
        try {
          await window.cerebro.invoke({
            method: 'POST',
            path: `/tasks/${taskId}/run-event`,
            body: { type: 'run_completed', run_id: runId },
          });
        } catch (err) {
          console.warn('[task] Failed to post run_completed:', err);
        }
        const u = runListeners.current.get(taskId);
        if (u) u();
        runListeners.current.delete(taskId);
        loadTasks();
      } else if (event.type === 'error') {
        try {
          await window.cerebro.invoke({
            method: 'POST',
            path: `/tasks/${taskId}/run-event`,
            body: { type: 'run_failed', run_id: runId, error: event.error },
          });
        } catch (err) {
          console.warn('[task] Failed to post run_failed:', err);
        }
        const u = runListeners.current.get(taskId);
        if (u) u();
        runListeners.current.delete(taskId);
        loadTasks();
      }
    });
    runListeners.current.set(taskId, unsub);
  }, [loadTasks]);

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
        lines.push(`- ${c.body_md.trim()}`);
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

      const runId = await window.cerebro.agent.run({
        conversationId: taskId,
        content: prompt,
        expertId: task.expert_id,
        runType: 'task',
        taskPhase: 'direct',
        workspacePath,
        maxTurns: 30,
      });

      await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${taskId}/run-event`,
        body: { type: 'run_started', run_id: runId },
      });

      registerRunListener(taskId, runId);
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

  const sendInstruction = useCallback(async (taskId: string, instruction: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Create the instruction comment first (so the user sees it in the thread)
    await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${taskId}/comments`,
      body: { kind: 'instruction', body_md: instruction },
    });

    // Load all comments to build follow-up context
    const allComments = await loadComments(taskId);
    const priorInstructions = allComments
      .filter((c) => c.kind === 'instruction')
      .slice(0, -1); // exclude the one we just added — it's the new instruction

    // resolveCwd is idempotent — re-creates the hidden workspace if a prior
    // cancel/abort cleared it, so instructions after a restart still work.
    const workspacePath = await resolveCwd(task);

    // Build follow-up context: original goal + prior instructions
    const contextLines: string[] = [];
    contextLines.push(`Original task: ${task.title}`);
    if (task.description_md?.trim()) {
      contextLines.push(task.description_md.trim());
    }
    if (priorInstructions.length > 0) {
      contextLines.push('', 'Prior instructions:');
      for (const c of priorInstructions) {
        contextLines.push(`- ${c.body_md.trim()}`);
      }
    }
    const followUpContext = contextLines.join('\n');

    // Start a fresh Claude Code run rather than resuming the prior session.
    // Sessions don't reliably survive across subprocess exits, but the workspace
    // files are preserved on disk so the agent picks up where it left off.
    const runId = await window.cerebro.agent.run({
      conversationId: taskId,
      content: instruction,
      expertId: task.expert_id,
      runType: 'task',
      taskPhase: 'follow_up',
      workspacePath,
      followUpContext,
      maxTurns: 30,
    });

    await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${taskId}/run-event`,
      body: { type: 'run_started', run_id: runId },
    });

    registerRunListener(taskId, runId);
    await loadTasks();
  }, [tasks, loadComments, registerRunListener, loadTasks, resolveCwd]);

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
        loadComments,
        addComment,
        addChecklistItem,
        updateChecklistItem,
        deleteChecklistItem,
        promoteChecklistItem,
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
