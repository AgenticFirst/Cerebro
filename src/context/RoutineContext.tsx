import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';
import type { Routine, ApiRoutine, CreateRoutineInput } from '../types/routines';
import type { DAGDefinition } from '../engine/dag/types';
import { toRoutine, toApiBody } from '../types/routines';
import { validateDagParams, type ValidationContext } from '../utils/step-validation';
import { resolveActionType } from '../utils/step-defaults';
import { CLAUDE_MODELS } from '../utils/claude-models';
import { fetchConnectionStatus, type ConnectionId } from '../lib/connection-status';
import { useToast } from './ToastContext';
import { useExperts } from './ExpertContext';

// ── Context ────────────────────────────────────────────────────

export type RunRoutineCallback = (info: { id: string; name: string; dagJson: string }) => void;

interface RoutineContextValue {
  routines: Routine[];
  total: number;
  isLoading: boolean;
  loadError: string | null;
  enabledCount: number;
  cronCount: number;
  editingRoutineId: string | null;
  setEditingRoutineId: (id: string | null) => void;
  loadRoutines: () => Promise<void>;
  createRoutine: (input: CreateRoutineInput) => Promise<Routine | null>;
  updateRoutine: (id: string, fields: Partial<ApiRoutine>) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  toggleEnabled: (routine: Routine) => Promise<void>;
  runRoutine: (id: string) => Promise<void>;
  registerRunCallback: (cb: RunRoutineCallback) => void;
}

const RoutineContext = createContext<RoutineContextValue | null>(null);

/** Fields that affect cron scheduling — only sync scheduler when these change. */
const SCHEDULE_FIELDS = new Set(['trigger_type', 'cron_expression', 'is_enabled']);

