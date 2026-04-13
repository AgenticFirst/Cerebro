// ── Activity screen helpers ─────────────────────────────────────

import type { TFunction } from 'i18next';

export function timeAgo(dateStr: string | null, t: TFunction): string {
  if (!dateStr) return t('timeAgo.never');
  const diff = Date.now() - new Date(dateStr).getTime();
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
  const d = new Date(dateStr);
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
  const d = new Date(dateStr);
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
