/**
 * SlackStreamSink — bridges AgentRuntime events to a single Slack thread.
 *
 * Strategy (matches the project plan):
 *   1. Post a "Cerebro is thinking…" placeholder (chat.postMessage, in-thread).
 *   2. On every text_delta, accumulate text and schedule a debounced edit.
 *   3. The first scheduled edit fires after EDIT_DEBOUNCE_MS or once the
 *      slice has grown by EDIT_CHUNK_CHARS — whichever happens first.
 *      Slack's chat.update rate limit is Tier 3 (~50/min/channel), and
 *      chat.postMessage is the Special tier (1/sec/channel). A 1.5s
 *      minimum debounce keeps us comfortably inside both budgets.
 *   4. On `done`, finalise the placeholder with the full text. If the
 *      accumulated response exceeds the Slack text cap, chunk into
 *      additional in-thread messages.
 *   5. On `error`, edit the placeholder to a redacted error line.
 *
 * The sink owns no IO beyond the SlackApi handle — it never touches the
 * bridge directly, which makes it trivially unit-testable with a stub.
 */

import type { AgentEventSink, RendererAgentEvent } from '../agents/runtime';
import { SlackApi, scrubTokenish } from './api';
import { chunkSlackText } from './helpers';

const EDIT_DEBOUNCE_MS = 1_500;       // 1.5s minimum between edits
const EDIT_CHUNK_CHARS = 600;         // or 600 chars of new visible text
const MAX_MESSAGE_CHARS = 3500;       // chunk threshold; Slack `text` allows up to 40k

interface SinkDeps {
  api: SlackApi;
  channel: string;
  /** Thread ts to reply into. Use the inbound message's ts if no thread exists. */
  threadTs: string;
  /** Called once the run finishes (with final text) or errors (with err). */
  onDone: (finalText: string, err?: string) => void;
  /** Called any time the sink observes an event — used by the bridge watchdog. */
  onActivity?: () => void;
  /** Initial placeholder text. Defaults to "Cerebro is thinking…". */
  placeholder?: string;
}

export class SlackStreamSink implements AgentEventSink {
  private deps: SinkDeps;
  private accumulated = '';
  private destroyed = false;

  /** ts of the placeholder message that we keep updating. Null until first send. */
  private placeholderTs: string | null = null;
  /** ts values of any follow-up messages we posted when accumulated text exceeded MAX_MESSAGE_CHARS. */
  private overflowTs: string[] = [];

  /** Length of text already visible in the placeholder message. */
  private lastSentVisible = 0;
  private editTimer: NodeJS.Timeout | null = null;
  private lastEditAt = 0;

  /** runId from the run_start event — recorded for the bridge's active-run map. */
  public runId: string | null = null;

  constructor(deps: SinkDeps) {
    this.deps = deps;
    // Kick off the placeholder immediately so the user sees a typing-ish cue
    // even before the model emits its first token.
    void this.ensurePlaceholder();
  }

  send(_channel: string, ...args: unknown[]): void {
    const event = args[0] as RendererAgentEvent | undefined;
    if (!event || typeof event !== 'object') return;

    this.deps.onActivity?.();

    if (event.type === 'run_start' && 'runId' in event) {
      this.runId = event.runId;
      return;
    }

    if (event.type === 'text_delta' && 'delta' in event) {
      this.accumulated += event.delta;
      void this.scheduleEdit();
      return;
    }

    if (event.type === 'done' && 'messageContent' in event) {
      this.accumulated = event.messageContent || this.accumulated;
      void this.finalize();
      return;
    }

    if (event.type === 'error' && 'error' in event) {
      void this.finalizeWithError(event.error);
      return;
    }
    // tool_start / tool_end / system / turn_start → silently ignored.
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  // ── Internals ─────────────────────────────────────────────────

  private async ensurePlaceholder(): Promise<void> {
    if (this.destroyed || this.placeholderTs !== null) return;
    try {
      const text = this.deps.placeholder ?? '_Cerebro is thinking…_';
      const sent = await this.deps.api.chatPostMessage({
        channel: this.deps.channel,
        thread_ts: this.deps.threadTs,
        text,
        mrkdwn: true,
      });
      this.placeholderTs = sent.ts;
    } catch (err) {
      // If we can't post the placeholder we'll try again on the first
      // text_delta — the operator will see an error in the bridge logs.
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Slack] placeholder send failed:', scrubTokenish(msg));
    }
  }

