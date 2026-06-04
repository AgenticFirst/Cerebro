/**
 * Month grid — a 6×7 calendar of day cells with event chips. Click a chip to
 * open it, a day number / "+N more" to jump into that day, or empty space to
 * create an event on that day. Recurring + all-day events are expanded for the
 * whole month window.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { expandEventsForWindow, type CalendarOccurrence } from '../../../calendar/recurrence';
import type { CalendarAccountInfo, CalendarEventDTO } from '../../../types/calendar';
import {
  startOfDay,
  sameDay,
  buildColorByAccount,
  colorForEvent,
} from '../../../calendar/cal-utils';

const DAY_MS = 86_400_000;
const MAX_CHIPS = 3;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Props {
  /** Monday of the week containing the 1st — start of the 6-week grid. */
  windowStart: Date;
  /** Any date inside the displayed month (drives in-month vs muted styling). */
  anchorDate: Date;
  events: CalendarEventDTO[];
  accounts: CalendarAccountInfo[];
  onSelectEvent: (occurrence: CalendarOccurrence, anchor: DOMRect) => void;
  onPickDay: (day: Date) => void;
  onCreateAt: (start: Date) => void;
}

export default function CalendarMonthView({
  windowStart,
  anchorDate,
  events,
  accounts,
  onSelectEvent,
  onPickDay,
  onCreateAt,
}: Props) {
  const { t } = useTranslation();
  const today = new Date();
  const gridStart = startOfDay(windowStart).getTime();
  const gridEnd = gridStart + 42 * DAY_MS;

  const colorByAccount = useMemo(() => buildColorByAccount(accounts), [accounts]);

  // Bucket occurrences by day index (0..41).
  const byDay = useMemo(() => {
    const buckets: CalendarOccurrence[][] = Array.from({ length: 42 }, () => []);
    for (const occ of expandEventsForWindow(events, gridStart, gridEnd)) {
      const idx = Math.floor((startOfDay(new Date(occ.startMs)).getTime() - gridStart) / DAY_MS);
      if (idx >= 0 && idx < 42) buckets[idx].push(occ);
    }
    return buckets;
  }, [events, gridStart, gridEnd]);

  const colorFor = (o: CalendarOccurrence) => colorForEvent(o.event, colorByAccount);

  return (
    <div className="flex flex-col h-full">
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-border-subtle">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="text-center text-[11px] uppercase tracking-wide text-text-tertiary py-2"
          >
            {w}
          </div>
        ))}
      </div>

      {/* 6 weeks */}
      <div className="flex-1 grid grid-rows-6 grid-cols-7">
        {Array.from({ length: 42 }, (_, i) => {
          const day = new Date(gridStart + i * DAY_MS);
          const inMonth = day.getMonth() === anchorDate.getMonth();
          const isToday = sameDay(day, today);
          const occ = byDay[i];
          const visible = occ.slice(0, MAX_CHIPS);
          const extra = occ.length - visible.length;
          return (
            <div
              key={i}
              onClick={() =>
                onCreateAt(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0))
              }
              className={clsx(
                'group relative border-b border-r border-border-subtle/60 p-1 overflow-hidden cursor-pointer transition-colors hover:bg-bg-hover/40',
                (i + 1) % 7 === 0 && 'border-r-0',
                !inMonth && 'bg-bg-surface/20',
              )}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPickDay(day);
                }}
                className={clsx(
                  'ml-auto flex items-center justify-center w-6 h-6 rounded-full text-[12px] transition-colors',
                  isToday
                    ? 'bg-accent text-black font-semibold'
                    : inMonth
                      ? 'text-text-secondary hover:bg-bg-hover'
                      : 'text-text-tertiary/50 hover:bg-bg-hover',
                )}
              >
                {day.getDate()}
              </button>

              <div className="mt-0.5 space-y-0.5">
                {visible.map((o) => {
                  const color = colorFor(o);
                  const allDay = o.event.all_day;
                  return (
                    <button
                      key={o.key}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectEvent(o, (e.currentTarget as HTMLElement).getBoundingClientRect());
                      }}
                      className="flex items-center gap-1 w-full text-left truncate rounded px-1 py-0.5 text-[10px] hover:brightness-110"
                      style={{ background: allDay ? `${color}40` : 'transparent' }}
                    >
                      {!allDay && (
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: color }}
                        />
                      )}
                      {!allDay && (
                        <span className="text-text-tertiary tabular-nums flex-shrink-0">
                          {new Date(o.startMs).toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: o.startMs % 3600000 ? '2-digit' : undefined,
                          })}
                        </span>
                      )}
                      <span className="text-text-primary truncate">
                        {o.event.title || '(no title)'}
                      </span>
                    </button>
                  );
                })}
                {extra > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPickDay(day);
                    }}
                    className="block w-full text-left px-1 text-[10px] text-text-tertiary hover:text-text-secondary"
                  >
                    {t('calendar.more', { count: extra })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
