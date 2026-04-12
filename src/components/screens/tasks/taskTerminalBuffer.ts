/**
 * Global in-memory buffer for task terminal PTY data.
 *
 * Captures raw PTY output from the moment data starts flowing — BEFORE
 * TaskConsoleView mounts. When the console mounts, it replays the buffer
 * then subscribes to live data. This prevents any data gap between the
 * PTY starting and the xterm component rendering.
 *
 * Same pattern as Turbo's terminalBuffer.ts.
 */

const MAX_BUFFER_SIZE = 512 * 1024; // 512 KB per run

const buffers = new Map<string, string>();

export function appendTaskTerminalData(runId: string, data: string): void {
  const existing = buffers.get(runId) || '';
  let updated = existing + data;
  if (updated.length > MAX_BUFFER_SIZE) {
    updated = updated.slice(updated.length - MAX_BUFFER_SIZE);
  }
  buffers.set(runId, updated);
}

export function getTaskTerminalBuffer(runId: string): string {
  return buffers.get(runId) || '';
}

export function clearTaskTerminalBuffer(runId: string): void {
  buffers.delete(runId);
}
