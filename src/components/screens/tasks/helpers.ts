import type { TaskStatus } from './types';

export interface StatusStyle {
  dot: string;
  text: string;
  label: string;
  glow?: boolean;
}

export const STATUS_CONFIG: Record<TaskStatus, StatusStyle> = {
  pending:                 { dot: 'bg-zinc-500',   text: 'text-text-tertiary',  label: 'Pending' },
  clarifying:              { dot: 'bg-blue-400',   text: 'text-blue-400',       label: 'Clarifying', glow: true },
  awaiting_clarification:  { dot: 'bg-blue-400',   text: 'text-blue-400',       label: 'Needs input', glow: true },
  planning:                { dot: 'bg-yellow-500',  text: 'text-yellow-500',    label: 'Planning', glow: true },
  awaiting_plan_approval:  { dot: 'bg-amber-400',   text: 'text-amber-400',     label: 'Awaiting approval', glow: true },
  running:                 { dot: 'bg-yellow-500',  text: 'text-yellow-500',    label: 'Running', glow: true },
  completed:               { dot: 'bg-green-500',   text: 'text-green-500',     label: 'Completed' },
  failed:                  { dot: 'bg-red-500',     text: 'text-red-500',       label: 'Failed' },
  cancelled:               { dot: 'bg-zinc-500',   text: 'text-text-tertiary',  label: 'Cancelled' },
};

export function formatElapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '\u2014';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return '<1s';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

