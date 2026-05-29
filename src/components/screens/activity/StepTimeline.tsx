import { useState, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, Loader2, SkipForward, Clock, ChevronRight, ShieldCheck, ShieldX, FileText } from 'lucide-react';
import clsx from 'clsx';
import type { StepRecord, EventRecord } from './types';
import { formatDuration, formatTimestamp } from './helpers';
import { useElapsed, formatElapsedShort } from './useElapsed';
import JsonSection from './JsonSection';
import StepStatusBanner from './StepStatusBanner';
import StepConfigSummary from './StepConfigSummary';
import StepLiveActivity from './StepLiveActivity';

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

interface StepTimelineProps {
  steps: StepRecord[];
  events?: EventRecord[];
  /** Serialized DAG (from `run.dag_json`). Required for showing the
   *  user's configured params in the per-step config preview. */
  dagJson?: string | null;
  onOpenLogs?: () => void;
}

export default function StepTimeline({ steps, events = [], dagJson, onOpenLogs }: StepTimelineProps) {
  const { t } = useTranslation();
  const sorted = useMemo(() => [...steps].sort((a, b) => a.order_index - b.order_index), [steps]);

  // Auto-expand failed/running steps, but only ONCE per step. The previous
  // implementation re-merged on every poll, so manually collapsing a
  // running step popped it back open 5 seconds later. Now we record which
  // step IDs we've already auto-expanded and never auto-expand the same
  // step twice — the user's collapse is honored on subsequent polls.
  const seenAutoExpandedRef = useRef<Set<string>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const seen = seenAutoExpandedRef.current;
    const newAutoExpand: string[] = [];
    for (const s of sorted) {
      if ((s.status === 'failed' || s.status === 'running') && !seen.has(s.id)) {
        seen.add(s.id);
        newAutoExpand.push(s.id);
      }
    }
    if (newAutoExpand.length > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of newAutoExpand) next.add(id);
        return next;
      });
    }
  }, [sorted]);

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
            {/* Collapsed row */}
            <CollapsedRow
              step={step}
              index={i}
              isExpanded={isExpanded}
              onClick={() => toggle(step.id)}
            />

            {/* Expanded detail */}
            {isExpanded && (
              <ExpandedDetail
                step={step}
                allSteps={sorted}
                events={events}
                dagJson={dagJson}
                onOpenLogs={onOpenLogs}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Collapsed row ─────────────────────────────────────────────────────

interface CollapsedRowProps {
  step: StepRecord;
  index: number;
  isExpanded: boolean;
  onClick: () => void;
}

function CollapsedRow({ step, index, isExpanded, onClick }: CollapsedRowProps) {
  // Live elapsed counter for running steps shown in the collapsed row's
  // right-edge slot in place of the static duration.
  const elapsedMs = useElapsed(step.started_at, step.status === 'running');
  const isFailed = step.status === 'failed';

  const durationLabel = step.status === 'running'
    ? formatElapsedShort(elapsedMs)
    : formatDuration(step.duration_ms);

  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-2.5 py-2 text-left hover:bg-bg-hover/50 rounded-md px-1 -mx-1 transition-colors"
    >
      <span className="w-4 text-right text-[10px] tabular-nums text-text-tertiary pt-px flex-shrink-0">
        {index + 1}
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
          <span className={clsx('text-xs truncate', isFailed && 'font-medium', 'text-text-primary')}>
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
            {durationLabel}
          </span>
        </div>
        {!isExpanded && step.error && (
          <p className="text-[11px] text-red-400 mt-0.5 line-clamp-2">
            {step.error}
          </p>
        )}
        {!isExpanded && !step.error && step.summary && step.status !== 'failed' && (
          <p className="text-[11px] text-text-secondary mt-0.5 line-clamp-2 italic">
            &ldquo;{step.summary}&rdquo;
          </p>
        )}
      </div>
    </button>
  );
}

// ── Expanded detail ───────────────────────────────────────────────────

interface ExpandedDetailProps {
  step: StepRecord;
  allSteps: StepRecord[];
  events: EventRecord[];
  dagJson?: string | null;
  onOpenLogs?: () => void;
}

function ExpandedDetail({ step, allSteps, events, dagJson, onOpenLogs }: ExpandedDetailProps) {
  const { t } = useTranslation();
  return (
    <div className="ml-[26px] space-y-3 pb-2.5">
      {/* Error block — first when failed so the cause leads. */}
      {step.error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 space-y-2">
          <p className="text-[11px] text-red-400 leading-relaxed whitespace-pre-wrap break-words">
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

      {/* Status banner — live state for queued/running/completed. */}
      <StepStatusBanner step={step} allSteps={allSteps} events={events} />

      {/* Action-specific configuration preview. */}
      <StepConfigSummary step={step} dagJson={dagJson} />

      {/* Live activity feed (running steps + recent failures). */}
      <StepLiveActivity step={step} events={events} />

      {/* Summary text from the step's output. */}
      {step.summary && (
        <p className="text-[11px] text-text-secondary italic">
          &ldquo;{step.summary}&rdquo;
        </p>
      )}

      {/* Timestamps (compact). */}
      <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
        <span>
          {t('activity.started')}: <span className="text-text-secondary">{formatTimestamp(step.started_at, t)}</span>
        </span>
        {step.completed_at && (
          <span>
            {t('activity.finished')}: <span className="text-text-secondary">{formatTimestamp(step.completed_at, t)}</span>
          </span>
        )}
      </div>

      {/* Raw I/O — collapsed. The user can still drop into JSON if they want. */}
      <div className="space-y-1.5">
        <JsonSection label={t('stepConfig.rawInput')} json={step.input_json} />
        <JsonSection label={t('stepConfig.rawOutput')} json={step.output_json} />
      </div>
    </div>
  );
}
