import clsx from 'clsx';
import type { EventRecord } from './types';
import { formatDuration, formatEventTime } from './helpers';

function describeEvent(evt: EventRecord): string {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(evt.payload_json); } catch { /* empty */ }

  // Event payloads use camelCase keys (serialised from TypeScript event objects)
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
      return `Completed: ${payload.stepName ?? payload.stepId ?? 'step'}${payload.summary ? ` \u2014 '${payload.summary}'` : ''}`;
    case 'step_failed':
      return `Failed: ${payload.stepName ?? payload.stepId ?? 'step'}${payload.error ? ` \u2014 ${payload.error}` : ''}`;
    case 'step_skipped':
      return `Skipped: ${payload.stepName ?? payload.stepId ?? 'step'}${payload.reason ? ` \u2014 ${payload.reason}` : ''}`;
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

function eventColor(eventType: string): string {
  if (eventType.includes('completed') || eventType === 'approval_granted') return 'text-green-500';
  if (eventType.includes('failed') || eventType === 'approval_denied') return 'text-red-400';
  if (eventType === 'approval_requested') return 'text-amber-400';
  if (eventType === 'action_tool_end') return 'text-cyan-500';
  if (eventType === 'action_tool_start' || eventType === 'action_text_delta') return 'text-text-tertiary';
  if (eventType === 'step_log') return 'text-text-tertiary';
  return 'text-text-secondary';
}

interface EventLogProps {
  events: EventRecord[];
}

export default function EventLog({ events }: EventLogProps) {
  if (events.length === 0) {
    return <p className="text-xs text-text-tertiary">No events recorded.</p>;
  }

  return (
    <div className="space-y-0.5">
      {events.map((evt) => (
        <div key={evt.id} className="flex items-start gap-3 py-1">
          <span className="text-[10px] font-mono tabular-nums text-text-tertiary flex-shrink-0 pt-px">
            {formatEventTime(evt.timestamp)}
          </span>
          <span className={clsx('text-[11px] leading-relaxed', eventColor(evt.event_type))}>
            {describeEvent(evt)}
          </span>
        </div>
      ))}
    </div>
  );
}
