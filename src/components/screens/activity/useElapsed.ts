import { useEffect, useState } from 'react';
import { parseServerTimestamp } from './helpers';

/**
 * Live elapsed-time hook. Returns ms elapsed since `startedAt` and
 * re-renders every second while `active` is true. Used by Steps-tab
 * live counters ("Running for 0:42", "Last activity 5s ago").
 *
 * Pass active=false (e.g., when status !== 'running') to stop the
 * interval and freeze the value.
 *
 * Always parses `startedAt` as a server (UTC) timestamp — the backend
 * sends naive ISO strings without a TZ marker; raw `new Date()` would
 * interpret them as local and yield wildly wrong elapsed values.
 */
export function useElapsed(startedAt: string | null, active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt) return 0;
  const start = parseServerTimestamp(startedAt);
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Date.now() - start);
}

export function formatElapsedShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatRelativeShort(ms: number): string {
  if (ms < 1000) return 'just now';
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s ago`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
