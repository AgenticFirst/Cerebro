import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import type { StepRecord, EventRecord } from './types';
import { formatEventTime, parseServerTimestamp } from './helpers';
import { useElapsed } from './useElapsed';

interface StepLiveActivityProps {
  step: StepRecord;
  events: EventRecord[];
  /** Cap how many events we render. Default 12. */
  limit?: number;
}

const SHOW_TYPES = new Set([
  'step_log',
  'agent_idle_warning',
  'subprocess_stderr',
  'action_tool_start',
  'action_tool_end',
  'action_text_delta',
]);

interface Row {
  id: string;
  ts: string;
  text: string;
  tone: 'normal' | 'warn' | 'tool' | 'stderr';
}

/**
 * Live event feed for a single step. Filters the run's event stream down
 * to events scoped to this step that are interesting in real time
 * (logs, idle warnings, stderr, tool calls). Renders a hung-step warning
 * when the step is running but its last event is more than 30s old.
 */
export default function StepLiveActivity({ step, events, limit = 12 }: StepLiveActivityProps) {
  const { t } = useTranslation();

  const rows = useMemo<Row[]>(() => {
    return events
      .filter((e) => e.step_id === step.step_id && SHOW_TYPES.has(e.event_type))
      .slice(-limit)
      .map<Row>((evt) => {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(evt.payload_json); } catch { /* empty */ }

        switch (evt.event_type) {
          case 'step_log':
            return {
              id: evt.id,
              ts: evt.timestamp,
              text: String(payload.message ?? payload.log ?? ''),
              tone: String(payload.message ?? '').toLowerCase().includes('[stderr]') ? 'stderr' : 'normal',
            };
          case 'agent_idle_warning': {
            const sec = Math.round(Number(payload.elapsedMs ?? 0) / 1000);
            return {
              id: evt.id,
              ts: evt.timestamp,
              text: t('liveActivity.idleWarning', { sec }),
              tone: 'warn',
            };
          }
          case 'subprocess_stderr':
            return { id: evt.id, ts: evt.timestamp, text: `[stderr] ${payload.line ?? ''}`, tone: 'stderr' };
          case 'action_tool_start':
            return { id: evt.id, ts: evt.timestamp, text: t('liveActivity.toolStart', { tool: payload.toolName ?? 'tool' }), tone: 'tool' };
          case 'action_tool_end':
            return {
              id: evt.id,
              ts: evt.timestamp,
              text: t('liveActivity.toolEnd', { tool: payload.toolName ?? 'tool' }) + (payload.isError ? ' (error)' : ''),
              tone: payload.isError ? 'warn' : 'tool',
            };
          case 'action_text_delta':
            return { id: evt.id, ts: evt.timestamp, text: t('liveActivity.textDelta'), tone: 'normal' };
          default:
            return { id: evt.id, ts: evt.timestamp, text: evt.event_type, tone: 'normal' };
        }
      });
  }, [events, step.step_id, limit, t]);

  // Hung detection: status running, last event for this step > 30s ago.
  const lastTs = rows.length > 0 ? rows[rows.length - 1].ts : step.started_at;
  // Tick every second while the step is running so the "30s old" threshold
  // re-checks live.
  useElapsed(lastTs, step.status === 'running');
  const lastTsMs = lastTs ? parseServerTimestamp(lastTs) : NaN;
  const isHung = step.status === 'running' && !Number.isNaN(lastTsMs) &&
    Date.now() - lastTsMs > 30_000;

  if (rows.length === 0 && step.status !== 'running') {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h5 className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
          {t('liveActivity.title')}
        </h5>
        {rows.length > 0 && (
          <span className="text-[10px] text-text-tertiary tabular-nums">
            {rows.length}
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <div className="space-y-0.5 max-h-[240px] overflow-y-auto scrollbar-thin border-l-2 border-border-subtle pl-2">
          {rows.map((row) => (
            <div key={row.id} className="flex items-start gap-2">
              <span className="text-[10px] font-mono tabular-nums text-text-tertiary flex-shrink-0">
                {formatEventTime(row.ts)}
              </span>
              <span className={clsx(
                'text-[11px] leading-relaxed break-words',
                row.tone === 'warn' && 'text-amber-300',
                row.tone === 'stderr' && 'text-orange-300/80 font-mono text-[10px]',
                row.tone === 'tool' && 'text-cyan-400',
                row.tone === 'normal' && 'text-text-secondary',
              )}>
                {row.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {isHung && (
        <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] p-2.5 flex items-start gap-2">
          <AlertTriangle size={12} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[11px] font-medium text-amber-300 leading-relaxed">
              {t('liveActivity.hungTitle')}
            </p>
            <p className="text-[11px] text-amber-200/80 leading-relaxed mt-1">
              {t('liveActivity.hungBody')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
