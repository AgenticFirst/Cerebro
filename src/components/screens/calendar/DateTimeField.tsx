/**
 * Branded date + time picker. Two triggers (date / time) that expand an inline
 * panel — a mini month calendar for the date and a scrollable time list for the
 * time. Inline (not an overlay popover) so it never gets clipped by the event
 * modal's scroll container.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { sameDay, fmtTime } from '../../../calendar/cal-utils';

interface Props {
  value: Date;
  onChange: (d: Date) => void;
  /** 'date' hides the time trigger (all-day events). */
  mode?: 'datetime' | 'date';
  minuteStep?: number;
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function fmtDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function DateTimeField({ value, onChange, mode = 'datetime', minuteStep = 15 }: Props) {
  const [open, setOpen] = useState<null | 'date' | 'time'>(null);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(value));

  useEffect(() => {
    if (open === 'date') setViewMonth(startOfMonth(value));
  }, [open, value]);

  const triggerCls =
    'px-2.5 py-1.5 rounded-md text-[13px] text-text-primary bg-bg-surface border transition-colors text-left';

  return (
    <div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(open === 'date' ? null : 'date')}
          className={clsx(triggerCls, 'flex-1', open === 'date' ? 'border-accent' : 'border-border-subtle hover:border-accent/50')}
        >
          {fmtDate(value)}
        </button>
        {mode === 'datetime' && (
          <button
            type="button"
            onClick={() => setOpen(open === 'time' ? null : 'time')}
            className={clsx(triggerCls, 'w-24', open === 'time' ? 'border-accent' : 'border-border-subtle hover:border-accent/50')}
          >
            {fmtTime(value.getTime())}
          </button>
        )}
      </div>

      {open === 'date' && (
        <MiniCalendar
          viewMonth={viewMonth}
          selected={value}
          onPrev={() => setViewMonth((m) => addMonths(m, -1))}
          onNext={() => setViewMonth((m) => addMonths(m, 1))}
          onPick={(day) => {
            const next = new Date(value);
            next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
            onChange(next);
            setOpen(null);
          }}
        />
      )}

      {open === 'time' && (
        <TimeList value={value} minuteStep={minuteStep} onPick={(h, m) => {
          const next = new Date(value);
          next.setHours(h, m, 0, 0);
          onChange(next);
          setOpen(null);
        }} />
      )}
    </div>
  );
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function MiniCalendar({
  viewMonth,
  selected,
  onPrev,
  onNext,
  onPick,
}: {
  viewMonth: Date;
  selected: Date;
  onPrev: () => void;
  onNext: () => void;
  onPick: (d: Date) => void;
}) {
  const today = new Date();
  const days = useMemo(() => {
    const first = startOfMonth(viewMonth);
    const lead = (first.getDay() + 6) % 7; // Monday-based
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      return d;
    });
  }, [viewMonth]);

  return (
    <div className="mt-1.5 rounded-lg border border-border-subtle bg-bg-base p-2 animate-fade-in">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <button type="button" onClick={onPrev} className="p-1 rounded text-text-tertiary hover:bg-bg-hover">
          <ChevronLeft size={14} />
        </button>
        <span className="text-[12px] font-medium text-text-primary">
          {viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
        <button type="button" onClick={onNext} className="p-1 rounded text-text-tertiary hover:bg-bg-hover">
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="text-center text-[9px] uppercase text-text-tertiary py-0.5">{w}</div>
        ))}
        {days.map((d) => {
          const inMonth = d.getMonth() === viewMonth.getMonth();
          const isSel = sameDay(d, selected);
          const isToday = sameDay(d, today);
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPick(d)}
              className={clsx(
                'h-7 rounded-md text-[12px] transition-colors',
                isSel
                  ? 'bg-accent text-black font-semibold'
                  : clsx(
                      inMonth ? 'text-text-secondary' : 'text-text-tertiary/50',
                      'hover:bg-bg-hover',
                      isToday && 'ring-1 ring-accent/50',
                    ),
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimeList({ value, minuteStep, onPick }: { value: Date; minuteStep: number; onPick: (h: number, m: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const slots = useMemo(() => {
    const out: { h: number; m: number; label: string }[] = [];
    for (let mins = 0; mins < 24 * 60; mins += minuteStep) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const d = new Date(2000, 0, 1, h, m);
      out.push({ h, m, label: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) });
    }
    return out;
  }, [minuteStep]);

  const selectedMins = value.getHours() * 60 + value.getMinutes();

  useEffect(() => {
    // Scroll the closest slot into view when the list opens.
    const el = listRef.current?.querySelector('[data-selected="true"]') as HTMLElement | null;
    if (el && listRef.current) listRef.current.scrollTop = el.offsetTop - 80;
  }, []);

  return (
    <div ref={listRef} className="mt-1.5 max-h-48 overflow-y-auto scrollbar-thin rounded-lg border border-border-subtle bg-bg-base p-1 animate-fade-in">
      {slots.map((s) => {
        const mins = s.h * 60 + s.m;
        const isSel = Math.abs(mins - selectedMins) < minuteStep / 2;
        return (
          <button
            key={s.label}
            type="button"
            data-selected={isSel}
            onClick={() => onPick(s.h, s.m)}
            className={clsx(
              'block w-full text-left px-2.5 py-1 rounded text-[12px] transition-colors',
              isSel ? 'bg-accent text-black font-medium' : 'text-text-secondary hover:bg-bg-hover',
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
