import { useState, useEffect, useRef } from 'react';
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  SkipForward,
  Clock,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import type { ExecutionEvent } from '../../engine/events/types';
import { loadSetting } from '../../lib/settings';

type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface StepState {
  id: string;
  name: string;
  actionType?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
  summary?: string;
  error?: string;
  durationMs?: number;
  logs: string[];
}

interface RunLogCardProps {
  engineRunId: string;
  isPreview?: boolean;
}

interface RunRecordData {
  status: string;
  trigger: string;
  total_steps: number;
  steps: Array<{
    step_id: string;
    step_name: string;
    action_type: string;
    status: string;
    summary: string | null;
    error: string | null;
    duration_ms: number | null;
  }> | null;
}

interface EventRecordResponse {
  event_type: string;
  payload_json: string;
}

const MAX_STEP_LOGS = 200;

function StepIcon({ status }: { status: StepState['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 size={12} className="animate-spin text-yellow-500" />;
    case 'completed':
      return <CheckCircle2 size={12} className="text-green-500" />;
    case 'failed':
      return <XCircle size={12} className="text-red-500" />;
    case 'skipped':
      return <SkipForward size={12} className="text-text-tertiary" />;
    case 'queued':
      return <Clock size={12} className="text-zinc-400" />;
  }
}

function RunStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 size={14} className="animate-spin text-yellow-500" />;
    case 'completed':
      return <CheckCircle2 size={14} className="text-green-500" />;
    case 'failed':
      return <XCircle size={14} className="text-red-500" />;
    case 'cancelled':
      return <XCircle size={14} className="text-text-tertiary" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function RunLogCard({ engineRunId, isPreview }: RunLogCardProps) {
  const [runStatus, setRunStatus] = useState<RunStatus>('running');
  const [steps, setSteps] = useState<StepState[]>([]);
  const [totalSteps, setTotalSteps] = useState(0);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isPreviewRun, setIsPreviewRun] = useState(isPreview ?? false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // Track whether the scroll anchor is visible (user hasn't scrolled away)
  const hasAnchor = isExpanded && steps.length > 0;
  useEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    const observer = new IntersectionObserver(
      ([entry]) => { isNearBottomRef.current = entry.isIntersecting; },
      { threshold: 0 },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [hasAnchor]);

  // Auto-scroll to latest log while running, only if user is near the bottom
  useEffect(() => {
    if (runStatus === 'running' && isNearBottomRef.current && scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [steps, runStatus]);

  // Historical load — hydrate from backend if run is already finished
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const activeRuns = await window.cerebro.engine.activeRuns();
        const isActive = activeRuns.some((r) => r.runId === engineRunId);
        if (isActive || cancelled) return;

        // Run is not active — fetch historical record
        const res = await window.cerebro.invoke<RunRecordData>({
          method: 'GET',
          path: `/engine/runs/${engineRunId}`,
        });
        if (cancelled || !res.ok || !res.data) return;

        const record = res.data;
        setRunStatus(record.status as RunStatus);
        setTotalSteps(record.total_steps);
        setIsExpanded(false); // collapse historical runs

        if (record.trigger === 'preview') {
          setIsPreviewRun(true);
        }

        if (record.steps) {
          const hydratedSteps = record.steps.map((s) => ({
            id: s.step_id,
            name: s.step_name,
            actionType: s.action_type,
            status: s.status as StepState['status'],
            summary: s.summary ?? undefined,
            error: s.error ?? undefined,
            durationMs: s.duration_ms ?? undefined,
            logs: [] as string[],
          }));

          // Optionally load historical step logs
          const showLogs = await loadSetting<boolean>('show_historical_step_logs');
          if (!cancelled && showLogs) {
            try {
              const eventsRes = await window.cerebro.invoke<EventRecordResponse[]>({
                method: 'GET',
                path: `/engine/runs/${engineRunId}/events?limit=1000`,
              });
              if (!cancelled && eventsRes.ok && eventsRes.data) {
                const logsByStep = new Map<string, string[]>();
                for (const evt of eventsRes.data) {
                  if (evt.event_type !== 'step_log') continue;
                  try {
                    const payload = JSON.parse(evt.payload_json) as { stepId: string; message: string };
                    const list = logsByStep.get(payload.stepId) ?? [];
                    list.push(payload.message);
                    logsByStep.set(payload.stepId, list);
                  } catch { /* skip malformed */ }
                }
                for (const step of hydratedSteps) {
                  step.logs = logsByStep.get(step.id) ?? [];
                }
              }
            } catch { /* events endpoint may not exist yet */ }
          }

          setSteps(hydratedSteps);
        }
      } catch {
        // If the fetch fails, leave in running state — live events will populate
      }
    })();
    return () => { cancelled = true; };
  }, [engineRunId]);

  // Live event subscription
  useEffect(() => {
    const unsub = window.cerebro.engine.onEvent(engineRunId, (event: ExecutionEvent) => {
      switch (event.type) {
        case 'run_started':
          setTotalSteps(event.totalSteps);
          break;

        case 'step_queued':
          setSteps((prev) => [
            ...prev,
            { id: event.stepId, name: event.stepName, status: 'queued' as const, logs: [] },
          ]);
          break;

        case 'step_started':
          setSteps((prev) =>
            prev.map((s) =>
              s.id === event.stepId ? { ...s, status: 'running' as const, actionType: event.actionType } : s,
            ),
          );
          break;

        case 'step_completed':
          setSteps((prev) =>
            prev.map((s) =>
              s.id === event.stepId
                ? { ...s, status: 'completed' as const, summary: event.summary, durationMs: event.durationMs }
                : s,
            ),
          );
          break;

        case 'step_failed':
          setSteps((prev) =>
            prev.map((s) =>
              s.id === event.stepId ? { ...s, status: 'failed' as const, error: event.error } : s,
            ),
          );
          break;

        case 'step_skipped':
          setSteps((prev) =>
            prev.map((s) =>
              s.id === event.stepId ? { ...s, status: 'skipped' as const } : s,
            ),
          );
          break;

        case 'step_log': {
          setSteps((prev) =>
            prev.map((s) => {
              if (s.id !== event.stepId) return s;
              const updated = [...s.logs, event.message];
              return { ...s, logs: updated.length > MAX_STEP_LOGS ? updated.slice(-MAX_STEP_LOGS) : updated };
            }),
          );
          break;
        }

        case 'run_completed':
          setRunStatus('completed');
          break;

        case 'run_failed':
          setRunStatus('failed');
          break;

        case 'run_cancelled':
          setRunStatus('cancelled');
          break;
      }
    });

    return unsub;
  }, [engineRunId]);

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.cerebro.engine.cancel(engineRunId).catch(console.error);
  };

  const completedCount = steps.filter(
    (s) => s.status === 'completed' || s.status === 'failed' || s.status === 'skipped',
  ).length;
  const displayTotal = totalSteps || steps.length;

  const label = isPreviewRun ? 'Preview Run' : 'Routine Run';

  const statusLabel =
    runStatus === 'running'
      ? 'Running'
      : runStatus === 'completed'
        ? 'Completed'
        : runStatus === 'failed'
          ? 'Failed'
          : 'Cancelled';

  return (
    <div className="animate-fade-in rounded-lg border overflow-hidden border-border-default bg-bg-surface/50">
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsExpanded(!isExpanded); } }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-hover/50 transition-colors duration-150 cursor-pointer"
      >
        <RunStatusIcon status={runStatus} />
        <span className="flex-1 text-xs font-medium text-text-secondary">{label}</span>
        <span className="text-[10px] text-text-tertiary">
          {completedCount}/{displayTotal} steps
        </span>
        {runStatus === 'running' && (
          <button
            onClick={handleCancel}
            className="p-0.5 rounded hover:bg-bg-hover text-text-tertiary hover:text-red-400 transition-colors cursor-pointer"
            title="Cancel run"
          >
            <X size={12} />
          </button>
        )}
        <ChevronRight
          size={12}
          className={clsx(
            'text-text-tertiary transition-transform duration-200 flex-shrink-0',
            isExpanded && 'rotate-90',
          )}
        />
      </div>

      {/* Step list */}
      {isExpanded && steps.length > 0 && (
        <div className="border-t border-border-subtle px-3 py-2 space-y-1.5">
          {steps.map((step, i) => (
            <div
              key={step.id}
              className="animate-step-in"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex-shrink-0">
                  <StepIcon status={step.status} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'text-xs truncate',
                        step.status === 'skipped' ? 'text-text-tertiary' : 'text-text-secondary',
                      )}
                    >
                      {step.name}
                    </span>
                    {step.durationMs != null && (
                      <span className="text-[10px] text-text-tertiary flex-shrink-0">
                        {formatDuration(step.durationMs)}
                      </span>
                    )}
                  </div>
                  {step.summary && (
                    <p className="text-[10px] text-text-tertiary truncate mt-0.5">{step.summary}</p>
                  )}
                  {step.error && (
                    <p className="text-[10px] text-red-400 mt-0.5">{step.error}</p>
                  )}
                </div>
              </div>
              {/* Step logs */}
              {step.logs.length > 0 && (
                <div className="ml-5 mt-1 border-l-2 border-border-subtle pl-2 space-y-0.5">
                  {step.logs.map((log, li) => (
                    <p key={li} className="text-[10px] font-mono text-text-tertiary leading-relaxed">
                      {log}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={scrollAnchorRef} />
        </div>
      )}

      {/* Status bar when collapsed or complete */}
      {!isExpanded && runStatus !== 'running' && (
        <div className="border-t border-border-subtle px-3 py-1.5">
          <span
            className={clsx(
              'text-[10px]',
              runStatus === 'completed' && 'text-green-500',
              runStatus === 'failed' && 'text-red-500',
              runStatus === 'cancelled' && 'text-text-tertiary',
            )}
          >
            {statusLabel}
          </span>
        </div>
      )}
    </div>
  );
}
