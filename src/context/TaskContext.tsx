/**
 * TaskContext — manages task lifecycle, live streaming, and event persistence.
 *
 * Mirrors the ApprovalContext debounced-refresh pattern. Each task run spawns
 * a Claude Code subprocess via `window.cerebro.agent.run()`; the context
 * subscribes to stream events via `window.cerebro.agent.onEvent()`, feeds
 * them through TaskStreamParser, and persists batches to the backend via
 * `POST /tasks/{id}/events`.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react';
import { TaskStreamParser, type TaskStreamEvent } from '../components/screens/tasks/stream-parser';
import { parseTaskEvents } from '../components/screens/tasks/event-parser';
import type {
  Task,
  TaskDetail,
  TaskPlan,
  NewTaskInput,
  PhaseRuntimeState,
  RunInfo,
  ClarificationQuestion,
  TaskLogEntry,
} from '../components/screens/tasks/types';
import type { RendererAgentEvent } from '../types/ipc';
import { appendTaskTerminalData, clearTaskTerminalBuffer } from '../components/screens/tasks/taskTerminalBuffer';

// ── Context types ───────────────────────────────────────────────

interface LiveTaskState {
  taskId: string;
  runId: string;
  phase: 'clarify' | 'execute';
  plan: TaskPlan | null;
  deliverableKind: string | null;
  phases: Record<string, PhaseRuntimeState>;
  activePhaseId: string | null;
  textAccumulated: string;
  logEntries: TaskLogEntry[];
  logSeqCounter: number;
  turnsUsed: number;
  // Accumulated parsed results (so done handler doesn't rely solely on flush)
  readySeen: boolean;
  deliverableMarkdown: string | null;
  deliverableTitle: string | null;
  runInfo: RunInfo | null;
  model: string | undefined;
  /** Set once finalization has been triggered — prevents double-finalize. */
  finalized: boolean;
}

interface TaskContextValue {
  tasks: Task[];
  runningCount: number;
  isLoading: boolean;
  selectedTaskId: string | null;
  liveTask: LiveTaskState | null;

  refresh: () => Promise<void>;
  createAndRunTask: (input: NewTaskInput) => Promise<Task>;
  submitClarification: (taskId: string, answers: Array<{ id: string; answer: string | boolean }>) => Promise<void>;
  followUpTask: (taskId: string, instruction: string, model?: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  setSelectedTaskId: (id: string | null) => void;
  watchTask: (id: string) => Promise<void>;
  unwatchTask: () => void;
}

const TaskContext = createContext<TaskContextValue | null>(null);

// ── Event flush helper ──────────────────────────────────────────

const FLUSH_INTERVAL_MS = 300;
const FLUSH_BATCH_SIZE = 50;

// ── Provider ────────────────────────────────────────────────────

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [liveTask, setLiveTask] = useState<LiveTaskState | null>(null);

  // Refs for live state that changes at stream frequency
  const liveTaskRef = useRef<LiveTaskState | null>(null);
  const parserRef = useRef<TaskStreamParser | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingEventsRef = useRef<Array<{ seq: number; kind: string; payload_json: string }>>([]);

  // Debounced refresh (same pattern as ApprovalContext)
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    refreshInFlight.current = true;
    try {
      const res = await window.cerebro.invoke<{ tasks: Task[]; total: number }>({
        method: 'GET',
        path: '/tasks?limit=100',
      });
      if (res.ok && res.data?.tasks) {
        setTasks(res.data.tasks);
      }
    } catch {
      // Backend not ready
    } finally {
      setIsLoading(false);
      refreshInFlight.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        queueMicrotask(() => void refresh());
      }
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Event flushing ────────────────────────────────────────────

