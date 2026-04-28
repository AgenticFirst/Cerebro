import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, Loader2, SkipForward, Clock, ChevronRight, ShieldCheck, ShieldX, FileText } from 'lucide-react';
import clsx from 'clsx';
import type { StepRecord, EventRecord } from './types';
import { formatDuration, formatTimestamp, formatEventTime } from './helpers';
import JsonSection from './JsonSection';

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 size={12} className="animate-spin text-yellow-500" />;
    case 'completed':
      return <CheckCircle2 size={12} className="text-green-500" />;
    case 'failed':
      return <XCircle size={12} className="text-red-500" />;
    case 'skipped':
      return <SkipForward size={12} className="text-text-tertiary" />;
    default:
      return <Clock size={12} className="text-zinc-400" />;
  }
}

interface StepLog {
  message: string;
  time: string;
}

function buildStepLogs(events: EventRecord[]): Map<string, StepLog[]> {
  const map = new Map<string, StepLog[]>();
  for (const evt of events) {
    if (evt.event_type !== 'step_log' || !evt.step_id) continue;
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(evt.payload_json); } catch { /* empty */ }
    const logs = map.get(evt.step_id) ?? [];
    logs.push({
      message: String(payload.message ?? payload.log ?? ''),
      time: evt.timestamp,
    });
    map.set(evt.step_id, logs);
  }
  return map;
}

interface StepTimelineProps {
  steps: StepRecord[];
  events?: EventRecord[];
  onOpenLogs?: () => void;
}

export default function StepTimeline({ steps, events = [], onOpenLogs }: StepTimelineProps) {
  const { t } = useTranslation();
  const sorted = useMemo(() => [...steps].sort((a, b) => a.order_index - b.order_index), [steps]);
  const stepLogs = useMemo(() => buildStepLogs(events), [events]);

  // Auto-expand any failed/running steps so the user doesn't have to hunt
  // for the row that broke. Multiple failed steps can be open at once.
  const initialExpanded = useMemo(() => {
    const set = new Set<string>();
    for (const s of sorted) {
      if (s.status === 'failed' || s.status === 'running') set.add(s.id);
    }
    return set;
  }, [sorted]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(initialExpanded);

  // Re-sync auto-expansion when the underlying step set changes (e.g., live
  // poll updates while a run is in flight).
  useEffect(() => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const id of initialExpanded) next.add(id);
      return next;
    });
  }, [initialExpanded]);

  const toggle = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (sorted.length === 0) {
    return <p className="text-xs text-text-tertiary">{t('activity.noStepsRecorded')}</p>;
  }

  return (
    <div className="space-y-1">
      {sorted.map((step, i) => {
        const isExpanded = expandedIds.has(step.id);
        const logs = stepLogs.get(step.step_id) ?? [];
        const isFailed = step.status === 'failed';

        return (
          <div
            key={step.id}
            className={clsx(
              'animate-step-in rounded-md',
              isFailed && 'bg-red-500/[0.03] border border-red-500/15 px-1',
            )}
            style={{ animationDelay: `${i * 50}ms` }}
          >
            {/* Collapsed row — clickable */}
            <button
              onClick={() => toggle(step.id)}
              className="w-full flex items-start gap-2.5 py-2 text-left hover:bg-bg-hover/50 rounded-md px-1 -mx-1 transition-colors"
            >
              <span className="w-4 text-right text-[10px] tabular-nums text-text-tertiary pt-px flex-shrink-0">
                {i + 1}
              </span>

              <ChevronRight
                size={12}
                className={clsx(
                  'text-text-tertiary flex-shrink-0 mt-px transition-transform duration-150',
                  isExpanded && 'rotate-90',
                )}
              />

              <div className="pt-px flex-shrink-0">
                <StepIcon status={step.status} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={clsx(
                    'text-xs truncate',
                    isFailed ? 'text-text-primary font-medium' : 'text-text-primary',
                  )}>
                    {step.step_name}
                  </span>
                  <span className="inline-block bg-bg-elevated text-text-tertiary border border-border-subtle text-[9px] rounded px-1 py-0.5 flex-shrink-0">
                    {step.action_type}
                  </span>
                  {step.approval_id && step.approval_status && (
                    <span className={clsx(
                      'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0',
                      step.approval_status === 'approved' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400',
                    )}>
                      {step.approval_status === 'approved' ? <ShieldCheck size={9} /> : <ShieldX size={9} />}
                      {step.approval_status === 'approved' ? 'Approved' : 'Denied'}
                    </span>
                  )}
                  <span className="text-[10px] tabular-nums text-text-tertiary flex-shrink-0 ml-auto">
                    {formatDuration(step.duration_ms)}
                  </span>
                </div>
                {!isExpanded && step.summary && !isFailed && (
                  <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2 italic">
                    &ldquo;{step.summary}&rdquo;
                  </p>
                )}
                {!isExpanded && step.error && (
                  <p className="text-[11px] text-red-400 mt-0.5 line-clamp-2">
                    {step.error}
                  </p>
                )}
              </div>
            </button>

            {/* Expanded detail — error block first when failed */}
            {isExpanded && (
              <div className="ml-[26px] space-y-2.5 pb-2">
                {/* Error block — surfaced first so the cause is the
                    first thing readers see, not last. */}
                {step.error && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 space-y-2">
                    <p className="text-[11px] text-red-400 leading-relaxed whitespace-pre-wrap break-all">
                      {step.error}
                    </p>
                    {onOpenLogs && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onOpenLogs(); }}
                        className="inline-flex items-center gap-1 text-[10px] font-medium text-accent hover:text-accent-hover transition-colors"
                      >
                        <FileText size={10} />
                        {t('activity.openInLogs')}
                      </button>
                    )}
                  </div>
                )}

                {/* Timestamps */}
                <div className="space-y-0.5 text-[11px] text-text-tertiary">
                  <div>{t('activity.started')}: <span className="text-text-secondary">{formatTimestamp(step.started_at, t)}</span></div>
                  <div>{t('activity.finished')}: <span className="text-text-secondary">{formatTimestamp(step.completed_at, t)}</span></div>
                </div>

                {/* Summary */}
                {step.summary && (
                  <p className="text-[11px] text-text-secondary italic">
                    &ldquo;{step.summary}&rdquo;
                  </p>
                )}

                {/* Step logs */}
                {logs.length > 0 && (
                  <div className="border-l-2 border-border-subtle pl-2 space-y-1">
                    {logs.map((log, li) => (
                      <div key={li} className="flex items-start gap-2">
                        <span className="text-[10px] font-mono tabular-nums text-text-tertiary flex-shrink-0">
                          {formatEventTime(log.time)}
                        </span>
                        <span className="text-[11px] text-text-secondary leading-relaxed">
                          {log.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Input / Output JSON — auto-open input on failed steps so
                    the user can see exactly what config the engine had. */}
                <JsonSection label="Input" json={step.input_json} defaultOpen={isFailed} />
                <JsonSection label="Output" json={step.output_json} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
