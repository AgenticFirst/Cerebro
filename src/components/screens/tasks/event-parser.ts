/**
 * Shared deserializer for raw task_events rows into TaskLogEntry objects.
 * Used by TaskContext.watchTask and TaskConsoleView for historical replay.
 */

import type { TaskLogEntry } from './types';

export interface RawTaskEvent {
  seq: number;
  kind: string;
  payload_json: string;
}

export function parseTaskEvents(raw: RawTaskEvent[]): TaskLogEntry[] {
  const entries: TaskLogEntry[] = [];
  for (const evt of raw) {
    try {
      const p = JSON.parse(evt.payload_json);
      if (evt.kind === 'text_delta') entries.push({ kind: 'text_delta', text: p.delta ?? '', phaseId: p.phaseId ?? null });
      else if (evt.kind === 'tool_start') entries.push({ kind: 'tool_start', toolCallId: p.toolCallId, toolName: p.toolName, args: p.args });
      else if (evt.kind === 'tool_end') entries.push({ kind: 'tool_end', toolCallId: p.toolCallId, toolName: p.toolName, result: p.result, isError: p.isError });
      else if (evt.kind === 'phase_start') entries.push({ kind: 'phase_start', phaseId: p.phaseId ?? '', name: p.name ?? '' });
      else if (evt.kind === 'phase_end') entries.push({ kind: 'phase_end', phaseId: p.phaseId ?? '' });
      else if (evt.kind === 'error') entries.push({ kind: 'error', message: p.error ?? 'Unknown error' });
      else if (evt.kind === 'system') entries.push({ kind: 'system', message: p.message ?? 'system event' });
    } catch { /* skip malformed */ }
  }
  return entries;
}
