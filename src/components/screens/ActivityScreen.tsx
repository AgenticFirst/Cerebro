import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Activity, Loader2, AlertCircle, RefreshCw, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import type { BackendResponse } from '../../types/ipc';
import { useRoutines } from '../../context/RoutineContext';
import { useChat } from '../../context/ChatContext';
import type { RunRecord, RunListResponse } from './activity/types';
import RunCard from './activity/RunCard';
import RunDetailPanel from './activity/RunDetailPanel';

// ── Filter definitions ─────────────────────────────────────────

const STATUS_FILTERS = ['all', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
const TYPE_FILTERS = ['all', 'routine', 'preview', 'ad_hoc', 'orchestration'] as const;
const TRIGGER_FILTERS = ['all', 'manual', 'scheduled', 'chat', 'webhook'] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];
type TypeFilter = (typeof TYPE_FILTERS)[number];
type TriggerFilter = (typeof TRIGGER_FILTERS)[number];

const FILTER_LABELS: Record<string, string> = {
  all: 'All',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  routine: 'Routine',
  preview: 'Preview',
  ad_hoc: 'Ad-Hoc',
  orchestration: 'Orchestration',
  manual: 'Manual',
  scheduled: 'Scheduled',
  chat: 'Chat',
  webhook: 'Webhook',
};

const PAGE_SIZE = 30;

// ── Component ──────────────────────────────────────────────────

