import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { EventRecord } from './types';
import { formatDuration, formatEventTime } from './helpers';

type FilterKey = 'all' | 'errors' | 'tools' | 'logs' | 'lifecycle';

const ERROR_TYPES = new Set(['run_failed', 'step_failed', 'run_cancelled', 'approval_denied']);
const TOOL_TYPES = new Set(['action_tool_start', 'action_tool_end', 'action_text_delta']);
const LOG_TYPES = new Set(['step_log']);
const LIFECYCLE_TYPES = new Set([
  'run_started', 'run_completed',
  'step_queued', 'step_started', 'step_completed', 'step_skipped',
  'approval_requested', 'approval_granted',
]);

function isErrorEvent(evt: EventRecord): boolean {
  if (ERROR_TYPES.has(evt.event_type)) return true;
  if (evt.event_type === 'action_tool_end') {
    try {
      const p = JSON.parse(evt.payload_json);
      return Boolean(p.isError);
    } catch { return false; }
  }
  return false;
}

function describeEvent(evt: EventRecord): string {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(evt.payload_json); } catch { /* empty */ }

  switch (evt.event_type) {
    case 'run_started':
      return `Run started (${payload.totalSteps ?? '?'} steps)`;
    case 'run_completed': {
      const dur = payload.durationMs != null ? Number(payload.durationMs) : null;
      return `Run completed in ${dur != null && !isNaN(dur) ? formatDuration(dur) : '?'}`;
    }
    case 'run_failed':
      return `Run failed: ${payload.error ?? 'Unknown error'}`;
    case 'run_cancelled':
      return `Run cancelled${payload.reason ? `: ${payload.reason}` : ''}`;
    case 'step_queued':
      return `Queued: ${payload.stepName ?? 'step'}`;
    case 'step_started':
      return `Started: ${payload.stepName ?? 'step'}`;
    case 'step_completed':
      return `Completed: ${payload.stepName ?? payload.stepId ?? 'step'}${payload.summary ? ` — '${payload.summary}'` : ''}`;
    case 'step_failed':
      return `Failed: ${payload.stepName ?? payload.stepId ?? 'step'}${payload.error ? ` — ${payload.error}` : ''}`;
    case 'step_skipped':
      return `Skipped: ${payload.stepName ?? payload.stepId ?? 'step'}${payload.reason ? ` — ${payload.reason}` : ''}`;
    case 'approval_requested':
      return `Approval requested: ${payload.summary ?? 'step'}`;
    case 'approval_granted':
      return `Approval granted${payload.stepId ? ` (${payload.stepId})` : ''}`;
    case 'approval_denied':
      return `Approval denied${payload.reason ? `: ${payload.reason}` : ''}`;
    case 'step_log':
      return `${payload.message ?? String(payload.log ?? evt.event_type)}`;
    case 'action_tool_start':
      return `Tool: ${payload.toolName ?? 'unknown'}`;
    case 'action_tool_end':
      return `Tool done: ${payload.toolName ?? 'unknown'}${payload.isError ? ' (error)' : ''}`;
    case 'action_text_delta':
      return 'LLM text output';
    default:
      return evt.event_type.replace(/_/g, ' ');
  }
}

function eventColor(evt: EventRecord): string {
  if (isErrorEvent(evt)) return 'text-red-400';
  if (evt.event_type.includes('completed') || evt.event_type === 'approval_granted') return 'text-green-500';
  if (evt.event_type === 'approval_requested') return 'text-amber-400';
  if (evt.event_type === 'action_tool_end') return 'text-cyan-500';
  if (evt.event_type === 'action_tool_start' || evt.event_type === 'action_text_delta') return 'text-text-tertiary';
  if (evt.event_type === 'step_log') return 'text-text-tertiary';
  return 'text-text-secondary';
}

function prettyPayload(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

interface EventLogProps {
  events: EventRecord[];
}

export default function EventLog({ events }: EventLogProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Pre-compute counts so the chips can show how much each filter holds
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: events.length, errors: 0, tools: 0, logs: 0, lifecycle: 0 };
    for (const evt of events) {
      if (isErrorEvent(evt)) c.errors += 1;
      if (TOOL_TYPES.has(evt.event_type)) c.tools += 1;
      if (LOG_TYPES.has(evt.event_type)) c.logs += 1;
      if (LIFECYCLE_TYPES.has(evt.event_type)) c.lifecycle += 1;
    }
    return c;
  }, [events]);

  const filtered = useMemo(() => {
    switch (filter) {
      case 'errors': return events.filter(isErrorEvent);
      case 'tools': return events.filter((e) => TOOL_TYPES.has(e.event_type));
      case 'logs': return events.filter((e) => LOG_TYPES.has(e.event_type));
      case 'lifecycle': return events.filter((e) => LIFECYCLE_TYPES.has(e.event_type));
      default: return events;
    }
  }, [events, filter]);

  if (events.length === 0) {
    return <p className="text-xs text-text-tertiary">No events recorded.</p>;
  }

  const filters: { key: FilterKey; label: string; count: number }[] = [
    { key: 'all', label: t('activity.eventFilterAll'), count: counts.all },
    { key: 'errors', label: t('activity.eventFilterErrors'), count: counts.errors },
    { key: 'tools', label: t('activity.eventFilterTools'), count: counts.tools },
    { key: 'logs', label: t('activity.eventFilterLogs'), count: counts.logs },
    { key: 'lifecycle', label: t('activity.eventFilterLifecycle'), count: counts.lifecycle },
  ];

  return (
    <div className="space-y-2">
      {/* Filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 -mt-1">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            disabled={f.count === 0 && f.key !== 'all'}
            className={clsx(
              'px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors',
              'disabled:opacity-40 disabled:cursor-not-allowed',
              filter === f.key
                ? f.key === 'errors'
                  ? 'bg-red-500/15 text-red-300 border border-red-500/30'
                  : 'bg-accent/15 text-accent border border-accent/30'
                : 'bg-bg-elevated text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
            )}
          >
            {f.label} <span className="opacity-60">({f.count})</span>
          </button>
        ))}
      </div>

      {/* Event rows */}
      {filtered.length === 0 ? (
        <p className="text-xs text-text-tertiary py-3">{t('activity.eventFilterEmpty')}</p>
      ) : (
        <div className="space-y-0.5">
          {filtered.map((evt) => {
            const isOpen = expandedId === evt.id;
            return (
              <div key={evt.id}>
                <button
                  onClick={() => setExpandedId(isOpen ? null : evt.id)}
                  className="w-full flex items-start gap-2.5 py-1 px-1 -mx-1 rounded text-left hover:bg-bg-hover/50 transition-colors"
                >
                  <ChevronRight
                    size={10}
                    className={clsx(
                      'text-text-tertiary flex-shrink-0 mt-1 transition-transform duration-150',
                      isOpen && 'rotate-90',
                    )}
                  />
                  <span className="text-[10px] font-mono tabular-nums text-text-tertiary flex-shrink-0 pt-px">
                    {formatEventTime(evt.timestamp)}
                  </span>
                  <span className={clsx('text-[11px] leading-relaxed flex-1 min-w-0 break-words', eventColor(evt))}>
                    {describeEvent(evt)}
                  </span>
                </button>
                {isOpen && (
                  <pre className="ml-[26px] mt-1 mb-1.5 bg-bg-base rounded-md px-2.5 py-2 font-mono text-[10px] text-text-secondary max-h-[240px] overflow-auto scrollbar-thin whitespace-pre-wrap break-all">
                    {prettyPayload(evt.payload_json)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
