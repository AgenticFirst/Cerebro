import { useState, useMemo } from 'react';
import { CheckCircle2, XCircle, Loader2, SkipForward, Clock, ChevronRight, ShieldCheck, ShieldX } from 'lucide-react';
import clsx from 'clsx';
import type { StepRecord, EventRecord } from './types';
import { formatDuration, formatTimestamp, formatEventTime } from './helpers';

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

// ── Collapsible JSON section ───────────────────────────────────

function JsonSection({ label, json }: { label: string; json: string | null }) {
  const [open, setOpen] = useState(false);
  if (!json) return null;

  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    formatted = json;
  }

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-[10px] font-medium text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <ChevronRight
          size={10}
          className={clsx('transition-transform duration-150', open && 'rotate-90')}
        />
        {label}
      </button>
      {open && (
        <pre className="bg-bg-base rounded-md px-2.5 py-2 font-mono text-[10px] text-text-secondary mt-1 max-h-[200px] overflow-auto scrollbar-thin whitespace-pre-wrap break-all">
          {formatted}
        </pre>
      )}
    </div>
  );
}

// ── Step logs helper ───────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────

interface StepTimelineProps {
  steps: StepRecord[];
  events?: EventRecord[];
}

export default function StepTimeline({ steps, events = [] }: StepTimelineProps) {
  const sorted = useMemo(() => [...steps].sort((a, b) => a.order_index - b.order_index), [steps]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const stepLogs = useMemo(() => buildStepLogs(events), [events]);

  if (sorted.length === 0) {
    return <p className="text-xs text-text-tertiary">No steps recorded.</p>;
  }

  return (
    <div className="space-y-1">
      {sorted.map((step, i) => {
        const isExpanded = expandedId === step.id;
        const logs = stepLogs.get(step.step_id) ?? [];

        return (
          <div
            key={step.id}
            className="animate-step-in"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            {/* Collapsed row — clickable */}
            <button
              onClick={() => setExpandedId(isExpanded ? null : step.id)}
              className="w-full flex items-start gap-2.5 py-2 text-left hover:bg-bg-hover/50 rounded-md px-1 -mx-1 transition-colors"
            >
              {/* Step number */}
              <span className="w-4 text-right text-[10px] tabular-nums text-text-tertiary pt-px flex-shrink-0">
                {i + 1}
              </span>

              {/* Expand chevron */}
              <ChevronRight
                size={12}
                className={clsx(
                  'text-text-tertiary flex-shrink-0 mt-px transition-transform duration-150',
                  isExpanded && 'rotate-90',
                )}
              />

              {/* Icon */}
              <div className="pt-px flex-shrink-0">
                <StepIcon status={step.status} />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-primary truncate">{step.step_name}</span>
                  {step.approval_id && step.approval_status && (
                    <span className={clsx(
                      'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0',
                      step.approval_status === 'approved' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400',
                    )}>
                      {step.approval_status === 'approved' ? <ShieldCheck size={9} /> : <ShieldX size={9} />}
                      {step.approval_status === 'approved' ? 'Approved' : 'Denied'}
                    </span>
                  )}
                  <span className="text-[10px] tabular-nums text-text-tertiary flex-shrink-0">
                    {formatDuration(step.duration_ms)}
                  </span>
                </div>
                {!isExpanded && step.summary && (
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

            {/* Expanded detail */}
            {isExpanded && (
              <div className="ml-[26px] space-y-2.5 pb-2">
                {/* Action type badge */}
                <span className="inline-block bg-bg-elevated text-text-tertiary border border-border-subtle text-[10px] rounded px-1.5 py-0.5">
                  {step.action_type}
                </span>

                {/* Timestamps */}
                <div className="space-y-0.5 text-[11px] text-text-tertiary">
                  <div>Started: <span className="text-text-secondary">{formatTimestamp(step.started_at)}</span></div>
                  <div>Finished: <span className="text-text-secondary">{formatTimestamp(step.completed_at)}</span></div>
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

                {/* Input / Output JSON */}
                <JsonSection label="Input" json={step.input_json} />
                <JsonSection label="Output" json={step.output_json} />

                {/* Error */}
                {step.error && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2.5">
                    <p className="text-[11px] text-red-400 leading-relaxed">{step.error}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