  private async scheduleEdit(): Promise<void> {
    if (this.destroyed) return;

    // We may not have a placeholder yet (initial postMessage still in flight).
    if (this.placeholderTs === null) {
      await this.ensurePlaceholder();
      if (this.placeholderTs === null) return;
    }

    const visibleSlice = this.currentVisibleSlice();
    const overChunk = visibleSlice.length - this.lastSentVisible >= EDIT_CHUNK_CHARS;
    const dueByTime = Date.now() - this.lastEditAt >= EDIT_DEBOUNCE_MS;

    if (overChunk || dueByTime) {
      await this.flushEdit();
      return;
    }
    if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        void this.flushEdit();
      }, EDIT_DEBOUNCE_MS);
      // Don't block the event loop.
      if (typeof this.editTimer.unref === 'function') this.editTimer.unref();
    }
  }

  /** Slack-renderable text within the placeholder. For now we just trim. */
  private currentVisibleSlice(): string {
    // We always render the full accumulated text inside the placeholder
    // until it exceeds MAX_MESSAGE_CHARS, at which point finalize() chunks.
    return this.accumulated;
  }

  private async flushEdit(): Promise<void> {
    if (this.destroyed || this.placeholderTs === null) return;
    const slice = this.currentVisibleSlice();
    if (slice.length === 0) return;

    // If the accumulated text exceeds the cap, we still only show the first
    // MAX_MESSAGE_CHARS in the placeholder during streaming — the chunk-out
    // happens in finalize(). This keeps streaming UX simple.
    const visible = slice.length > MAX_MESSAGE_CHARS ? slice.slice(0, MAX_MESSAGE_CHARS) : slice;

    try {
      await this.deps.api.chatUpdate({
        channel: this.deps.channel,
        ts: this.placeholderTs,
        text: visible,
      });
      this.lastSentVisible = visible.length;
      this.lastEditAt = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "message_not_found" or "channel_not_found" → fatal; "msg_too_long" → drop.
      if (!/not_found/i.test(msg)) {
        console.error('[Slack] chat.update failed:', scrubTokenish(msg));
      }
    }
  }

  private async finalize(): Promise<void> {
    if (this.destroyed) return;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }

    const finalText = (this.accumulated.trim().length === 0)
      ? '_(empty response)_'
      : this.accumulated;
    const chunks = chunkSlackText(finalText, MAX_MESSAGE_CHARS);

    // First chunk goes into the placeholder via chat.update.
    if (this.placeholderTs !== null) {
      try {
        await this.deps.api.chatUpdate({
          channel: this.deps.channel,
          ts: this.placeholderTs,
          text: chunks[0],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Slack] finalize chat.update failed:', scrubTokenish(msg));
      }
    } else {
      // We never managed to post the placeholder — emit a fresh message.
      try {
        const sent = await this.deps.api.chatPostMessage({
          channel: this.deps.channel,
          thread_ts: this.deps.threadTs,
          text: chunks[0],
        });
        this.placeholderTs = sent.ts;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Slack] finalize chat.postMessage failed:', scrubTokenish(msg));
      }
    }

    // Remaining chunks → additional in-thread messages.
    for (let i = 1; i < chunks.length; i++) {
      try {
        const sent = await this.deps.api.chatPostMessage({
          channel: this.deps.channel,
          thread_ts: this.deps.threadTs,
          text: chunks[i],
        });
        this.overflowTs.push(sent.ts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Slack] finalize chunk postMessage failed:', scrubTokenish(msg));
      }
    }

    this.teardown();
    this.deps.onDone(finalText);
  }

  private async finalizeWithError(error: string): Promise<void> {
    if (this.destroyed) return;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }

    const text = `:warning: ${scrubTokenish(error)}`;
    if (this.placeholderTs !== null) {
      try {
        await this.deps.api.chatUpdate({
          channel: this.deps.channel,
          ts: this.placeholderTs,
          text,
        });
      } catch { /* ignore */ }
    } else {
      try {
        await this.deps.api.chatPostMessage({
          channel: this.deps.channel,
          thread_ts: this.deps.threadTs,
          text,
        });
      } catch { /* ignore */ }
    }
    this.teardown();
    this.deps.onDone(this.accumulated, error);
  }

  private teardown(): void {
    this.destroyed = true;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
  }
}
