// ── Activity screen helpers ─────────────────────────────────────

import type { TFunction } from 'i18next';
import type { StepRecord } from './types';

/**
 * Backend timestamps come back as SQLAlchemy-formatted ISO strings without
 * a timezone marker (`2026-04-28 01:53:52.736402`). The Python side stores
 * UTC, but JavaScript's `new Date(str)` parses naive ISO strings as LOCAL
 * time, which produces nonsense like a 4-hour negative duration when the
 * user's machine is in a different timezone.
 *
 * Always run server timestamps through this helper so the parser knows
 * they're UTC. Inputs that already have an explicit `Z` or `±HH:MM`
 * suffix are passed through unchanged.
 */
export function parseServerTimestamp(dateStr: string | null | undefined): number {
  if (!dateStr) return NaN;
  // Already has a timezone marker → trust it.
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(dateStr)) {
    return new Date(dateStr).getTime();
  }
  // SQLAlchemy uses " " between date and time; convert to ISO-8601 with Z.
  return new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
}

export function timeAgo(dateStr: string | null, t: TFunction): string {
  if (!dateStr) return t('timeAgo.never');
  const ts = parseServerTimestamp(dateStr);
  if (Number.isNaN(ts)) return t('timeAgo.never');
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('timeAgo.justNow');
  if (mins < 60) return t('timeAgo.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('timeAgo.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  return t('timeAgo.daysAgo', { count: days });
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return '\u2014';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function formatTimestamp(dateStr: string | null, t: TFunction): string {
  if (!dateStr) return '\u2014';
  const ts = parseServerTimestamp(dateStr);
  if (Number.isNaN(ts)) return '\u2014';
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return t('activity.today', { time });

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return t('activity.yesterday', { time });

  const month = d.toLocaleString([], { month: 'short' });
  return `${month} ${d.getDate()}, ${time}`;
}

export function formatEventTime(dateStr: string): string {
  const ts = parseServerTimestamp(dateStr);
  if (Number.isNaN(ts)) return '\u2014';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// ── Status config ────────────────────────────────────────────────

export interface StatusStyle {
  dot: string;
  text: string;
  glow?: boolean;
}

export const STATUS_CONFIG: Record<string, StatusStyle> = {
  running:   { dot: 'bg-yellow-500', text: 'text-yellow-500', glow: true },
  paused:    { dot: 'bg-amber-400',  text: 'text-amber-400',  glow: true },
  completed: { dot: 'bg-green-500',  text: 'text-green-500' },
  failed:    { dot: 'bg-red-500',    text: 'text-red-500' },
  cancelled: { dot: 'bg-zinc-500',   text: 'text-text-tertiary' },
  created:   { dot: 'bg-zinc-500',   text: 'text-text-tertiary' },
};

// ── Error humanizer ──────────────────────────────────────────────

/**
 * Engine-emitted run errors look like `Step "<uuid>" timed out after 300000ms`.
 * Surface the step's user-facing name + a friendly duration so the user can
 * tell which step blew up without cross-referencing UUIDs.
 *
 * Falls back to the original string when we can't find a matching step.
 */
export function humanizeRunError(
  error: string | null,
  steps: StepRecord[] | null,
): string | null {
  if (!error) return error;
  const match = error.match(/Step\s+"([0-9a-f-]{8,})"\s+(.+)$/i);
  if (!match) return error;
  const [, uuid, rest] = match;
  const step = steps?.find((s) => s.step_id === uuid);
  if (!step) return error;
  const friendlyRest = rest.replace(/timed out after (\d+)ms/i, (_, ms) => {
    const n = Number(ms);
    if (!isFinite(n)) return `timed out after ${ms}ms`;
    if (n >= 60000) return `timed out after ${Math.round(n / 60000)} min`;
    if (n >= 1000) return `timed out after ${Math.round(n / 1000)}s`;
    return `timed out after ${n}ms`;
  });
  return `Step "${step.step_name}" ${friendlyRest}`;
}