export default function ActivityScreen() {
  const { routines, loadRoutines } = useRoutines();
  const { setActiveScreen } = useChat();

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Routine name lookup
  const routineNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of routines) m.set(r.id, r.name);
    return m;
  }, [routines]);

  // Ensure routines are loaded for name resolution
  useEffect(() => { loadRoutines(); }, [loadRoutines]);

  // Build query params
  const buildQuery = useCallback(
    (offset: number) => {
      const params = new URLSearchParams();
      params.set('offset', String(offset));
      params.set('limit', String(PAGE_SIZE));
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (typeFilter !== 'all') params.set('run_type', typeFilter);
      if (triggerFilter !== 'all') params.set('trigger', triggerFilter);
      return params.toString();
    },
    [statusFilter, typeFilter, triggerFilter],
  );

  // Fetch runs
  const fetchRuns = useCallback(
    async (offset: number, append: boolean) => {
      try {
        const res: BackendResponse<RunListResponse> = await window.cerebro.invoke({
          method: 'GET',
          path: `/engine/runs?${buildQuery(offset)}`,
        });
        if (res.ok) {
          if (append) {
            setRuns((prev) => [...prev, ...res.data.runs]);
          } else {
            setRuns(res.data.runs);
          }
          setTotal(res.data.total);
          setLoadError(null);
        } else {
          setLoadError('Failed to load runs');
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load runs');
      }
    },
    [buildQuery],
  );

  // Initial + filter-change fetch
  useEffect(() => {
    setIsLoading(true);
    setSelectedRunId(null);
    fetchRuns(0, false).finally(() => setIsLoading(false));
  }, [fetchRuns]);

  // Load more
  const handleLoadMore = async () => {
    setIsLoadingMore(true);
    await fetchRuns(runs.length, true);
    setIsLoadingMore(false);
  };

  // Live polling for running/paused runs (5s)
  // Track hasLive in a ref so the interval isn't torn down on every runs update
  const hasLiveRef = useRef(false);
  hasLiveRef.current = runs.some((r) => r.status === 'running' || r.status === 'paused');

  useEffect(() => {
    const id = setInterval(async () => {
      if (!hasLiveRef.current) return;
      try {
        const res: BackendResponse<RunListResponse> = await window.cerebro.invoke({
          method: 'GET',
          path: `/engine/runs?${buildQuery(0)}`,
        });
        if (res.ok) {
          setRuns((prev) => {
            // Merge first page, keep any extra loaded runs
            const firstPageIds = new Set(res.data.runs.map((r) => r.id));
            const rest = prev.slice(PAGE_SIZE).filter((r) => !firstPageIds.has(r.id));
            return [...res.data.runs, ...rest];
          });
          setTotal(res.data.total);
        }
      } catch { /* silent */ }
    }, 5000);
    return () => clearInterval(id);
  }, [buildQuery]);

  // ── Render helpers ─────────────────────────────────────────────

  const renderFilterGroup = <T extends string>(
    filters: readonly T[],
    active: T,
    setActive: (v: T) => void,
  ) => (
    <div className="flex items-center gap-1.5">
      {filters.map((f) => (
        <button
          key={f}
          onClick={() => setActive(f)}
          className={clsx(
            'px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-150',
            active === f
              ? 'bg-accent/15 text-accent border border-accent/30'
              : 'bg-bg-surface/80 text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
          )}
        >
          {FILTER_LABELS[f] ?? f}
        </button>
      ))}
    </div>
  );

  const hasMore = runs.length < total;
  const selectedRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : null;

  // ── Loading state (first load) ──────────────────────────────────

  if (isLoading && runs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-accent animate-spin" />
      </div>
    );
  }

  // ── Error state (first load) ────────────────────────────────────

  if (loadError && runs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20">
        <div className="w-16 h-16 rounded-xl border-2 border-dashed border-red-500/30 flex items-center justify-center mb-4">
          <AlertCircle size={24} className="text-red-400" />
        </div>
        <h3 className="text-sm font-medium text-text-primary mb-1.5">
          Failed to load activity
        </h3>
        <p className="text-xs text-text-tertiary mb-4 max-w-[280px] text-center">
          {loadError}
        </p>
        <button
          onClick={() => {
            setIsLoading(true);
            fetchRuns(0, false).finally(() => setIsLoading(false));
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-lg transition-colors"
        >
          <RefreshCw size={14} />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-border-subtle">
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-lg font-semibold text-text-primary">Activity</h1>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bg-elevated text-text-tertiary border border-border-subtle">
            {total} total
          </span>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          {renderFilterGroup(STATUS_FILTERS, statusFilter, setStatusFilter)}
          <div className="w-px h-4 bg-border-subtle" />
          {renderFilterGroup(TYPE_FILTERS, typeFilter, setTypeFilter)}
          <div className="w-px h-4 bg-border-subtle" />
          {renderFilterGroup(TRIGGER_FILTERS, triggerFilter, setTriggerFilter)}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {total === 0 && statusFilter === 'all' && typeFilter === 'all' && triggerFilter === 'all' ? (
          /* Empty state — no runs ever */
          <div className="flex-1 flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-border-default flex items-center justify-center mb-4">
              <Activity size={24} className="text-text-tertiary" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1.5">
              No activity yet
            </h3>
            <p className="text-xs text-text-tertiary mb-4 max-w-[280px] text-center">
              Your activity timeline will show routine runs, delegations, and orchestrations as they happen.
            </p>
            <button
              onClick={() => setActiveScreen('chat')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
            >
              <MessageSquare size={14} />
              Start a conversation
            </button>
          </div>
        ) : runs.length === 0 ? (
          /* No filter match */
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-xs text-text-tertiary">No runs match your filters.</p>
          </div>
        ) : (
          /* Run list */
          <div className="p-6 space-y-2">
            {runs.map((run, i) => (
              <RunCard
                key={run.id}
                run={run}
                index={i}
                routineName={run.routine_id ? routineNameMap.get(run.routine_id) : undefined}
                isSelected={run.id === selectedRunId}
                onClick={() => setSelectedRunId(run.id === selectedRunId ? null : run.id)}
                onNavigateApprovals={() => setActiveScreen('approvals')}
              />
            ))}

            {/* Load more */}
            {hasMore && (
              <div className="flex justify-center pt-4">
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-lg transition-colors disabled:opacity-50"
                >
                  {isLoadingMore ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <>Load more ({total - runs.length} remaining)</>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedRunId && (
        <RunDetailPanel
          runId={selectedRunId}
          routineName={
            selectedRun?.routine_id
              ? routineNameMap.get(selectedRun.routine_id)
              : undefined
          }
          onClose={() => setSelectedRunId(null)}
          onSelectRun={setSelectedRunId}
        />
      )}
    </div>
  );
}
