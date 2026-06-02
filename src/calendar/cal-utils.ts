/**
 * Shared pure helpers for the calendar UI. Consolidated here so date math,
 * time formatting, and the account→color lookup live in one place rather than
 * being copy-pasted across the screen/grid/month/picker components.
 *
 * Note: recurrence.ts has its own `startOfUtcDay` (UTC math for RRULE expansion)
 * — these helpers are local-time, for rendering.
 */

import type { CalendarAccountInfo, CalendarEventDTO } from '../types/calendar';

const DEFAULT_EVENT_COLOR = '#06B6D4';

/** Local midnight of the given date. */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday-based start of the week containing `d` (local). */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Now, rounded up to the next :30 or :00 — a sensible default event start. */
export function roundedNow(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

/** Short local time label for an epoch-ms instant, e.g. "2:45 PM". */
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Map each account id to its display color (primary calendar's color, else default). */
export function buildColorByAccount(accounts: CalendarAccountInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of accounts) {
    const primary = a.calendars?.find((c) => c.id === a.primary_calendar_id) ?? a.calendars?.[0];
    map.set(a.id, primary?.color ?? DEFAULT_EVENT_COLOR);
  }
  return map;
}

/** An event's color: its own override, else its account's color, else the default. */
export function colorForEvent(event: CalendarEventDTO, colorByAccount: Map<string, string>): string {
  return event.color ?? colorByAccount.get(event.account_id) ?? DEFAULT_EVENT_COLOR;
}
