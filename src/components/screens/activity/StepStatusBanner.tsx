import { useTranslation } from 'react-i18next';
import { Loader2, Clock, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import type { StepRecord, EventRecord } from './types';
import { useElapsed, formatElapsedShort, formatRelativeShort } from './useElapsed';
import { formatDuration, parseServerTimestamp } from './helpers';

interface StepStatusBannerProps {
  step: StepRecord;
  /** All steps in the run — used to resolve dependsOn names for queued steps. */
  allSteps: StepRecord[];
  /** Events for this run — last activity is computed from the most recent event for this step. */
  events: EventRecord[];
}

export default function StepStatusBanner({ step, allSteps, events }: StepStatusBannerProps) {
  const { t } = useTranslation();

  // Live elapsed counter for running/queued steps. Re-render every second
  // so the user sees "0:42" tick up.
  const isActive = step.status === 'running' || step.status === 'queued' || step.status === 'pending';
  const elapsedSinceStart = useElapsed(step.started_at, step.status === 'running');

  // Last event for this step — drives the "last activity Xs ago" hint.
  const lastEvent = events
    .filter((e) => e.step_id === step.step_id)
    .reduce<EventRecord | null>(
      (acc, e) => (!acc || parseServerTimestamp(e.timestamp) > parseServerTimestamp(acc.timestamp) ? e : acc),
      null,
    );
  const lastEventMs = lastEvent
    ? Math.max(0, Date.now() - parseServerTimestamp(lastEvent.timestamp))
    : 0;
  // Re-render every second while this step is running so the "last activity" counter ticks live.
  useElapsed(lastEvent?.timestamp ?? null, step.status === 'running');

  if (step.status === 'completed') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-green-400/90">
        <CheckCircle2 size={11} />
        <span>{t('stepStatus.completedIn', { duration: formatDuration(step.duration_ms) })}</span>
      </div>
    );
  }

  if (step.status === 'failed') {
    // The error block already renders above this banner — nothing extra to add.
    return null;
  }

  if (step.status === 'skipped') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
        <Clock size={11} />
        <span>{t('stepStatus.skipped')}</span>
      </div>
    );
  }

  if (step.status === 'running') {
    // No last-activity callout if the step itself just started (< 2s).
    const showLastActivity = lastEvent && lastEventMs > 2000;
    return (
      <div className="flex items-center gap-2 text-[11px] text-yellow-400">
        <Loader2 size={11} className="animate-spin" />
        <span className="font-medium">
          {t('stepStatus.runningElapsed', { elapsed: formatElapsedShort(elapsedSinceStart) })}
        </span>
        {showLastActivity && (
          <span className="text-text-tertiary">
            · {t('stepStatus.lastActivity', { ago: formatRelativeShort(lastEventMs) })}
          </span>
        )}
      </div>
    );
  }

  // queued / pending — show what we're waiting on
  const dependencies = allSteps.filter((s) => s.order_index < step.order_index && s.status !== 'completed' && s.status !== 'skipped');
  const waitingFor = dependencies[0];
  return (
    <div className={clsx('flex items-center gap-2 text-[11px]', isActive ? 'text-text-secondary' : 'text-text-tertiary')}>
      <Clock size={11} />
      {waitingFor ? (
        <span>{t('stepStatus.queuedWaitingFor', { name: waitingFor.step_name })}</span>
      ) : (
        <span>{t('stepStatus.queued')}</span>
      )}
    </div>
  );
}