  const flushEvents = useCallback(async (taskId: string) => {
    const batch = pendingEventsRef.current.splice(0, 500);
    if (batch.length === 0) return;
    try {
      await window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${taskId}/events`,
        body: { events: batch },
      });
    } catch {
      // Re-queue on failure (best-effort)
      pendingEventsRef.current.unshift(...batch);
    }
  }, []);

  const enqueueEvent = useCallback((kind: string, payload: unknown) => {
    const live = liveTaskRef.current;
    if (!live) return;
    const seq = live.logSeqCounter++;
    pendingEventsRef.current.push({
      seq,
      kind,
      payload_json: JSON.stringify(payload),
    });
    if (pendingEventsRef.current.length >= FLUSH_BATCH_SIZE) {
      void flushEvents(live.taskId);
    }
  }, [flushEvents]);

  // ── Cleanup ───────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    parserRef.current = null;
    // Clear the PTY terminal buffer for the completed run
    const live = liveTaskRef.current;
    if (live) clearTaskTerminalBuffer(live.runId);
  }, []);

  // ── Throttled UI update ──────────────────────────────────────
  // Stream events arrive at very high frequency (hundreds of text_deltas/s).
  // Mutate the ref immediately but batch React state updates to ~60fps.
  const uiUpdateScheduled = useRef(false);
  const scheduleUIUpdate = useCallback(() => {
    if (uiUpdateScheduled.current) return;
    uiUpdateScheduled.current = true;
    requestAnimationFrame(() => {
      uiUpdateScheduled.current = false;
      const live = liveTaskRef.current;
      if (live) setLiveTask({ ...live });
    });
  }, []);

  // ── Parsed event handler (must be defined before doFinalize) ──

  const handleParsedEvent = useCallback((live: LiveTaskState, e: TaskStreamEvent) => {
    if (e.type === 'ready') {
      live.readySeen = true;
    } else if (e.type === 'clarification') {
      void window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${live.taskId}/clarifications`,
        body: { questions: e.questions },
      }).then(() => refresh());
    } else if (e.type === 'plan') {
      live.plan = e.plan;
      live.deliverableKind = e.kind;
      for (const phase of e.plan.phases) {
        live.phases[phase.id] = { status: 'pending', name: phase.name, summary: null };
      }
      void window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${live.taskId}/plan`,
        body: { kind: e.kind, phases: e.plan.phases },
      });
    } else if (e.type === 'phase_start') {
      live.activePhaseId = e.phaseId;
      if (live.phases[e.phaseId]) {
        live.phases[e.phaseId].status = 'running';
      } else {
        live.phases[e.phaseId] = { status: 'running', name: e.name, summary: null };
      }
      live.logEntries.push({ kind: 'phase_start', phaseId: e.phaseId, name: e.name });
      void window.cerebro.invoke({
        method: 'PATCH',
        path: `/tasks/${live.taskId}/phase`,
        body: { phase_id: e.phaseId, status: 'running' },
      });
    } else if (e.type === 'phase_summary') {
      if (live.phases[e.phaseId]) live.phases[e.phaseId].summary = e.summary;
      void window.cerebro.invoke({
        method: 'PATCH',
        path: `/tasks/${live.taskId}/phase`,
        body: { phase_id: e.phaseId, status: 'completed', summary: e.summary },
      });
    } else if (e.type === 'phase_end') {
      if (live.phases[e.phaseId]) live.phases[e.phaseId].status = 'completed';
      live.activePhaseId = null;
      live.logEntries.push({ kind: 'phase_end', phaseId: e.phaseId });
    } else if (e.type === 'deliverable') {
      live.deliverableKind = e.kind;
      live.deliverableMarkdown = e.markdown;
      live.deliverableTitle = e.title;
    } else if (e.type === 'run_info') {
      live.runInfo = e.info;
    }
  }, [refresh]);

  // ── Idempotent finalization ────────────────────────────────────
  //
  // Multiple signals can indicate a run is done: the `done` IPC event,
  // the `result` system event (last stream-json line before process exit),
  // or the `error` event.  The `result` event is the most reliable —
  // it fires when the CLI writes its final JSON line, before process exit.
  // The `done` event depends on process.close which hangs when child
  // processes inherit stdio.  The `finalized` flag ensures only the first
  // signal takes effect.

  const autoStartExecuteRef = useRef<((taskId: string, model: string | undefined) => Promise<void>) | null>(null);

  const doFinalize = useCallback((
    live: LiveTaskState,
    status: 'completed' | 'failed',
    error?: string,
  ) => {
    if (live.finalized) return;
    live.finalized = true;

    // Flush any remaining parser buffer
    const parser = parserRef.current;
    if (parser) {
      for (const e of parser.flush()) handleParsedEvent(live, e);
    }

    // Mark any in-progress phases as done so the plan shows correct state
    if (live.plan) {
      const finalPhaseStatus = status === 'completed' ? 'completed' : 'failed';
      for (const phase of live.plan.phases) {
        if (phase.status === 'running' || phase.status === 'pending') {
          phase.status = finalPhaseStatus;
        }
        const phaseState = live.phases[phase.id];
        if (phaseState && (phaseState.status === 'running' || phaseState.status === 'pending')) {
          phaseState.status = finalPhaseStatus;
        }
      }
    }

    // Flush persisted events, THEN cleanup (so events aren't lost)
    void flushEvents(live.taskId).then(() => cleanup());

    if (live.phase === 'execute') {
      void window.cerebro.invoke({
        method: 'POST',
        path: `/tasks/${live.taskId}/finalize`,
        body: {
          status,
          deliverable_markdown: status === 'completed'
            ? (live.deliverableMarkdown || live.textAccumulated || null)
            : null,
          deliverable_title: status === 'completed'
            ? (live.deliverableTitle ?? null)
            : null,
          deliverable_kind: live.deliverableKind ?? 'markdown',
          run_info: live.runInfo ?? null,
          error: error ?? null,
        },
      }).then(() => refresh());

      // Optimistic update: immediately reflect completion in context tasks
      setTasks((prev) =>
        prev.map((t) =>
          t.id === live.taskId
            ? {
                ...t,
                status: status as Task['status'],
                deliverable_markdown: status === 'completed'
                  ? (live.deliverableMarkdown || live.textAccumulated || t.deliverable_markdown)
                  : t.deliverable_markdown,
                deliverable_title: live.deliverableTitle ?? t.deliverable_title,
                deliverable_kind: (live.deliverableKind ?? t.deliverable_kind) as Task['deliverable_kind'],
                plan: live.plan ?? t.plan,
                completed_at: new Date().toISOString(),
                error: error ?? null,
              }
            : t,
        ),
      );
    } else if (live.phase === 'clarify') {
      if (status === 'failed') {
        void window.cerebro.invoke({
          method: 'POST',
          path: `/tasks/${live.taskId}/finalize`,
          body: { status: 'failed', error: error ?? null },
        }).then(() => refresh());
        setTasks((prev) =>
          prev.map((t) =>
            t.id === live.taskId ? { ...t, status: 'failed' as Task['status'], error: error ?? null } : t,
          ),
        );
      } else if (live.readySeen) {
        void autoStartExecuteRef.current?.(live.taskId, live.model);
      }
    }

    setLiveTask({ ...live });
  }, [flushEvents, handleParsedEvent, refresh, cleanup]);

  // ── Stream event handler ──────────────────────────────────────
  // Routed through a ref so the IPC subscription never holds a stale closure.

  const handleStreamEventRef = useRef<(evt: RendererAgentEvent) => void>(() => {});

  handleStreamEventRef.current = (evt: RendererAgentEvent) => {
    const live = liveTaskRef.current;
    const parser = parserRef.current;
    if (!live || !parser) return;

    if (evt.type === 'text_delta') {
      live.textAccumulated += evt.delta;
      const phaseId = parser.getCurrentPhaseId();
      live.logEntries.push({ kind: 'text_delta', text: evt.delta, phaseId });
      enqueueEvent('text_delta', { delta: evt.delta, phaseId });
      for (const e of parser.feed(evt.delta)) handleParsedEvent(live, e);
      scheduleUIUpdate();
    } else if (evt.type === 'tool_start') {
      live.logEntries.push({ kind: 'tool_start', toolCallId: evt.toolCallId, toolName: evt.toolName, args: evt.args });
      enqueueEvent('tool_start', { toolCallId: evt.toolCallId, toolName: evt.toolName, args: evt.args });
      scheduleUIUpdate();
    } else if (evt.type === 'tool_end') {
      live.logEntries.push({ kind: 'tool_end', toolCallId: evt.toolCallId, toolName: evt.toolName, result: evt.result, isError: evt.isError });
      enqueueEvent('tool_end', { toolCallId: evt.toolCallId, toolName: evt.toolName, result: evt.result, isError: evt.isError });
      scheduleUIUpdate();
    } else if (evt.type === 'system') {
      live.logEntries.push({ kind: 'system', message: evt.message });
      enqueueEvent('system', { message: evt.message, subtype: evt.subtype });
      if (evt.subtype === 'result') {
        doFinalize(live, 'completed');
      } else {
        scheduleUIUpdate();
      }
    } else if (evt.type === 'turn_start') {
      live.turnsUsed = evt.turn;
      enqueueEvent('turn_start', { turn: evt.turn });
    } else if (evt.type === 'done') {
      enqueueEvent('done', { messageContent: evt.messageContent });
      doFinalize(live, 'completed');
    } else if (evt.type === 'error') {
      live.logEntries.push({ kind: 'error', message: evt.error });
      enqueueEvent('error', { error: evt.error });
      doFinalize(live, 'failed', evt.error);
    }
  };

  // Stable callback that delegates to the ref — safe for IPC subscriptions
  const handleStreamEvent = useCallback(
    (evt: RendererAgentEvent) => handleStreamEventRef.current(evt),
    [],
  );

  // ── Actions ───────────────────────────────────────────────────

  const startSubprocessRef = useRef<((
    task: Task,
    phase: 'clarify' | 'execute',
    runId: string,
    conversationId: string,
    workspacePath: string | null,
    clarificationAnswers?: string,
    model?: string,
    followUp?: { content: string; context: string },
  ) => Promise<void>) | null>(null);

  const startSubprocess = useCallback(
    async (
      task: Task,
      phase: 'clarify' | 'execute',
      runId: string,
      conversationId: string,
      workspacePath: string | null,
      clarificationAnswers?: string,
      model?: string,
      followUp?: { content: string; context: string },
    ) => {
      const parserMode = phase === 'clarify' ? 'clarify' : 'execute';
      const parser = new TaskStreamParser(parserMode);
      parserRef.current = parser;

      const live: LiveTaskState = {
        taskId: task.id,
        runId,
        phase: parserMode,
        plan: task.plan ?? null,
        deliverableKind: task.deliverable_kind ?? null,
        phases: {},
        activePhaseId: null,
        textAccumulated: '',
        logEntries: [],
        logSeqCounter: 0,
        turnsUsed: 0,
        readySeen: false,
        deliverableMarkdown: null,
        deliverableTitle: null,
        runInfo: null,
        model,
        finalized: false,
      };
      liveTaskRef.current = live;
      setLiveTask(live);
      pendingEventsRef.current = [];

      const unsub = window.cerebro.agent.onEvent(runId, handleStreamEvent);
      unsubRef.current = unsub;

      // Buffer PTY terminal data globally so TaskConsoleView can replay
      // on mount even if it renders after data started flowing.
      // Subscribe BEFORE agent.run() to capture from the very first byte.
      if (phase !== 'clarify') {
        const unsubPty = window.cerebro.taskTerminal.onData(runId, (data: string) => {
          appendTaskTerminalData(runId, data);
        });
        // Store the PTY unsub alongside the event unsub
        const originalUnsub = unsub;
        unsubRef.current = () => {
          originalUnsub();
          unsubPty();
        };
      }

      flushTimerRef.current = setInterval(() => {
        void flushEvents(task.id);
      }, FLUSH_INTERVAL_MS);

      await window.cerebro.agent.run({
        conversationId,
        content: followUp?.content ?? task.goal,
        runType: 'task',
        taskPhase: followUp ? 'follow_up' : phase,
        maxTurns: phase === 'clarify' ? 5 : task.max_turns,
        maxPhases: task.max_phases,
        maxClarifyQuestions: 5,
        runIdOverride: runId,
        workspacePath: workspacePath ?? undefined,
        clarificationAnswers,
        model,
        followUpContext: followUp?.context,
      });
    },
    [handleStreamEvent, flushEvents],
  );

  startSubprocessRef.current = startSubprocess;

  // Auto-start execute after <ready/> in clarify
  const autoStartExecute = useCallback(async (taskId: string, model: string | undefined) => {
    const taskRes = await window.cerebro.invoke<Task>({
      method: 'GET',
      path: `/tasks/${taskId}`,
    });
    if (!taskRes.ok) return;
    const task = taskRes.data;

    const runRes = await window.cerebro.invoke<{
      task_id: string;
      run_id: string;
      conversation_id: string;
      workspace_path: string | null;
    }>({
      method: 'POST',
      path: `/tasks/${taskId}/run`,
      body: { phase: 'execute' },
    });
    if (!runRes.ok) return;

    await startSubprocessRef.current?.(
      task,
      'execute',
      runRes.data.run_id,
      runRes.data.conversation_id,
      runRes.data.workspace_path,
      undefined,
      model,
    );
    await refresh();
  }, [refresh]);

  // Keep refs in sync
  autoStartExecuteRef.current = autoStartExecute;

  const createAndRunTask = useCallback(async (input: NewTaskInput): Promise<Task> => {
    // 1. Create task row
    const createRes = await window.cerebro.invoke<Task>({
      method: 'POST',
      path: '/tasks',
      body: {
        title: input.title,
        goal: input.goal,
        expert_hint_id: input.expertHintId ?? null,
        template_id: input.templateId ?? null,
        max_turns: input.maxTurns ?? 60,
        max_phases: input.maxPhases ?? 6,
        skip_clarification: input.skipClarification ?? false,
      },
    });
    if (!createRes.ok) throw new Error('Failed to create task');
    const task = createRes.data;

    const firstPhase = task.skip_clarification ? 'execute' : 'clarify';

    // 2. Start run (mints run_records row + workspace)
    const runRes = await window.cerebro.invoke<{
      task_id: string;
      run_id: string;
      conversation_id: string;
      workspace_path: string | null;
    }>({
      method: 'POST',
      path: `/tasks/${task.id}/run`,
      body: { phase: firstPhase },
    });
    if (!runRes.ok) throw new Error('Failed to start task run');

    // 3. Spawn subprocess
    await startSubprocess(
      task,
      firstPhase,
      runRes.data.run_id,
      runRes.data.conversation_id,
      runRes.data.workspace_path,
      undefined,
      input.model,
    );

    setSelectedTaskId(task.id);
    await refresh();
    return task;
  }, [startSubprocess, refresh]);

  const submitClarification = useCallback(async (
    taskId: string,
    answers: Array<{ id: string; answer: string | boolean }>,
  ) => {
    // Capture model from current live state before cleanup
    const currentModel = liveTaskRef.current?.model;

    // Post answers
    const res = await window.cerebro.invoke<{ task_id: string; answers_block: string }>({
      method: 'POST',
      path: `/tasks/${taskId}/clarify`,
      body: { answers },
    });
    if (!res.ok) throw new Error('Failed to submit clarification');

    // Clean up the clarify subprocess listener
    cleanup();

    // Get the latest task state
    const taskRes = await window.cerebro.invoke<Task>({
      method: 'GET',
      path: `/tasks/${taskId}`,
    });
    if (!taskRes.ok) throw new Error('Failed to fetch task');
    const task = taskRes.data;

    // Start execute phase
    const runRes = await window.cerebro.invoke<{
      task_id: string;
      run_id: string;
      conversation_id: string;
      workspace_path: string | null;
    }>({
      method: 'POST',
      path: `/tasks/${taskId}/run`,
      body: { phase: 'execute' },
    });
    if (!runRes.ok) throw new Error('Failed to start execute run');

    await startSubprocess(
      task,
      'execute',
      runRes.data.run_id,
      runRes.data.conversation_id,
      runRes.data.workspace_path,
      res.data.answers_block,
      currentModel,
    );

    await refresh();
  }, [cleanup, startSubprocess, refresh]);

  const followUpTask = useCallback(async (
    taskId: string,
    instruction: string,
    model?: string,
  ) => {
    cleanup();

    const res = await window.cerebro.invoke<{
      task_id: string;
      run_id: string;
      conversation_id: string;
      workspace_path: string | null;
      follow_up_context: string;
    }>({
      method: 'POST',
      path: `/tasks/${taskId}/follow-up`,
      body: { instruction, model: model ?? null },
    });
    if (!res.ok) throw new Error('Failed to start follow-up');

    const taskRes = await window.cerebro.invoke<Task>({
      method: 'GET',
      path: `/tasks/${taskId}`,
    });
    if (!taskRes.ok) throw new Error('Failed to fetch task');

    await startSubprocess(
      taskRes.data,
      'execute',
      res.data.run_id,
      res.data.conversation_id,
      res.data.workspace_path,
      undefined,
      model,
      { content: instruction, context: res.data.follow_up_context },
    );

    await refresh();
  }, [cleanup, startSubprocess, refresh]);

  const cancelTask = useCallback(async (id: string) => {
    const live = liveTaskRef.current;
    if (live && live.taskId === id && live.runId) {
      await window.cerebro.agent.cancel(live.runId);
      cleanup();
    }
    await window.cerebro.invoke({
      method: 'POST',
      path: `/tasks/${id}/cancel`,
    });
    liveTaskRef.current = null;
    setLiveTask(null);
    await refresh();
  }, [cleanup, refresh]);

  const deleteTask = useCallback(async (id: string) => {
    if (liveTaskRef.current?.taskId === id) {
      cleanup();
      liveTaskRef.current = null;
      setLiveTask(null);
    }
    await window.cerebro.invoke({
      method: 'DELETE',
      path: `/tasks/${id}`,
    });
    if (selectedTaskId === id) setSelectedTaskId(null);
    await refresh();
  }, [cleanup, refresh, selectedTaskId]);

  const watchTask = useCallback(async (id: string) => {
    const res = await window.cerebro.invoke<TaskDetail>({
      method: 'GET',
      path: `/tasks/${id}`,
    });
    if (!res.ok) return;
    const task = res.data;

    // Load persisted events so logs survive navigation (works for both
    // running and completed tasks)
    const eventsRes = await window.cerebro.invoke<Array<{ seq: number; kind: string; payload_json: string }>>({
      method: 'GET',
      path: `/tasks/${id}/events?limit=5000`,
    });
    let logEntries: TaskLogEntry[] = [];
    let maxSeq = 0;
    if (eventsRes.ok && Array.isArray(eventsRes.data)) {
      logEntries = parseTaskEvents(eventsRes.data);
      for (const evt of eventsRes.data) {
        if (evt.seq > maxSeq) maxSeq = evt.seq;
      }
    }

    // For running tasks: subscribe for new live events on top of history
    if ((task.status === 'running' || task.status === 'clarifying') && task.run_id) {
      const parser = new TaskStreamParser(
        task.status === 'clarifying' ? 'clarify' : 'execute',
      );
      parserRef.current = parser;

      const live: LiveTaskState = {
        taskId: task.id,
        runId: task.run_id,
        phase: task.status === 'clarifying' ? 'clarify' : 'execute',
        plan: task.plan ?? null,
        deliverableKind: task.deliverable_kind ?? null,
        phases: {},
        activePhaseId: null,
        textAccumulated: '',
        logEntries,
        logSeqCounter: maxSeq + 1,
        turnsUsed: 0,
        readySeen: false,
        deliverableMarkdown: null,
        deliverableTitle: null,
        runInfo: null,
        model: undefined,
        finalized: false,
      };

      if (task.plan?.phases) {
        for (const phase of task.plan.phases) {
          live.phases[phase.id] = { status: phase.status, name: phase.name, summary: phase.summary };
        }
      }

      liveTaskRef.current = live;
      setLiveTask(live);

      const unsub = window.cerebro.agent.onEvent(task.run_id, handleStreamEvent);
      unsubRef.current = unsub;

      flushTimerRef.current = setInterval(() => {
        void flushEvents(task.id);
      }, FLUSH_INTERVAL_MS);
    } else {
      // Completed/failed/cancelled task — just set liveTask with historical
      // logs so the LogsView can display them without a separate fetch
      if (logEntries.length > 0) {
        const live: LiveTaskState = {
          taskId: task.id,
          runId: task.run_id ?? '',
          phase: 'execute',
          plan: task.plan ?? null,
          deliverableKind: task.deliverable_kind ?? null,
          phases: {},
          activePhaseId: null,
          textAccumulated: '',
          logEntries,
          logSeqCounter: maxSeq + 1,
          turnsUsed: 0,
          readySeen: false,
          deliverableMarkdown: null,
          deliverableTitle: null,
          runInfo: null,
          model: undefined,
          finalized: true,
        };
        if (task.plan?.phases) {
          for (const phase of task.plan.phases) {
            live.phases[phase.id] = { status: phase.status, name: phase.name, summary: phase.summary };
          }
        }
        liveTaskRef.current = live;
        setLiveTask(live);
      }
    }
  }, [handleStreamEvent, flushEvents]);

  const unwatchTask = useCallback(() => {
    // Flush any pending events before tearing down so logs persist
    const live = liveTaskRef.current;
    if (live) void flushEvents(live.taskId);
    cleanup();
    liveTaskRef.current = null;
    setLiveTask(null);
  }, [cleanup, flushEvents]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const runningCount = tasks.filter(
    (t) => t.status === 'running' || t.status === 'clarifying' || t.status === 'awaiting_clarification',
  ).length;

  const value: TaskContextValue = {
    tasks,
    runningCount,
    isLoading,
    selectedTaskId,
    liveTask,
    refresh,
    createAndRunTask,
    submitClarification,
    followUpTask,
    cancelTask,
    deleteTask,
    setSelectedTaskId,
    watchTask,
    unwatchTask,
  };

  return (
    <TaskContext.Provider value={value}>
      {children}
    </TaskContext.Provider>
  );
}

// ── Hook ────────────────────────────────────────────────────────

export function useTasks(): TaskContextValue {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTasks must be used within TaskProvider');
  return ctx;
}
