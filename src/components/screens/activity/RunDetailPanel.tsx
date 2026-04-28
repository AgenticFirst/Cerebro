import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import type { RunRecord, EventRecord, RunListResponse } from './types';
import { formatDuration, formatTimestamp, humanizeRunError, STATUS_CONFIG } from './helpers';
import StatusDot from './StatusDot';
import StepTimeline from './StepTimeline';
import EventLog from './EventLog';
import RunLogs from './RunLogs';

// ── Section helper ─────────���────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-2.5">
        {label}
      </h4>
      {children}
    </div>
  );
}

// ── Tabs ──────────────���─────────────────────────────────────────

type Tab = 'steps' | 'events' | 'children' | 'logs';

// ── Component ───────��──────────────────────────────────────────

interface RunDetailPanelProps {
  runId: string;
  routineName?: string;
  onClose: () => void;
  onSelectRun?: (runId: string) => void;
}

export default function RunDetailPanel({ runId, routineName, onClose, onSelectRun }: RunDetailPanelProps) {
  const { t } = useTranslation();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [children, setChildren] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('steps');

  /**
   * `silent: true` skips toggling the loading flag — used by the live-poll
   * interval so the panel content doesn't unmount/remount every 5 seconds
   * and lose user expansion state. Initial mount and the manual refresh
   * button still flash the spinner.
   */
  const fetchDetail = useCallback(async (id: string, signal: { cancelled: boolean }, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setLoadError(false);
    try {
      const [runRes, eventsRes, childrenRes] = await Promise.allSettled([
        window.cerebro.invoke<RunRecord>({ method: 'GET', path: `/engine/runs/${id}` }),
        window.cerebro.invoke<EventRecord[]>({ method: 'GET', path: `/engine/runs/${id}/events?limit=500` }),
        window.cerebro.invoke<RunListResponse>({ method: 'GET', path: `/engine/runs/${id}/children` }),
      ]);
      if (signal.cancelled) return;

      const runOk = runRes.status === 'fulfilled' && runRes.value.ok;
      const eventsOk = eventsRes.status === 'fulfilled' && eventsRes.value.ok;
      const childrenOk = childrenRes.status === 'fulfilled' && childrenRes.value.ok;

      if (runOk) setRun(runRes.value.data);
      if (eventsOk) setEvents(eventsRes.value.data);
      if (childrenOk) setChildren(childrenRes.value.data.runs);

      // Only show error if all three failed
      if (!runOk && !eventsOk && !childrenOk) setLoadError(true);
    } catch {
      if (!signal.cancelled) setLoadError(true);
    } finally {
      if (!signal.cancelled && !opts?.silent) setLoading(false);
    }
  }, []);

  // Fetch on mount / runId change
  useEffect(() => {
    const signal = { cancelled: false };
    setActiveTab('steps');
    fetchDetail(runId, signal);
    return () => { signal.cancelled = true; };
  }, [runId, fetchDetail]);

  // Live refresh for running/paused runs (5s) — silent so the panel
  // doesn't flash the loading spinner and unmount the Steps tab every
  // poll. The user keeps whatever they had expanded.
  const isLive = run?.status === 'running' || run?.status === 'paused';
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => {
      fetchDetail(runIdRef.current, { cancelled: false }, { silent: true });
    }, 5000);
    return () => clearInterval(id);
  }, [isLive, fetchDetail]);

  const cfg = run ? (STATUS_CONFIG[run.status] ?? STATUS_CONFIG.created) : STATUS_CONFIG.created;
  const displayName = routineName ?? (run ? t(`activity.filter.${run.run_type}`, { defaultValue: run.run_type }) : t('activity.run'));
  const hasChildren = children.length > 0;

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'steps', label: t('activity.tabSteps'), show: true },
    { key: 'events', label: t('activity.tabEvents'), show: true },
    { key: 'children', label: t('activity.tabChildren'), show: hasChildren },
    { key: 'logs', label: t('activity.tabLogs'), show: true },
  ];

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[380px] bg-bg-surface border-l border-border-subtle animate-slide-in-right z-10 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
        <h3 className="text-sm font-semibold text-text-primary tracking-wide">
          {t('activity.runDetails')}
        </h3>
        <div className="flex items-center gap-1">
          {!loading && run && (
            <button
              onClick={() => fetchDetail(runId, { cancelled: false })}
              className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
              title={t('common.retry')}
            >
              <RefreshCw size={14} />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-5 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="text-accent animate-spin" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <p className="text-xs text-text-tertiary">{t('activity.failedToLoadDetails')}</p>
            <button
              onClick={() => fetchDetail(runId, { cancelled: false })}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-lg transition-colors"
            >
              <RefreshCw size={14} />
              {t('common.retry')}
            </button>
          </div>
        ) : run ? (
          <>
            {/* Run info */}
            <Section label={t('activity.run')}>
              <div className="space-y-2.5">
                <div className="text-sm font-medium text-text-primary">{displayName}</div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <StatusDot status={run.status} />
                    <span className={clsx('text-xs font-medium', cfg.text)}>{t(`status.${run.status}`, { defaultValue: run.status })}</span>
                  </div>
                  <span className="text-xs tabular-nums text-text-secondary">
                    {formatDuration(run.duration_ms)}
                  </span>
                  <span className="text-xs text-text-tertiary">
                    {t(`triggers.${run.trigger}`, { defaultValue: run.trigger })}
                  </span>
                </div>
                <div className="space-y-1 text-[11px] text-text-tertiary">
                  <div>{t('activity.started')}: <span className="text-text-secondary">{formatTimestamp(run.started_at, t)}</span></div>
                  <div>{t('activity.finished')}: <span className="text-text-secondary">{formatTimestamp(run.completed_at, t)}</span></div>
                </div>
                {run.status === 'failed' && run.error && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
                    <p className="text-[11px] text-red-400 leading-relaxed">
                      {humanizeRunError(run.error, run.steps) ?? run.error}
                    </p>
                  </div>
                )}
              </div>
            </Section>

            {/* Tab switcher */}
            <div className="border-b border-border-subtle flex gap-4">
              {tabs.filter(tb => tb.show).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={clsx(
                    'pb-2 text-xs font-medium transition-colors -mb-px border-b-2',
                    activeTab === tab.key
                      ? 'border-accent text-accent'
                      : 'border-transparent text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {activeTab === 'steps' && (
              <StepTimeline
                steps={run.steps ?? []}
                events={events}
                dagJson={run.dag_json}
                onOpenLogs={() => setActiveTab('logs')}
              />
            )}
            {activeTab === 'logs' && (
              <RunLogs run={run} events={events} />
            )}
            {activeTab === 'events' && (
              <EventLog events={events} />
            )}
            {activeTab === 'children' && (
              <div className="space-y-1.5">
                {children.map((child) => {
                  const childCfg = STATUS_CONFIG[child.status] ?? STATUS_CONFIG.created;
                  return (
                    <button
                      key={child.id}
                      onClick={() => onSelectRun?.(child.id)}
                      className="w-full flex items-center gap-2.5 bg-bg-base rounded-lg px-3 py-2 border border-border-subtle hover:border-border-default hover:bg-bg-hover transition-colors text-left"
                    >
                      <StatusDot status={child.status} />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-text-primary truncate block">
                          {t(`activity.filter.${child.run_type}`, { defaultValue: child.run_type })}
                        </span>
                      </div>
                      <span className="text-[10px] tabular-nums text-text-tertiary">
                        {formatDuration(child.duration_ms)}
                      </span>
                      <span className={clsx('text-[10px] font-medium', childCfg.text)}>
                        {t(`status.${child.status}`, { defaultValue: child.status })}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-text-tertiary text-center py-8">{t('activity.runNotFound')}</p>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border-subtle flex-shrink-0">
        <code className="text-[10px] font-mono text-text-tertiary">
          {runId.length > 24 ? `${runId.slice(0, 24)}\u2026` : runId}
        </code>
      </div>
    </div>
  );
}
