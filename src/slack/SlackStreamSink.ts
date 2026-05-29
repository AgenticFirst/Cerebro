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
 *   4. On `done`, delete the placeholder and post the full text as a NEW
 *      in-thread message. Slack does not push a notification for edits, so
 *      we have to post fresh for the user's client to ping them. If the
 *      response exceeds the Slack text cap, chunk into additional in-thread
 *      messages.
 *   5. On `error`, delete the placeholder and post a redacted error line as
 *      a new in-thread message (same notification reasoning).
 *
 * The sink owns no IO beyond the SlackApi handle — it never touches the
 * bridge directly, which makes it trivially unit-testable with a stub.
 */

import type { AgentEventSink, RendererAgentEvent } from '../agents/runtime';
import { SlackApi, scrubTokenish } from './api';
import { chunkSlackText } from './helpers';
import { markdownToMrkdwn } from './mrkdwn';

const EDIT_DEBOUNCE_MS = 1_500;       // 1.5s minimum between edits
const EDIT_CHUNK_CHARS = 600;         // or 600 chars of new visible text
const MAX_MESSAGE_CHARS = 3500;       // chunk threshold; Slack `text` allows up to 40k

interface SinkDeps {
  api: SlackApi;
  channel: string;
  /**
   * Thread ts to reply into. Leave undefined to post at top level (the
   * default for DMs and top-level channel @mentions). Set only when the
   * inbound message was already part of an existing thread.
   */
  threadTs?: string;
  /** Called once the run finishes (with final text) or errors (with err). */
  onDone: (finalText: string, err?: string) => void;
  /** Called any time the sink observes an event — used by the bridge watchdog. */
  onActivity?: () => void;
  /** Initial placeholder text. Defaults to "Cerebro is thinking…". */
  placeholder?: string;
  /**
   * Invoked when the run errors with `errorClass: 'auth'`. The bridge
   * uses this to kick off the operator DM paste-back flow instead of
   * letting the raw "Cerebro lost its Claude Code session" text reach
   * the requesting user. Suppresses the default :warning: post when
   * this returns true (handled).
   */
  onAuthFailure?: () => boolean | Promise<boolean>;
}

export class SlackStreamSink implements AgentEventSink {
  private deps: SinkDeps;
  private accumulated = '';
  private destroyed = false;

  /** ts of the placeholder message that we keep updating. Null until first send. */
  private placeholderTs: string | null = null;
  /**
   * Resolves once the in-flight placeholder send settles (success or failure).
   * finalize() awaits this so a fast-returning model can't race past the post.
   */
  private placeholderPromise: Promise<void> | null = null;
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
      const errorClass = ('errorClass' in event ? (event as { errorClass?: string }).errorClass : undefined);
      void this.finalizeWithError(event.error, errorClass);
      return;
    }
    // tool_start / tool_end / system / turn_start → silently ignored.
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  // ── Internals ─────────────────────────────────────────────────

  private ensurePlaceholder(): Promise<void> {
    if (this.destroyed || this.placeholderTs !== null) return Promise.resolve();
    if (this.placeholderPromise) return this.placeholderPromise;
    const run = async (): Promise<void> => {
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
    };
    this.placeholderPromise = run();
    return this.placeholderPromise;
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
    const rendered = markdownToMrkdwn(slice);
    const visible = rendered.length > MAX_MESSAGE_CHARS
      ? rendered.slice(0, MAX_MESSAGE_CHARS)
      : rendered;

    try {
      await this.deps.api.chatUpdate({
        channel: this.deps.channel,
        ts: this.placeholderTs,
        text: visible,
      });
      this.lastSentVisible = slice.length;
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

    // If the placeholder is still being posted, let it finish before we
    // decide whether to delete it. Otherwise we can orphan the placeholder
    // above a freshly-posted final answer.
    if (this.placeholderPromise) {
      try { await this.placeholderPromise; } catch { /* ignore — handled in ensurePlaceholder */ }
    }

    const finalText = (this.accumulated.trim().length === 0)
      ? '_(empty response)_'
      : this.accumulated;
    // Convert to Slack mrkdwn before chunking — link/header rewrites change
    // length and we want chunk boundaries to land on the actual sent text.
    const renderedFinal = markdownToMrkdwn(finalText);
    const chunks = chunkSlackText(renderedFinal, MAX_MESSAGE_CHARS);

    // Edits don't fire Slack notifications, so we delete the placeholder
    // and post the final answer fresh. The new chat.postMessage rings the
    // user's client exactly like a human reply would.
    await this.deletePlaceholderIfAny();

    // First (and possibly only) chunk → notifying post.
    try {
      await this.deps.api.chatPostMessage({
        channel: this.deps.channel,
        thread_ts: this.deps.threadTs,
        text: chunks[0],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Slack] finalize chat.postMessage failed:', scrubTokenish(msg));
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

  private async finalizeWithError(error: string, errorClass?: string): Promise<void> {
    if (this.destroyed) return;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }

    if (this.placeholderPromise) {
      try { await this.placeholderPromise; } catch { /* ignore */ }
    }

    await this.deletePlaceholderIfAny();

    // Auth failures get a humane brief reply in the thread + the bridge
    // routes the actual recovery to the operator's DM. The raw error
    // ("Cerebro lost its Claude Code session.") is suppressed — it gives
    // the requesting user nothing they can act on, especially on a
    // headless server they don't have terminal access to.
    if (errorClass === 'auth') {
      let handled = false;
      if (this.deps.onAuthFailure) {
        try {
          handled = await this.deps.onAuthFailure();
        } catch { /* fall through to default post */ }
      }
      if (handled) {
        const brief = "I'm reconnecting to Claude — operator notified. Try again in a moment.";
        try {
          await this.deps.api.chatPostMessage({
            channel: this.deps.channel,
            thread_ts: this.deps.threadTs,
            text: brief,
          });
        } catch { /* ignore */ }
        this.teardown();
        this.deps.onDone(this.accumulated, error);
        return;
      }
      // Fall through to the default :warning: post when no operator was
      // configured — at least the requesting user knows something broke.
    }

    const text = `:warning: ${scrubTokenish(error)}`;
    try {
      await this.deps.api.chatPostMessage({
        channel: this.deps.channel,
        thread_ts: this.deps.threadTs,
        text,
      });
    } catch { /* ignore */ }

    this.teardown();
    this.deps.onDone(this.accumulated, error);
  }

  /**
   * Best-effort delete of the streaming placeholder. We tolerate
   * `message_not_found` (already gone) and log every other failure but keep
   * going — a stray placeholder above a notifying final message is worse
   * UX than the current silent-edit bug, but still better than no answer
   * at all.
   */
  private async deletePlaceholderIfAny(): Promise<void> {
    const ts = this.placeholderTs;
    if (ts === null) return;
    this.placeholderTs = null;
    try {
      await this.deps.api.chatDelete({ channel: this.deps.channel, ts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/message_not_found/i.test(msg)) {
        console.error('[Slack] chat.delete placeholder failed:', scrubTokenish(msg));
      }
    }
  }

  private teardown(): void {
    this.destroyed = true;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
  }
}