export function RoutineProvider({ children }: { children: ReactNode }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const runCallbackRef = useRef<RunRoutineCallback | null>(null);
  const routinesRef = useRef<Routine[]>(routines);
  routinesRef.current = routines;
  const { addToast } = useToast();
  const { experts } = useExperts();
  const expertsRef = useRef(experts);
  expertsRef.current = experts;

  const registerRunCallback = useCallback((cb: RunRoutineCallback) => {
    runCallbackRef.current = cb;
  }, []);

  const enabledCount = useMemo(
    () => routines.filter((r) => r.isEnabled).length,
    [routines],
  );

  const cronCount = useMemo(
    () => routines.filter((r) => r.triggerType === 'cron' && r.isEnabled).length,
    [routines],
  );

  const loadRoutines = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const res: BackendResponse<{ routines: ApiRoutine[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: '/routines?limit=200',
        });
      if (res.ok) {
        setRoutines(res.data.routines.map(toRoutine));
        setTotal(res.data.total);
        setLoadError(null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load routines');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createRoutine = useCallback(
    async (input: CreateRoutineInput): Promise<Routine | null> => {
      try {
        const res: BackendResponse<ApiRoutine> = await window.cerebro.invoke({
          method: 'POST',
          path: '/routines',
          body: toApiBody(input),
        });
        if (res.ok) {
          const routine = toRoutine(res.data);
          setRoutines((prev) => [routine, ...prev]);
          setTotal((prev) => prev + 1);
          if (input.triggerType === 'cron') {
            window.cerebro.scheduler.sync().catch(console.error);
          }
          return routine;
        }
      } catch (e) {
        console.error('Failed to create routine:', e);
        addToast('Failed to create routine', 'error');
      }
      return null;
    },
    [addToast],
  );

  const updateRoutine = useCallback(
    async (id: string, fields: Partial<ApiRoutine>) => {
      try {
        const res: BackendResponse<ApiRoutine> = await window.cerebro.invoke({
          method: 'PATCH',
          path: `/routines/${id}`,
          body: fields,
        });
        if (res.ok) {
          const updated = toRoutine(res.data);
          setRoutines((prev) => prev.map((r) => (r.id === id ? updated : r)));
          if (Object.keys(fields).some((k) => SCHEDULE_FIELDS.has(k))) {
            window.cerebro.scheduler.sync().catch(console.error);
          }
        }
      } catch (e) {
        console.error('Failed to update routine:', e);
        addToast('Failed to update routine', 'error');
      }
    },
    [addToast],
  );

  const deleteRoutine = useCallback(async (id: string) => {
    try {
      const res = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/routines/${id}`,
      });
      if (res.ok || res.status === 204) {
        setRoutines((prev) => prev.filter((r) => r.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
        window.cerebro.scheduler.sync().catch(console.error);
      }
    } catch (e) {
      console.error('Failed to delete routine:', e);
      addToast('Failed to delete routine', 'error');
    }
  }, [addToast]);

  const toggleEnabled = useCallback(
    async (routine: Routine) => {
      await updateRoutine(routine.id, { is_enabled: !routine.isEnabled });
    },
    [updateRoutine],
  );

  const runRoutine = useCallback(async (id: string) => {
    const routine = routinesRef.current.find((r) => r.id === id);
    if (!routine?.dagJson) return;

    let dag: DAGDefinition;
    try {
      dag = JSON.parse(routine.dagJson);
    } catch {
      addToast('Routine DAG is invalid JSON', 'error');
      return;
    }

    // Build live-resource context. We only spend on async checks (IPC
    // round-trips, subprocess probe) when the DAG actually has a step
    // that benefits from them.
    const usesHubspot = dag.steps.some((s) => {
      const r = resolveActionType(s.actionType);
      return r === 'hubspot_create_ticket' || r === 'hubspot_upsert_contact';
    });

    // Experts an the DAG references via run_expert. Decide which
    // connections need live status checks based on the union of those
    // experts' requiredConnections plus action-type-implied connections.
    const referencedExperts = dag.steps
      .filter((s) => resolveActionType(s.actionType) === 'run_expert')
      .map((s) => expertsRef.current.find((e) => e.id === String(s.params?.expertId ?? '')))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    const expertConnectionNeeds = new Set<ConnectionId>();
    for (const expert of referencedExperts) {
      for (const conn of expert.requiredConnections ?? []) {
        if (conn === 'hubspot' || conn === 'whatsapp' || conn === 'telegram') {
          expertConnectionNeeds.add(conn);
        }
      }
    }
    const connectionsToCheck: ConnectionId[] = [];
    if (usesHubspot || expertConnectionNeeds.has('hubspot')) connectionsToCheck.push('hubspot');
    if (expertConnectionNeeds.has('whatsapp')) connectionsToCheck.push('whatsapp');
    if (expertConnectionNeeds.has('telegram')) connectionsToCheck.push('telegram');

    const usesClaudeCode = dag.steps.some((s) => {
      const r = resolveActionType(s.actionType);
      return r === 'run_expert' || r === 'ask_ai' || r === 'run_claude_code';
    });

    const validationCtx: ValidationContext = {
      experts: expertsRef.current.map((e) => ({
        id: e.id,
        isEnabled: e.isEnabled,
        requiredConnections: e.requiredConnections,
      })),
      knownModels: CLAUDE_MODELS.map((m) => m.id),
    };

    if (connectionsToCheck.length > 0) {
      const conns = await fetchConnectionStatus(connectionsToCheck);
      validationCtx.hubspotConnected = conns.hubspot;
      validationCtx.whatsappConnected = conns.whatsapp;
      validationCtx.telegramConnected = conns.telegram;
    }

    if (usesClaudeCode) {
      try {
        const probe = await window.cerebro.claudeCode.probeAuth();
        validationCtx.claudeCodeAuthChecked = true;
        validationCtx.claudeCodeAuthOk = probe.ok;
        validationCtx.claudeCodeAuthReason = probe.reason;
      } catch {
        // Probe IPC unavailable — skip; the engine's idle timeout still
        // catches a hung subprocess in 60s.
      }
    }

    const issues = validateDagParams(dag, validationCtx);
    if (issues.length > 0) {
      let summary: string;
      if (issues.length === 1) {
        summary = issues[0].message;
      } else if (issues.length <= 3) {
        summary = issues.map((i) => i.message).join('; ');
      } else {
        summary = `${issues.length} steps need attention: ${issues.map((i) => i.stepName).join(', ')}`;
      }
      addToast(`Can't run "${routine.name}" — ${summary}`, 'error');
      return;
    }

    if (runCallbackRef.current) {
      runCallbackRef.current({ id: routine.id, name: routine.name, dagJson: routine.dagJson });
    } else {
      console.warn('runRoutine called but no run callback registered (ChatProvider may not be mounted)');
    }
  }, [addToast]);

  return (
    <RoutineContext.Provider
      value={{
        routines,
        total,
        isLoading,
        loadError,
        enabledCount,
        cronCount,
        editingRoutineId,
        setEditingRoutineId,
        loadRoutines,
        createRoutine,
        updateRoutine,
        deleteRoutine,
        toggleEnabled,
        runRoutine,
        registerRunCallback,
      }}
    >
      {children}
    </RoutineContext.Provider>
  );
}

export function useRoutines(): RoutineContextValue {
  const ctx = useContext(RoutineContext);
  if (!ctx) throw new Error('useRoutines must be used within RoutineProvider');
  return ctx;
}
