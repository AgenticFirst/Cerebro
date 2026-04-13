import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Hand, Clock, Webhook, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import type { Routine } from '../../../types/routines';
import Toggle from '../../ui/Toggle';
import { describeCron } from '../../../utils/cron-helpers';

// ── Helpers ────────────────────────────────────────────────────

function timeAgo(dateStr: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!dateStr) return t('routineEditor.never');
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('routineEditor.justNow');
  if (mins < 60) return t('timeAgo.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('timeAgo.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  return t('timeAgo.daysAgo', { count: days });
}

const TRIGGER_META: Record<string, { icon: typeof Hand; labelKey: string }> = {
  manual: { icon: Hand, labelKey: 'triggers.manual' },
  cron: { icon: Clock, labelKey: 'triggers.scheduled' },
  webhook: { icon: Webhook, labelKey: 'triggers.webhook' },
};

// ── Component ──────────────────────────────────────────────────

interface RoutineCardProps {
  routine: Routine;
  index: number;
  onClick: () => void;
  onToggle: () => void;
  onRun: () => void;
  onDelete?: () => void;
}

export default function RoutineCard({
  routine,
  index,
  onClick,
  onToggle,
  onRun,
  onDelete,
}: RoutineCardProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const trigger = TRIGGER_META[routine.triggerType] ?? TRIGGER_META.manual;
  const TriggerIcon = trigger.icon;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="bg-bg-surface border border-border-subtle rounded-lg p-4 cursor-pointer hover:border-border-default transition-colors animate-card-in"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex items-start gap-3">
        {/* Left: name + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-text-primary truncate">
              {routine.name}
            </span>
            <span
              className={clsx(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0',
                'bg-bg-elevated text-text-tertiary border border-border-subtle',
              )}
            >
              <TriggerIcon size={10} />
              {t(trigger.labelKey)}
            </span>
            {routine.triggerType === 'cron' && routine.cronExpression && (
              <span className="text-[10px] text-text-tertiary flex-shrink-0">
                {describeCron(routine.cronExpression) ?? routine.cronExpression}
              </span>
            )}
          </div>
          {routine.description && (
            <p className="text-xs text-text-secondary line-clamp-2">
              {routine.description}
            </p>
          )}
        </div>

        {/* Right: delete + toggle */}
        <div className="flex items-center gap-1.5">
          {isHovered && onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              aria-label={`Delete ${routine.name}`}
              className="p-1 rounded text-text-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events,jsx-a11y/no-static-element-interactions */}
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle checked={routine.isEnabled} onChange={onToggle} />
          </div>
        </div>
      </div>

      {/* Footer row */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border-subtle">
        <div className="flex items-center gap-3 text-[11px] text-text-tertiary">
          <span>
            {t('routines.lastRun')}: <span className="text-text-secondary">{timeAgo(routine.lastRunAt, t)}</span>
          </span>
          {routine.runCount > 0 && (
            <span>
              {t('routines.runs')}: <span className="text-text-secondary">{routine.runCount}</span>
            </span>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
          disabled={!routine.isEnabled || !routine.dagJson}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-accent hover:text-accent-hover disabled:text-text-tertiary disabled:cursor-not-allowed rounded transition-colors"
        >
          <Play size={11} />
          {t('routines.runNow')}
        </button>
      </div>
    </div>
  );
}
