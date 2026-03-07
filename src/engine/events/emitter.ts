/**
 * RunEventEmitter — buffers execution events and forwards them to the renderer via IPC.
 *
 * Each DAG run gets its own emitter. Events are sent on a dynamic channel
 * `engine:event:{runId}` following the same pattern as agent events.
 */

import type { WebContents } from 'electron';
import type { ExecutionEvent } from './types';
import { IPC_CHANNELS } from '../../types/ipc';

export class RunEventEmitter {
  private buffer: ExecutionEvent[] = [];
  private webContents: WebContents;
  private runId: string;
  private onEmit?: (event: ExecutionEvent) => void;

  constructor(webContents: WebContents, runId: string, onEmit?: (event: ExecutionEvent) => void) {
    this.webContents = webContents;
    this.runId = runId;
    this.onEmit = onEmit;
  }

  /** Emit an event: buffer it, notify the engine, and forward to the renderer via IPC. */
  emit(event: ExecutionEvent): void {
    this.buffer.push(event);
    this.onEmit?.(event);

    if (!this.webContents.isDestroyed()) {
      const channel = IPC_CHANNELS.engineEvent(this.runId);
      this.webContents.send(channel, event);
      // Broadcast to wildcard channel for cross-run listeners (e.g. ApprovalContext)
      this.webContents.send(IPC_CHANNELS.ENGINE_ANY_EVENT, event);
    }
  }

  /** Return all buffered events (for future persistence). */
  getBuffer(): ExecutionEvent[] {
    return [...this.buffer];
  }

  /** Clear the event buffer. */
  clear(): void {
    this.buffer = [];
  }
}
