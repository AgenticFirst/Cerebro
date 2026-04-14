/**
 * RunEventEmitter — buffers execution events and forwards them to the renderer via IPC.
 *
 * Each DAG run gets its own emitter. Events are sent on a dynamic channel
 * `engine:event:{runId}` following the same pattern as agent events.
 */

import type { WebContents } from 'electron';
import type EventEmitter from 'node:events';
import type { ExecutionEvent } from './types';
import { IPC_CHANNELS } from '../../types/ipc';

/** Event name used on the shared in-process engine event bus. */
export const ENGINE_EVENT = 'engine-event' as const;

/**
 * Context attached to each ExecutionEvent when broadcast on the shared bus.
 * Lets non-renderer subscribers (e.g. TelegramBridge) correlate events to
 * the originating run without having to peek at each event's type.
 */
export interface EngineEventContext {
  runId: string;
  routineId?: string;
}

export class RunEventEmitter {
  private buffer: ExecutionEvent[] = [];
  private webContents: WebContents;
  private runId: string;
  private onEmit?: (event: ExecutionEvent) => void;
  private sharedBus?: EventEmitter;
  private context: EngineEventContext;

  constructor(
    webContents: WebContents,
    runId: string,
    onEmit?: (event: ExecutionEvent) => void,
    sharedBus?: EventEmitter,
    context?: Partial<EngineEventContext>,
  ) {
    this.webContents = webContents;
    this.runId = runId;
    this.onEmit = onEmit;
    this.sharedBus = sharedBus;
    this.context = { runId, ...context };
  }

  /** Emit an event: buffer it, notify the engine, and forward to the renderer via IPC. */
  emit(event: ExecutionEvent): void {
    this.buffer.push(event);
    this.onEmit?.(event);

    // Fan out to in-process subscribers (e.g. TelegramBridge) before IPC — they
    // may need to react synchronously (e.g. to forward an approval).
    this.sharedBus?.emit(ENGINE_EVENT, event, this.context);

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
