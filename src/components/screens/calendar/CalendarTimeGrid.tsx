/**
 * Time-grid view shared by the day (1 column) and week (7 columns) modes.
 * Renders an hour grid with absolutely-positioned event blocks, a top all-day
 * strip, and a "now" line. Overlapping events split the column side by side.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CalendarOccurrence } from '../../../calendar/recurrence';
import { expandEventsForWindow } from '../../../calendar/recurrence';
import type { CalendarAccountInfo, CalendarEventDTO } from '../../../types/calendar';
import EventBlock from './EventBlock';
import { startOfDay, fmtTime, buildColorByAccount, colorForEvent } from '../../../calendar/cal-utils';

const HOUR_PX = 48;
const DAY_MS = 86_400_000;
const PX_PER_MIN = HOUR_PX / 60;
const SNAP_MIN = 15;
const DEFAULT_DURATION_MIN = 60;

interface Props {
  days: Date[];
  events: CalendarEventDTO[];
  accounts: CalendarAccountInfo[];
  onSelectEvent: (occurrence: CalendarOccurrence, anchor: DOMRect) => void;
  /** Click → start only (defaults to a 1-hour event). Drag → start + end range. */
  onCreateAt: (start: Date, end?: Date) => void;
}

interface DragState {
  dayIndex: number;
  dayStartMs: number;
  el: HTMLElement;
  startMin: number;
  curMin: number;
}

interface Selection {
  dayIndex: number;
  aMin: number;
  bMin: number;
}

function snapMin(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

/** Y offset within a day column → minutes from midnight, clamped + snapped. */
function yToSnappedMin(clientY: number, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const min = (clientY - rect.top) / PX_PER_MIN;
  return snapMin(Math.max(0, Math.min(24 * 60 - SNAP_MIN, min)));
}

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

interface PlacedOccurrence extends CalendarOccurrence {
  topPx: number;
  heightPx: number;
  colIndex: number;
  colCount: number;
}

/** Assign side-by-side columns to a day's overlapping timed occurrences. */
function placeDay(occ: CalendarOccurrence[], dayStartMs: number): PlacedOccurrence[] {
  const sorted = [...occ].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const placed: PlacedOccurrence[] = [];
  // Greedy interval-graph coloring within clusters of overlapping events.
  let cluster: PlacedOccurrence[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.colIndex + 1));
    for (const c of cluster) c.colCount = cols;
    placed.push(...cluster);
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const o of sorted) {
    const top = ((o.startMs - dayStartMs) / DAY_MS) * 24 * HOUR_PX;
    const height = Math.max(18, ((o.endMs - o.startMs) / DAY_MS) * 24 * HOUR_PX);
    const item: PlacedOccurrence = { ...o, topPx: top, heightPx: height, colIndex: 0, colCount: 1 };
    if (cluster.length && o.startMs >= clusterEnd) flush();
    // find first free column in current cluster
    const taken = new Set(cluster.filter((c) => c.endMs > o.startMs).map((c) => c.colIndex));
    let col = 0;
    while (taken.has(col)) col += 1;
    item.colIndex = col;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, o.endMs);
  }
  if (cluster.length) flush();
  return placed;
}

