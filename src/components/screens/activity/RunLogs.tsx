import { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import type { RunRecord, EventRecord } from './types';
import { formatEventTime, humanizeRunError } from './helpers';
import { useToast } from '../../../context/ToastContext';
import JsonSection from './JsonSection';

interface RunLogsProps {
  run: RunRecord;
  events: EventRecord[];
}

function prettyPayload(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function buildPlainTextDump(run: RunRecord, events: EventRecord[]): string {
  const lines: string[] = [];
  lines.push(`Run ${run.id}`);
  lines.push(`  status: ${run.status}`);
  lines.push(`  started: ${run.started_at}`);
  lines.push(`  finished: ${run.completed_at ?? '—'}`);
  if (run.duration_ms != null) lines.push(`  duration_ms: ${run.duration_ms}`);
  if (run.error) lines.push(`  error: ${run.error}`);
  if (run.failed_step_id) lines.push(`  failed_step_id: ${run.failed_step_id}`);
  lines.push('');

  for (const step of run.steps ?? []) {
    if (step.status !== 'failed' && !step.error) continue;
    lines.push(`Step "${step.step_name}" (${step.action_type})`);
    lines.push(`  step_id: ${step.step_id}`);
    lines.push(`  status: ${step.status}`);
    if (step.error) lines.push(`  error: ${step.error}`);
    if (step.input_json) lines.push(`  input: ${step.input_json}`);
    if (step.output_json) lines.push(`  output: ${step.output_json}`);
    lines.push('');
  }

  lines.push('--- Events ---');
  for (const evt of events) {
    lines.push(`[${evt.timestamp}] ${evt.event_type}${evt.step_id ? ` (step=${evt.step_id})` : ''}`);
    lines.push(`  ${evt.payload_json}`);
  }
  return lines.join('\n');
}

export default function RunLogs({ run, events }: RunLogsProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();

  const failedSteps = useMemo(
    () => (run.steps ?? []).filter((s) => s.status === 'failed' || s.error),
    [run.steps],
  );

  const eventsByStep = useMemo(() => {
    const map = new Map<string, EventRecord[]>();
    for (const evt of events) {
      if (!evt.step_id) continue;
      const arr = map.get(evt.step_id) ?? [];
      arr.push(evt);
      map.set(evt.step_id, arr);
    }
    return map;
  }, [events]);

  const runLevelErrorEvents = useMemo(
    () => events.filter(
      (e) => e.event_type === 'run_failed' || e.event_type === 'run_cancelled',
    ),
    [events],
  );

  const hasError = run.status === 'failed' || run.error != null || failedSteps.length > 0;
  const humanizedError = humanizeRunError(run.error, run.steps);

  const copyAll = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildPlainTextDump(run, events));
      addToast(t('activity.logsCopied'), 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  }, [run, events, addToast, t]);

  if (!hasError) {
    return <p className="text-xs text-text-tertiary">{t('activity.logsEmpty')}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Copy button */}
      <div className="flex items-center justify-end">
        <button
          onClick={copyAll}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
        >
          <Copy size={11} />
          {t('activity.logsCopy')}
        </button>
      </div>

      {/* Top-level run error */}
      {run.error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <p className="text-[11px] font-medium text-red-300 leading-relaxed">
            {humanizedError ?? run.error}
          </p>
          {run.failed_step_id && humanizedError && humanizedError !== run.error && (
            <code className="block mt-2 text-[10px] font-mono text-text-tertiary/80 break-all">
              step_id: {run.failed_step_id}
            </code>
          )}
        </div>
      )}

      {/* Per-step error blocks */}
      {failedSteps.map((step) => {
        const stepEvts = eventsByStep.get(step.step_id) ?? [];
        return (
          <div
            key={step.id}
            className="bg-bg-base rounded-lg border border-border-subtle p-3 space-y-2.5"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-text-primary">{step.step_name}</span>
              <span className="inline-block bg-bg-elevated text-text-tertiary border border-border-subtle text-[10px] rounded px-1.5 py-0.5">
                {step.action_type}
              </span>
              <span className="text-[10px] text-red-400 font-medium uppercase tracking-wider">
                {step.status}
              </span>
            </div>

            {step.error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-md p-2">
                <p className="text-[11px] text-red-400 leading-relaxed whitespace-pre-wrap break-all">
                  {step.error}
                </p>
              </div>
            )}

            <JsonSection label="Input" json={step.input_json} />
            <JsonSection label="Output" json={step.output_json} />

            {stepEvts.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-text-tertiary mb-1.5 uppercase tracking-wider">
                  Events ({stepEvts.length})
                </p>
                <div className="space-y-1.5">
                  {stepEvts.map((evt) => (
                    <div key={evt.id} className="bg-bg-elevated rounded-md px-2.5 py-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] font-mono tabular-nums text-text-tertiary">
                          {formatEventTime(evt.timestamp)}
                        </span>
                        <span className="text-[10px] text-text-secondary">{evt.event_type}</span>
                      </div>
                      <pre className="mt-1 text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all">
                        {prettyPayload(evt.payload_json)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Run-level error events when no per-step errors */}
      {failedSteps.length === 0 && runLevelErrorEvents.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-text-tertiary mb-1.5 uppercase tracking-wider">
            Events
          </p>
          <div className="space-y-1.5">
            {runLevelErrorEvents.map((evt) => (
              <div key={evt.id} className="bg-bg-elevated rounded-md px-2.5 py-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-[10px] font-mono tabular-nums text-text-tertiary">
                    {formatEventTime(evt.timestamp)}
                  </span>
                  <span className="text-[10px] text-text-secondary">{evt.event_type}</span>
                </div>
                <pre className="mt-1 text-[10px] font-mono text-text-secondary whitespace-pre-wrap break-all">
                  {prettyPayload(evt.payload_json)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
