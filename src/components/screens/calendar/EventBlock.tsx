/** A single positioned event in the time grid. */

import type { CSSProperties } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Lock, Repeat, AlertTriangle } from 'lucide-react';
import type { CalendarOccurrence } from '../../../calendar/recurrence';
import { fmtTime } from '../../../calendar/cal-utils';

interface Props {
  occurrence: CalendarOccurrence;
  color: string;
  style: CSSProperties;
  onClick: (anchor: DOMRect) => void;
}

export default function EventBlock({ occurrence, color, style, onClick }: Props) {
  const { t } = useTranslation();
  const ev = occurrence.event;
  const declined = ev.rsvp_status === 'declined';
  const free = ev.transparency === 'transparent';
  const isPrivate = ev.visibility === 'private';
  const hasConflict = ev.conflict != null;
  const short = occurrence.heightPx < 34;

  return (
    <button
      data-event-block
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => onClick((e.currentTarget as HTMLElement).getBoundingClientRect())}
      style={{
        ...style,
        position: 'absolute',
        // Filled translucent rounded rectangle with a colored accent ring.
        // Free events read as a hollow outline so busy time stands out.
        background: free ? 'transparent' : `${color}2e`,
        borderColor: free ? `${color}66` : `${color}59`,
        boxShadow: `inset 3px 0 0 0 ${color}`,
      }}
      className={clsx(
        'group rounded-md border pl-2 pr-1.5 py-0.5 mr-0.5 text-left overflow-hidden cursor-pointer transition-all hover:brightness-110',
        free && 'border-dashed',
        declined && 'opacity-50 line-through',
      )}
    >
      <div className="flex items-center gap-1">
        {isPrivate && <Lock size={9} className="flex-shrink-0 text-text-tertiary" />}
        {occurrence.recurring && <Repeat size={9} className="flex-shrink-0 text-text-tertiary" />}
        {hasConflict && (
          <AlertTriangle
            size={9}
            className="flex-shrink-0 text-amber-400"
            aria-label={t('calendar.conflictBadge')}
          />
        )}
        <span className="text-[11px] font-semibold text-text-primary truncate">
          {isPrivate ? t('calendar.private') : ev.title || '(no title)'}
        </span>
      </div>
      {!short && (
        <div className="text-[10px] text-text-secondary/80 truncate">
          {fmtTime(occurrence.startMs)}
          {ev.location ? ` · ${ev.location}` : ''}
        </div>
      )}
    </button>
  );
}