export default function CalendarTimeGrid({ days, events, accounts, onSelectEvent, onCreateAt }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const colorByAccount = useMemo(() => buildColorByAccount(accounts), [accounts]);

  const windowStartMs = startOfDay(days[0]).getTime();
  const windowEndMs = startOfDay(days[days.length - 1]).getTime() + DAY_MS;

  // Expand once, then split all-day vs timed and bucket timed by day index —
  // all memoized so a pointer-drag (which re-renders on every move) doesn't
  // re-scan the occurrence list each frame.
  const { allDay, timedByDay } = useMemo(() => {
    const occ = expandEventsForWindow(events, windowStartMs, windowEndMs);
    const all: typeof occ = [];
    const byDay = new Map<number, typeof occ>();
    for (const o of occ) {
      if (o.event.all_day) {
        all.push(o);
        continue;
      }
      const idx = Math.floor((o.startMs - windowStartMs) / DAY_MS);
      // An event can start before the window (multi-day); clamp into range.
      for (let i = Math.max(0, idx); i < days.length; i += 1) {
        const dayStart = windowStartMs + i * DAY_MS;
        if (o.startMs < dayStart + DAY_MS && o.endMs > dayStart) {
          (byDay.get(i) ?? byDay.set(i, []).get(i)!).push(o);
        }
      }
    }
    return { allDay: all, timedByDay: byDay };
  }, [events, windowStartMs, windowEndMs, days.length]);

  // Auto-scroll to ~7am on first paint.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX;
  }, []);

  const now = new Date();
  const nowMs = now.getTime();

  // ── Drag-to-create selection ──────────────────────────────────────────────
  // Press and drag on an empty part of a day column to paint a time range; on
  // release the event editor opens prefilled. A plain click drops a 1-hour
  // event. Refs (not state) back the live listeners so identities stay stable
  // and there's no stale-closure removal bug; `selection` state drives the
  // preview render.
  const dragRef = useRef<DragState | null>(null);
  const onCreateRef = useRef(onCreateAt);
  onCreateRef.current = onCreateAt;
  const [selection, setSelection] = useState<Selection | null>(null);

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const cur = yToSnappedMin(e.clientY, d.el);
    d.curMin = cur;
    setSelection({ dayIndex: d.dayIndex, aMin: Math.min(d.startMin, cur), bMin: Math.max(d.startMin, cur) });
  }, []);

  const handlePointerUp = useCallback(() => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    document.body.classList.remove('select-none');
    const d = dragRef.current;
    dragRef.current = null;
    setSelection(null);
    if (!d) return;
    let a = Math.min(d.startMin, d.curMin);
    let b = Math.max(d.startMin, d.curMin);
    // A click (or a too-small drag) becomes a tidy default-length event.
    if (b - a < SNAP_MIN) b = Math.min(24 * 60, a + DEFAULT_DURATION_MIN);
    // Keep it within the day.
    if (b > 24 * 60) { b = 24 * 60; a = Math.max(0, b - DEFAULT_DURATION_MIN); }
    onCreateRef.current(new Date(d.dayStartMs + a * 60_000), new Date(d.dayStartMs + b * 60_000));
  }, [handlePointerMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent, dayIndex: number, dayStartMs: number) => {
      if (e.button !== 0) return;
      // Don't hijack clicks that land on an existing event.
      if ((e.target as HTMLElement).closest('[data-event-block]')) return;
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      const startMin = yToSnappedMin(e.clientY, el);
      dragRef.current = { dayIndex, dayStartMs, el, startMin, curMin: startMin };
      setSelection({ dayIndex, aMin: startMin, bMin: startMin });
      document.body.classList.add('select-none');
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [handlePointerMove, handlePointerUp],
  );

  useEffect(() => () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove, handlePointerUp]);

  return (
    <div className="flex flex-col h-full">
      {/* Day headers */}
      <div className="flex border-b border-border-subtle pl-12">
        {days.map((d) => {
          const isToday = startOfDay(d).getTime() === startOfDay(now).getTime();
          return (
            <div key={d.toISOString()} className="flex-1 text-center py-2">
              <div className="text-[11px] uppercase tracking-wide text-text-tertiary">
                {d.toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
              <div
                className={clsx(
                  'mx-auto mt-0.5 w-7 h-7 leading-7 rounded-full text-[13px] font-medium',
                  isToday ? 'bg-accent text-black' : 'text-text-secondary',
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* All-day strip */}
      {allDay.length > 0 && (
        <div className="flex border-b border-border-subtle pl-12 min-h-[28px]">
          {days.map((d) => {
            const dayStart = startOfDay(d).getTime();
            const dayEnd = dayStart + DAY_MS;
            const items = allDay.filter((o) => o.startMs < dayEnd && o.endMs > dayStart);
            return (
              <div key={d.toISOString()} className="flex-1 px-1 py-1 space-y-1 border-l border-border-subtle/50">
                {items.map((o) => (
                  <button
                    key={o.key}
                    onClick={(e) => onSelectEvent(o, (e.currentTarget as HTMLElement).getBoundingClientRect())}
                    className="block w-full truncate text-left text-[11px] px-1.5 py-0.5 rounded"
                    style={{ background: `${colorForEvent(o.event, colorByAccount)}33` }}
                  >
                    {o.event.title || '(no title)'}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Scrollable hour grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          {/* Hour labels */}
          <div className="w-12 flex-shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-text-tertiary"
                style={{ top: h * HOUR_PX }}
              >
                {h === 0 ? '' : `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d, dayIndex) => {
            const dayStartMs = startOfDay(d).getTime();
            const placed = placeDay(timedByDay.get(dayIndex) ?? [], dayStartMs);
            const showNow = dayStartMs <= nowMs && nowMs < dayStartMs + DAY_MS;
            const sel = selection && selection.dayIndex === dayIndex ? selection : null;
            return (
              <div
                key={d.toISOString()}
                className="flex-1 relative border-l border-border-subtle/50 cursor-cell touch-none select-none"
                onPointerDown={(e) => startDrag(e, dayIndex, dayStartMs)}
              >
                {/* Hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-border-subtle/40"
                    style={{ top: h * HOUR_PX }}
                  />
                ))}

                {/* Live drag selection */}
                {sel && (
                  <DragSelection dayStartMs={dayStartMs} aMin={sel.aMin} bMin={sel.bMin} />
                )}

                {placed.map((o) => (
                  <EventBlock
                    key={o.key}
                    occurrence={o}
                    color={colorForEvent(o.event, colorByAccount)}
                    style={{
                      top: o.topPx,
                      height: o.heightPx,
                      left: `${(o.colIndex / o.colCount) * 100}%`,
                      width: `${(1 / o.colCount) * 100}%`,
                    }}
                    onClick={(rect) => onSelectEvent(o, rect)}
                  />
                ))}

                {showNow && (
                  <div
                    className="absolute left-0 right-0 z-10 pointer-events-none"
                    style={{ top: ((nowMs - dayStartMs) / DAY_MS) * 24 * HOUR_PX }}
                  >
                    <div className="h-px bg-red-500" />
                    <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-red-500" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The translucent block painted while dragging a new time range. */
function DragSelection({ dayStartMs, aMin, bMin }: { dayStartMs: number; aMin: number; bMin: number }) {
  const top = aMin * PX_PER_MIN;
  const dur = bMin - aMin;
  const height = Math.max(3, dur * PX_PER_MIN);
  return (
    <div
      className="absolute left-0.5 right-0.5 z-20 rounded-md bg-accent/25 border border-accent shadow-sm pointer-events-none overflow-hidden"
      style={{ top, height }}
    >
      <div className="px-1.5 pt-0.5 text-[10px] font-semibold text-accent leading-tight whitespace-nowrap">
        {dur >= SNAP_MIN
          ? `${fmtTime(dayStartMs + aMin * 60_000)} – ${fmtTime(dayStartMs + bMin * 60_000)}`
          : fmtTime(dayStartMs + aMin * 60_000)}
        {dur >= 30 && <span className="text-accent/70 font-normal"> · {fmtDuration(dur)}</span>}
      </div>
    </div>
  );
}
