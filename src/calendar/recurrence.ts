/**
 * Lightweight RRULE expansion for the calendar grid (renderer-safe, pure).
 *
 * Providers return recurring *masters* (with RRULE) plus materialized exception
 * overrides as separate events. For the visible window we expand the master into
 * concrete occurrences, skipping instants that an override already covers. This
 * supports the common subset (FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT,
 * UNTIL, BYDAY for weekly) — enough for everyday calendars. "This and following"
 * edits are out of MVP scope.
 */

import type { CalendarEventDTO } from '../types/calendar';

export interface CalendarOccurrence {
  event: CalendarEventDTO;
  startMs: number;
  endMs: number;
  /** A generated instance of a recurring master (vs. a concrete stored event). */
  recurring: boolean;
  /** Stable key for React. */
  key: string;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_INSTANCES = 366;

interface ParsedRule {
  freq?: string;
  interval: number;
  count?: number;
  untilMs?: number;
  byday?: number[]; // 0=SU..6=SA
}

function parseRrule(lines: string[] | null): ParsedRule | null {
  if (!lines || !lines.length) return null;
  const rule = lines.find((l) => l.toUpperCase().startsWith('RRULE'));
  if (!rule) return null;
  const body = rule.slice(rule.indexOf(':') + 1);
  const out: ParsedRule = { interval: 1 };
  for (const part of body.split(';')) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    switch (k.toUpperCase()) {
      case 'FREQ':
        out.freq = v.toUpperCase();
        break;
      case 'INTERVAL':
        out.interval = Math.max(1, parseInt(v, 10) || 1);
        break;
      case 'COUNT':
        out.count = parseInt(v, 10) || undefined;
        break;
      case 'UNTIL':
        out.untilMs = parseUntil(v);
        break;
      case 'BYDAY':
        out.byday = v
          .split(',')
          .map((d) => WEEKDAYS.indexOf(d.replace(/^[+-]?\d+/, '').toUpperCase()))
          .filter((i) => i >= 0);
        break;
    }
  }
  return out;
}

function parseUntil(v: string): number | undefined {
  // Forms: 20260131T235959Z or 20260131
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) return undefined;
  const [, y, mo, d, h = '23', mi = '59', s = '59'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

/**
 * Expand events into concrete occurrences overlapping [windowStartMs, windowEndMs).
 * Non-recurring events pass through; recurring masters are expanded.
 */
export function expandEventsForWindow(
  events: CalendarEventDTO[],
  windowStartMs: number,
  windowEndMs: number,
): CalendarOccurrence[] {
  const occurrences: CalendarOccurrence[] = [];
  // Override instants per master, so generated occurrences don't double up.
  const overrideInstants = new Map<string, Set<number>>();
  for (const ev of events) {
    if (ev.recurring_master_id && ev.start_utc) {
      const set = overrideInstants.get(ev.recurring_master_id) ?? new Set<number>();
      set.add(roundToMinute(new Date(ev.start_utc).getTime()));
      overrideInstants.set(ev.recurring_master_id, set);
    }
  }

  for (const ev of events) {
    if (ev.status === 'cancelled' || !ev.start_utc || !ev.end_utc) continue;
    const startMs = new Date(ev.start_utc).getTime();
    const endMs = new Date(ev.end_utc).getTime();
    const rule = parseRrule(ev.recurrence);

    if (!rule || !rule.freq) {
      if (endMs > windowStartMs && startMs < windowEndMs) {
        occurrences.push({ event: ev, startMs, endMs, recurring: false, key: ev.id });
      }
      continue;
    }

    const duration = Math.max(0, endMs - startMs);
    const overrides = overrideInstants.get(ev.provider_event_id ?? '') ?? new Set<number>();
    let produced = 0;
    for (const instStart of generateInstances(rule, startMs, windowStartMs, windowEndMs)) {
      if (rule.count && produced >= rule.count) break;
      produced += 1;
      if (overrides.has(roundToMinute(instStart))) continue;
      const instEnd = instStart + duration;
      if (instEnd > windowStartMs && instStart < windowEndMs) {
        occurrences.push({
          event: ev,
          startMs: instStart,
          endMs: instEnd,
          recurring: true,
          key: `${ev.id}:${instStart}`,
        });
      }
    }
  }

  return occurrences.sort((a, b) => a.startMs - b.startMs);
}

function* generateInstances(
  rule: ParsedRule,
  seedMs: number,
  windowStartMs: number,
  windowEndMs: number,
): Generator<number> {
  const limit = rule.untilMs ? Math.min(rule.untilMs, windowEndMs) : windowEndMs;
  let emitted = 0;

  if (rule.freq === 'WEEKLY' && rule.byday?.length) {
    // Walk week by week (INTERVAL weeks), emitting each listed weekday.
    const seed = new Date(seedMs);
    const weekStart = seedMs - ((seed.getUTCDay() + 0) % 7) * DAY_MS; // Sunday-based
    for (let wk = 0; emitted < MAX_INSTANCES; wk += rule.interval) {
      const base = weekStart + wk * 7 * DAY_MS;
      if (base > limit + 7 * DAY_MS) break;
      for (const dow of rule.byday) {
        const t = base + dow * DAY_MS + (seedMs - startOfUtcDay(seedMs));
        if (t < seedMs) continue;
        if (t > limit) continue;
        if (t >= windowStartMs - DAY_MS && t < windowEndMs) {
          emitted += 1;
          yield t;
        }
      }
      if (base > windowEndMs) break;
    }
    return;
  }

  // Only known frequencies reach here (WEEKLY+BYDAY handled above); bail on others.
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq ?? '')) return;
  for (let t = seedMs; t <= limit && emitted < MAX_INSTANCES; t = advance(rule, t)) {
    if (t >= windowStartMs - DAY_MS && t < windowEndMs) {
      emitted += 1;
      yield t;
    } else if (t >= windowEndMs) {
      break;
    }
  }
}

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function advance(rule: ParsedRule, t: number): number {
  const d = new Date(t);
  switch (rule.freq) {
    case 'DAILY':
      return t + rule.interval * DAY_MS;
    case 'WEEKLY':
      return t + rule.interval * 7 * DAY_MS;
    case 'MONTHLY':
      d.setUTCMonth(d.getUTCMonth() + rule.interval);
      return d.getTime();
    case 'YEARLY':
      d.setUTCFullYear(d.getUTCFullYear() + rule.interval);
      return d.getTime();
    default:
      return t + DAY_MS; // shouldn't happen; loop guarded by MAX_INSTANCES
  }
}

function roundToMinute(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}
