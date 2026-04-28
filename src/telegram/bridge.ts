/**
 * TelegramBridge — long-poll Telegram Bot API, relay messages to/from
 * AgentRuntime, surface approvals as inline buttons, and expose a
 * sendProactive() entry point for the routine `channel` action.
 *
 * Security posture:
 *  - Allowlist gate (numeric Telegram user IDs) before any I/O
 *  - Private-chat-only (no groups / channels)
 *  - Attachment MIME + size sandboxing
 *  - Per-user rate limits
 *  - Central token-scrubbing in logs via api.ts sanitizeUrl / scrubTokenish
 */

import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { WebContents } from 'electron';
import type { AgentRuntime, AgentEventSink, AgentRunRequest, RendererAgentEvent } from '../agents';
import type { ExecutionEvent } from '../engine/events/types';
import { ENGINE_EVENT, type EngineEventContext } from '../engine/events/emitter';
import type { ExecutionEngine } from '../engine/engine';
import type { TelegramChannel } from '../engine/actions/telegram-channel';
import { IPC_CHANNELS } from '../types/ipc';
import { TelegramApi, TelegramApiError, approvalKeyboard, scrubTokenish } from './api';
import {
  encryptForStorage,
  decryptFromStorage,
  isStoredPlaintext,
  backend as secureTokenBackend,
} from '../secure-token';
import {
  chunkText,
  SlidingWindowLimiter,
  redactForChat,
  parseApprovalCallback,
  matchRoutineTriggers,
  parseTelegramTriggerRoutine,
} from './helpers';
import type { TelegramTriggerRoutine, BackendRoutineRecord } from './helpers';
import {
  TELEGRAM_SETTING_KEYS,
  type TelegramSettings,
  type TelegramUpdate,
  type TelegramMessage,
  type TelegramCallbackQuery,
  type TelegramStatus,
  type TelegramVerifyResult,
} from './types';

// ── Tunables ──────────────────────────────────────────────────────

const LONG_POLL_TIMEOUT_SEC = 30;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_MESSAGE_CHARS = 4_000;
const EDIT_DEBOUNCE_MS = 1_200;
const EDIT_CHUNK_CHARS = 400;
const TYPING_ACTION_INTERVAL_MS = 4_000;
const UNKNOWN_USER_RATE_LIMIT_MS = 10_000; // 1 reply per 10 s per unknown user
const AUTHORIZED_RATE_LIMIT_PER_MIN = 20;
const PROACTIVE_RATE_LIMIT_PER_HOUR = 30;
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 30 * 60 * 1000;
const ORPHAN_SWEEP_AGE_MS = 24 * 60 * 60 * 1000; // delete temp files older than 24h on startup
const ROUTINE_CACHE_TTL_MS = 30_000;
// If an agent run produces no events for this long, assume the underlying
// Claude Code subprocess hung or died silently and reclaim the slot so the
// user isn't permanently blocked behind a "still working" message.
const RUN_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const RUN_WATCHDOG_INTERVAL_MS = 30_000;

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

// ── Helpers ───────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  console.log('[Telegram]', ...args.map((a) => (typeof a === 'string' ? scrubTokenish(a) : a)));
}

function logError(...args: unknown[]): void {
  console.error('[Telegram]', ...args.map((a) => (typeof a === 'string' ? scrubTokenish(a) : a)));
}

// ── Settings helpers (backend /settings/{key}) ────────────────────

async function backendGetSetting<T>(port: number, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/settings/${key}`, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { value: string };
          resolve(JSON.parse(parsed.value) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5_000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function backendPutSetting(port: number, key: string, value: unknown): Promise<void> {
  await backendRequest(port, 'PUT', `/settings/${key}`, { value: JSON.stringify(value) });
}

function backendRequest<T = unknown>(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  return new Promise((resolve) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          let parsed: T | null = null;
          try { parsed = JSON.parse(data) as T; } catch { parsed = null; }
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode ?? 0,
            data: parsed,
          });
        });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: null }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Streaming sink ────────────────────────────────────────────────

/**
 * A WebContents-shaped sink that:
 *  - sendMessage's a single "…" placeholder on first text_delta,
 *  - debounced editMessageText as text accumulates,
 *  - on 'done' finalises the message (chunked if > 4000 chars),
 *  - on 'error' edits the bubble to an error line.
 */
class TelegramStreamSink implements AgentEventSink {
  private accumulated = '';
  private firstMessageId: number | null = null;
  private currentMessageId: number | null = null;
  private currentMessageBase = 0; // text length before currentMessageId
  private editTimer: NodeJS.Timeout | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  private lastEditAt = 0;
  private destroyed = false;
  private onDoneCb: (finalText: string, err?: string) => void;
  private onActivityCb: (() => void) | null;
  private api: TelegramApi;
  private chatId: number;
  private replyToMessageId?: number;
  public runId: string | null = null;

  constructor(
    api: TelegramApi,
    chatId: number,
    replyToMessageId: number | undefined,
    onDone: (finalText: string, err?: string) => void,
    onActivity?: () => void,
  ) {
    this.api = api;
    this.chatId = chatId;
    this.replyToMessageId = replyToMessageId;
    this.onDoneCb = onDone;
    this.onActivityCb = onActivity ?? null;
    this.typingTimer = setInterval(() => {
      if (!this.destroyed) {
        this.api.sendChatAction(this.chatId, 'typing').catch(() => { /* non-fatal */ });
      }
    }, TYPING_ACTION_INTERVAL_MS);
    // Kick off initial typing indicator immediately.
    this.api.sendChatAction(this.chatId, 'typing').catch(() => { /* non-fatal */ });
  }

  send(_channel: string, ...args: unknown[]): void {
    const event = args[0] as RendererAgentEvent;
    if (!event || typeof event !== 'object') return;

    this.onActivityCb?.();

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
      // Prefer the authoritative final text from the agent.
      this.accumulated = event.messageContent || this.accumulated;
      void this.finalize();
      return;
    }

    if (event.type === 'error' && 'error' in event) {
      void this.finalizeWithError(event.error);
      return;
    }
    // tool_start / tool_end / turn_start / system → ignore for now;
    // keeps the phone view uncluttered.
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  private async scheduleEdit(): Promise<void> {
    if (this.destroyed) return;
    const visible = this.currentSliceText();
    const overChunk = visible.length - this.lastSentVisible >= EDIT_CHUNK_CHARS;
    const dueByTime = Date.now() - this.lastEditAt >= EDIT_DEBOUNCE_MS;

    if (overChunk || dueByTime) {
      await this.flushEdit();
    } else if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = null;
        void this.flushEdit();
      }, EDIT_DEBOUNCE_MS);
    }
  }

  private lastSentVisible = 0;

  private currentSliceText(): string {
    return this.accumulated.slice(this.currentMessageBase);
  }

  private async flushEdit(): Promise<void> {
    if (this.destroyed) return;
    let slice = this.currentSliceText();
    if (slice.length === 0) return;

    // Rollover to a new message if current slice exceeds the Telegram max.
    if (slice.length > MAX_MESSAGE_CHARS) {
      const head = slice.slice(0, MAX_MESSAGE_CHARS);
      // Finalise the head into the current message (no more edits to it).
      if (this.currentMessageId !== null) {
        await this.safeEdit(this.currentMessageId, head);
      } else {
        await this.sendInitial(head);
      }
      this.currentMessageBase += head.length;
      this.currentMessageId = null;
      // Start a new message with the remainder in the next tick.
      this.lastSentVisible = 0;
      slice = this.currentSliceText();
    }

    if (this.currentMessageId === null) {
      await this.sendInitial(slice);
    } else {
      await this.safeEdit(this.currentMessageId, slice);
    }
    this.lastSentVisible = slice.length;
    this.lastEditAt = Date.now();
  }

  private async sendInitial(text: string): Promise<void> {
    try {
      const sent = await this.api.sendMessage(this.chatId, text || '…', {
        reply_to_message_id: this.firstMessageId == null ? this.replyToMessageId : undefined,
      });
      this.currentMessageId = sent.message_id;
      if (this.firstMessageId === null) this.firstMessageId = sent.message_id;
    } catch (err) {
      logError('sendInitial failed', err instanceof Error ? err.message : String(err));
    }
  }

  private async safeEdit(messageId: number, text: string): Promise<void> {
    try {
      await this.api.editMessageText(this.chatId, messageId, text);
    } catch (err) {
      // Telegram returns 400 if the new text equals the old one — that's fine.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not modified/i.test(msg)) {
        logError('editMessageText failed', msg);
      }
    }
  }

  private async finalize(): Promise<void> {
    if (this.destroyed) return;
    // Cancel scheduled debounce and flush whatever is left.
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }

    // If the total accumulated text exceeds what fits in a single message,
    // chunk the full text into multiple messages instead of relying on
    // mid-stream rollover (which may have left a partial final chunk).
    const finalText = this.accumulated.trim().length === 0
      ? '(empty response)'
      : this.accumulated;
    const chunks = chunkText(finalText, MAX_MESSAGE_CHARS);

    // First chunk goes into the currentMessageId (or sendMessage if none).
    if (this.currentMessageId !== null) {
      await this.safeEdit(this.currentMessageId, chunks[0]);
    } else {
      try {
        const sent = await this.api.sendMessage(this.chatId, chunks[0], {
          reply_to_message_id: this.replyToMessageId,
        });
        this.firstMessageId = sent.message_id;
      } catch (err) {
        logError('finalize sendMessage failed', err instanceof Error ? err.message : String(err));
      }
    }

    for (let i = 1; i < chunks.length; i++) {
      try {
        await this.api.sendMessage(this.chatId, chunks[i]);
      } catch (err) {
        logError('finalize chunk sendMessage failed', err instanceof Error ? err.message : String(err));
      }
    }

    this.teardown();
    this.onDoneCb(finalText);
  }

  private async finalizeWithError(error: string): Promise<void> {
    if (this.destroyed) return;
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }

    const text = `⚠️ ${scrubTokenish(error)}`;
    if (this.currentMessageId !== null) {
      await this.safeEdit(this.currentMessageId, text);
    } else {
      try {
        await this.api.sendMessage(this.chatId, text, {
          reply_to_message_id: this.replyToMessageId,
        });
      } catch { /* ignore */ }
    }
    this.teardown();
    this.onDoneCb(this.accumulated, error);
  }

  private teardown(): void {
    this.destroyed = true;
    if (this.typingTimer) { clearInterval(this.typingTimer); this.typingTimer = null; }
    if (this.editTimer) { clearTimeout(this.editTimer); this.editTimer = null; }
  }
}

// ── Active run tracking per chat ──────────────────────────────────

interface ActiveTelegramRun {
  runId: string;
  conversationId: string;
  sink: TelegramStreamSink;
  userContent: string;
  startedAt: number;
  /** Updated every time the sink observes an event (including text deltas).
   *  The watchdog uses this to distinguish "long but alive" from "stuck". */
  lastActivityAt: number;
}

// ── TelegramBridge ────────────────────────────────────────────────

export interface TelegramBridgeDeps {
  backendPort: number;
  agentRuntime: AgentRuntime;
  dataDir: string;
  engineEventBus: EventEmitter;
  /** Optional engine ref so inbound messages can dispatch routine triggers. */
  executionEngine?: ExecutionEngine;
}

export class TelegramBridge implements TelegramChannel {
  private deps: TelegramBridgeDeps;
  private api: TelegramApi | null = null;
  private settings: TelegramSettings = emptySettings();
  private polling = false;
  private pollAbort: AbortController | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private botUsername: string | null = null;

  private unknownUserLastReply = new Map<string, number>();
  private authorizedRateLimiter = new SlidingWindowLimiter(AUTHORIZED_RATE_LIMIT_PER_MIN, 60_000);
  private proactiveRateLimiter = new SlidingWindowLimiter(PROACTIVE_RATE_LIMIT_PER_HOUR, 60 * 60 * 1_000);

  private activeRuns = new Map<number, ActiveTelegramRun>(); // chatId → run
  private runWatchdogTimer: NodeJS.Timeout | null = null;
  private approvalChatMap = new Map<string, number>(); // approvalId → chatId
  private tempFiles = new Map<string, NodeJS.Timeout>();

  private engineListener: ((event: ExecutionEvent, ctx: EngineEventContext) => void) | null = null;

  /** Routines with trigger_type='telegram_message', cached briefly to keep the hot path off the backend. */
  private routineCache: { fetchedAt: number; routines: TelegramTriggerRoutine[] } | null = null;

  /** Main window WebContents — populated lazily after the window opens.
   *  Required for routine dispatch (the engine forwards step events here). */
  private webContents: WebContents | null = null;

  constructor(deps: TelegramBridgeDeps) {
    this.deps = deps;
  }

  /** Late-bind the engine for routine dispatch. The engine is constructed before
   *  the bridge in main.ts; calling this during wiring lets either order work. */
  setExecutionEngine(engine: ExecutionEngine): void {
    this.deps.executionEngine = engine;
  }

  /** Late-bind the main window WebContents — required so routine dispatch
   *  can forward engine events to the renderer. Mirrors RoutineScheduler. */
  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Start the bridge. Safe to call multiple times — the second call is a no-op
   * unless settings changed; callers should stop() first if restarting after a
   * settings update.
   */
  async start(): Promise<void> {
    if (this.polling) return;
    await this.loadSettings();

    if (!this.settings.enabled || !this.settings.token) {
      const reason = !this.settings.token
        ? 'No bot token configured.'
        : 'Telegram bridge is disabled.';
      this.lastError = reason;
      log(`bridge not started: ${reason}`);
      return;
    }

    // Discovery mode: bridge runs with no allowlist so users can message the
    // bot to learn their own numeric ID (handleMessage replies with it,
    // rate-limited via shouldReplyUnknown). No conversations are created and
    // no AI processing happens until at least one ID is added.
    if (this.settings.allowlist.length === 0) {
      log('bridge starting in discovery mode (allowlist is empty — bot will only reply with sender IDs)');
    }

    // Only create the temp dir when we actually need it.
    fs.mkdirSync(this.tempDir(), { recursive: true });
    // Sweep orphaned attachments left behind by a prior crash/quit.
    this.sweepOrphanAttachments();

    this.api = new TelegramApi(this.settings.token);

    try {
      const me = await this.api.getMe();
      this.botUsername = me.username ?? null;
      log(`bridge started as @${me.username} (id=${me.id})`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logError('bridge failed to start: getMe error —', this.lastError);
      this.api = null;
      return;
    }

    // Backfill the conversations table so existing Telegram conversations
    // get the source/external_chat_id columns the sidebar uses for the badge.
    void this.backfillConversationSources();

    this.routineCache = null;
    this.polling = true;
    this.pollAbort = new AbortController();
    this.subscribeToEngineEvents();
    this.startRunWatchdog();
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
    this.api?.abortPending();
    this.api = null;
    this.botUsername = null;
    this.routineCache = null;

    if (this.engineListener) {
      this.deps.engineEventBus.off(ENGINE_EVENT, this.engineListener);
      this.engineListener = null;
    }

    if (this.runWatchdogTimer) {
      clearInterval(this.runWatchdogTimer);
      this.runWatchdogTimer = null;
    }

    // Clean up temp files.
    for (const [p, timer] of this.tempFiles) {
      clearTimeout(timer);
      fs.rm(p, { force: true }, () => { /* ignore */ });
    }
    this.tempFiles.clear();

    // Cancel in-flight runs (their sinks have already been teardown'd).
    for (const [, run] of this.activeRuns) {
      this.deps.agentRuntime.cancelRun(run.runId);
    }
    this.activeRuns.clear();

    log('bridge stopped');
  }

  /**
   * Re-read settings (allowlist, forwardAllApprovals, chatExpertMap) without
   * bouncing the long-poll loop. Returns whether the bridge was running.
   * The token is not hot-swappable — token changes still require disable→enable.
   */
  async reloadSettings(): Promise<{ ok: boolean; error?: string }> {
    try {
      const previousToken = this.settings.token;
      await this.loadSettings();
      this.routineCache = null;
      if (this.settings.token !== previousToken && this.polling) {
        // Token changed mid-flight. Easier to make the caller restart explicitly.
        return { ok: false, error: 'Token changed — disable and re-enable Telegram to apply.' };
      }
      log('settings reloaded');
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('reloadSettings failed', msg);
      return { ok: false, error: msg };
    }
  }

  /** Called from IPC: try a token and return whether it looks valid. */
  async verifyToken(token: string): Promise<TelegramVerifyResult> {
    try {
      const probe = new TelegramApi(token);
      const me = await probe.getMe();
      return { ok: true, username: me.username, botId: me.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrubTokenish(msg) };
    }
  }

  status(): TelegramStatus {
    return {
      running: this.polling,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      unknownLastAttempt: Object.fromEntries(this.unknownUserLastReply),
      botUsername: this.botUsername,
      hasToken: this.hasToken(),
      tokenBackend: secureTokenBackend(),
    };
  }

  // ── TelegramChannel implementation (consumed by send_telegram_message) ──

  /** Allowlist gate — exposed so the engine action can reject before sending. */
  isAllowlisted(chatId: string): boolean {
    return this.settings.allowlist.includes(String(chatId).trim());
  }

  /** Lookup a previously-seen username for a chat. Used by the chat header strip. */
  usernameForChat(chatId: string): string | null {
    return this.settings.chatUsernames[String(chatId).trim()] ?? null;
  }

  /** The bot's own @username (set after getMe), or null if not running. */
  getBotUsername(): string | null {
    return this.botUsername;
  }

  /**
   * Send a single message from a routine action. Mirrors sendProactive's
   * redaction + rate-limit checks but returns the message_id so a downstream
   * step can quote/edit it.
   */
  async sendActionMessage(
    chatId: string,
    text: string,
    parseMode?: 'HTML' | 'MarkdownV2' | 'none',
  ): Promise<{ messageId: number | null; error: string | null }> {
    if (!this.api || !this.polling) {
      return { messageId: null, error: 'Telegram bridge not running' };
    }
    const recipient = String(chatId).trim();
    if (!this.isAllowlisted(recipient)) {
      return { messageId: null, error: `chat_id ${recipient} not in allowlist` };
    }
    if (!this.proactiveRateLimiter.allow(recipient)) {
      return { messageId: null, error: `chat_id ${recipient} rate-limited` };
    }
    const numericChatId = Number(recipient);
    if (!Number.isFinite(numericChatId)) {
      return { messageId: null, error: `chat_id ${recipient} is not a numeric Telegram id` };
    }
    const safeText = this.redactForChat(text);
    const chunks = chunkText(safeText, MAX_MESSAGE_CHARS);
    let firstMessageId: number | null = null;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const sent = await this.api.sendMessage(numericChatId, chunks[i], {
          parse_mode: parseMode && parseMode !== 'none' ? parseMode : undefined,
        });
        if (i === 0) firstMessageId = sent.message_id;
      }
      return { messageId: firstMessageId, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { messageId: firstMessageId, error: scrubTokenish(msg) };
    }
  }

  /**
   * Send a proactive message from a routine's `channel` action.
   * Returns summary counts so the step record has useful output.
   */
  async sendProactive(
    recipients: string[],
    text: string,
  ): Promise<{ sent: number; skipped: number; errors: string[] }> {
    if (!this.api || !this.polling) {
      return { sent: 0, skipped: recipients.length, errors: ['Telegram bridge not running'] };
    }
    const result = { sent: 0, skipped: 0, errors: [] as string[] };
    const safeText = this.redactForChat(text);

    for (const recipient of recipients) {
      if (!this.settings.allowlist.includes(recipient)) {
        result.skipped++;
        result.errors.push(`recipient ${recipient} not in allowlist`);
        continue;
      }
      if (!this.proactiveRateLimiter.allow(recipient)) {
        result.skipped++;
        result.errors.push(`recipient ${recipient} rate-limited`);
        continue;
      }
      const chatId = Number(recipient);
      const chunks = chunkText(safeText, MAX_MESSAGE_CHARS);
      try {
        for (const chunk of chunks) {
          await this.api.sendMessage(chatId, chunk);
        }
        result.sent++;
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return result;
  }

  // ── Internals ───────────────────────────────────────────────────

  private subscribeToEngineEvents(): void {
    const listener = (event: ExecutionEvent, ctx: EngineEventContext): void => {
      if (event.type === 'approval_requested' && 'approvalId' in event) {
        void this.handleApprovalRequested(event);
        return;
      }
      if (event.type === 'approval_granted' || event.type === 'approval_denied') {
        const approvalId = 'approvalId' in event ? event.approvalId : null;
        if (approvalId) {
          this.approvalChatMap.delete(approvalId);
        }
        return;
      }
      if (event.type === 'run_completed' || event.type === 'run_failed') {
        void this.handleRoutineCompleted(event, ctx);
        return;
      }
    };
    this.engineListener = listener;
    this.deps.engineEventBus.on(ENGINE_EVENT, listener);
  }

  private async handleApprovalRequested(
    event: Extract<ExecutionEvent, { type: 'approval_requested' }>,
  ): Promise<void> {
    if (!this.api) return;

    // Route to: the chat that originated the run, OR broadcast when
    // forwardAllApprovals is on and we don't know the origin.
    const originChatId = this.findOriginChatIdForRun();
    const targets: number[] = [];
    if (originChatId !== null) {
      targets.push(originChatId);
    } else if (this.settings.forwardAllApprovals) {
      for (const uid of this.settings.allowlist) targets.push(Number(uid));
    }

    if (targets.length === 0) return;

    const summary = this.redactForChat(event.summary || `Step "${event.stepId}" needs approval`);
    for (const chatId of targets) {
      try {
        await this.api.sendMessage(chatId, `🔐 Approval requested\n\n${summary}`, {
          reply_markup: approvalKeyboard(event.approvalId),
        });
        this.approvalChatMap.set(event.approvalId, chatId);
      } catch (err) {
        logError('approval send failed', err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async handleRoutineCompleted(
    event: Extract<ExecutionEvent, { type: 'run_completed' | 'run_failed' }>,
    ctx: EngineEventContext,
  ): Promise<void> {
    if (!this.api) return;
    if (!ctx.routineId) return;

    const routine = await backendRequest<{
      id: string; name: string; notify_channels?: Array<{ channel: string; recipient: string }>;
    }>(this.deps.backendPort, 'GET', `/routines/${ctx.routineId}`);

    const notifyChannels = routine.data?.notify_channels ?? [];
    const telegramRecipients = notifyChannels
      .filter((n) => n.channel === 'telegram')
      .map((n) => n.recipient);

    if (telegramRecipients.length === 0) return;

    const name = routine.data?.name ?? 'routine';
    const summary = event.type === 'run_completed'
      ? `✅ Routine "${name}" completed.`
      : `❌ Routine "${name}" failed: ${'error' in event ? event.error : 'unknown error'}`;

    await this.sendProactive(telegramRecipients, summary);
  }

  // v1 heuristic: if there's exactly one active Telegram run, the approval
  // almost certainly belongs to it. Otherwise fall through to forwardAllApprovals.
  private findOriginChatIdForRun(): number | null {
    if (this.activeRuns.size !== 1) return null;
    return this.activeRuns.keys().next().value ?? null;
  }

  private async loadSettings(): Promise<void> {
    const port = this.deps.backendPort;
    const [storedToken, allowlist, enabled, forwardAll, chatMap, chatExpertMap, chatUsernames, lastUpdate] = await Promise.all([
      backendGetSetting<string>(port, TELEGRAM_SETTING_KEYS.token),
      backendGetSetting<string[]>(port, TELEGRAM_SETTING_KEYS.allowlist),
      backendGetSetting<boolean>(port, TELEGRAM_SETTING_KEYS.enabled),
      backendGetSetting<boolean>(port, TELEGRAM_SETTING_KEYS.forwardAllApprovals),
      backendGetSetting<Record<string, string>>(port, TELEGRAM_SETTING_KEYS.chatMap),
      backendGetSetting<Record<string, string>>(port, TELEGRAM_SETTING_KEYS.chatExpertMap),
      backendGetSetting<Record<string, string>>(port, TELEGRAM_SETTING_KEYS.chatUsernames),
      backendGetSetting<number>(port, TELEGRAM_SETTING_KEYS.lastUpdateId),
    ]);

    const token = decryptFromStorage(storedToken);
    // Transparent migration: if the value on disk wasn't encrypted (legacy plaintext
    // from before the secure-token module existed) and we have a working keychain,
    // re-save it under encryption so the next read decrypts cleanly.
    if (token && isStoredPlaintext(storedToken) && secureTokenBackend() === 'os-keychain') {
      const reEncrypted = encryptForStorage(token);
      await backendPutSetting(port, TELEGRAM_SETTING_KEYS.token, reEncrypted)
        .then(() => log('migrated legacy plaintext token to OS keychain'))
        .catch(() => { /* non-fatal — try again next load */ });
    }

    this.settings = {
      token,
      allowlist: Array.isArray(allowlist) ? allowlist : [],
      enabled: enabled ?? false,
      forwardAllApprovals: forwardAll ?? false,
      chatMap: chatMap ?? {},
      chatExpertMap: chatExpertMap ?? {},
      chatUsernames: chatUsernames ?? {},
      lastUpdateId: typeof lastUpdate === 'number' ? lastUpdate : 0,
    };
  }

  /**
   * Persist a new bot token (or clear it). Encrypts before writing — the
   * renderer never holds the plaintext after this returns. When the bridge
   * is currently polling we restart it so the new token actually takes
   * effect on the wire (the existing `api` instance is bound to the old
   * token and would silently keep using it).
   */
  async setToken(plaintext: string | null): Promise<{ ok: boolean; error?: string }> {
    try {
      const value = plaintext ? encryptForStorage(plaintext) : '';
      await backendPutSetting(this.deps.backendPort, TELEGRAM_SETTING_KEYS.token, value);
      const wasRunning = this.polling;
      this.settings.token = plaintext;
      if (wasRunning) {
        await this.stop();
        if (plaintext) {
          await this.start();
          if (!this.polling) {
            return { ok: false, error: this.lastError ?? 'Failed to restart with new token' };
          }
        }
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('setToken failed', msg);
      return { ok: false, error: msg };
    }
  }

  /** True if a token is configured (without revealing the value). */
  hasToken(): boolean {
    return Boolean(this.settings.token);
  }

  /** True if the bridge is actively polling Telegram (token configured,
   *  enabled, and started successfully). Used by the chat-actions catalog. */
  isConnected(): boolean {
    return this.polling && this.api !== null && this.settings.enabled === true;
  }

  private async persistLastUpdateId(id: number): Promise<void> {
    this.settings.lastUpdateId = id;
    await backendPutSetting(this.deps.backendPort, TELEGRAM_SETTING_KEYS.lastUpdateId, id);
  }

  private async persistChatMap(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, TELEGRAM_SETTING_KEYS.chatMap, this.settings.chatMap);
  }

  private async persistChatExpertMap(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, TELEGRAM_SETTING_KEYS.chatExpertMap, this.settings.chatExpertMap);
  }

  private async persistChatUsernames(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, TELEGRAM_SETTING_KEYS.chatUsernames, this.settings.chatUsernames);
  }

  /** Remember the @username of an inbound message so the chat header can show it. */
  private async rememberUsername(chatId: number, username: string | undefined): Promise<void> {
    if (!username) return;
    const key = String(chatId);
    if (this.settings.chatUsernames[key] === username) return;
    this.settings.chatUsernames[key] = username;
    await this.persistChatUsernames();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling && this.api) {
      try {
        const offset = this.settings.lastUpdateId > 0 ? this.settings.lastUpdateId + 1 : 0;
        const updates = await this.api.getUpdates(offset, LONG_POLL_TIMEOUT_SEC, this.pollAbort?.signal);
        this.lastPollAt = Date.now();
        this.backoffMs = BACKOFF_MIN_MS;
        this.lastError = null;

        for (const u of updates) {
          try {
            await this.handleUpdate(u);
          } catch (err) {
            logError('update handler threw', err instanceof Error ? err.message : String(err));
          }
          await this.persistLastUpdateId(u.update_id);
        }
      } catch (err) {
        if (!this.polling) break;
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof TelegramApiError && err.method === 'getUpdates' && /aborted/i.test(msg)) {
          break;
        }
        this.lastError = msg;
        logError('poll error:', msg, `backoff ${this.backoffMs}ms`);
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
      }
    }
    this.polling = false;
  }

  private async handleUpdate(u: TelegramUpdate): Promise<void> {
    if (u.callback_query) {
      await this.handleCallback(u.callback_query);
      return;
    }
    if (u.message) {
      await this.handleMessage(u.message);
    }
  }

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    if (!this.api) return;
    if (msg.chat.type !== 'private') return; // v1: DMs only

    const fromId = msg.from?.id;
    if (fromId === undefined) return;
    const fromIdStr = String(fromId);

    if (!this.settings.allowlist.includes(fromIdStr)) {
      if (this.shouldReplyUnknown(fromIdStr)) {
        try {
          await this.api.sendMessage(
            msg.chat.id,
            `Not authorized. Your Telegram user ID is ${fromIdStr}.\n\nAsk the Cerebro owner to add it to the allowlist.`,
          );
        } catch { /* ignore */ }
      }
      return;
    }

    if (!this.authorizedRateLimiter.allow(fromIdStr)) {
      try {
        await this.api.sendMessage(msg.chat.id, 'Rate limit exceeded. Try again in a minute.');
      } catch { /* ignore */ }
      return;
    }

    // Best-effort: remember the @username for the chat header strip.
    await this.rememberUsername(msg.chat.id, msg.from?.username);

    // Commands
    const textOrCaption = (msg.text ?? msg.caption ?? '').trim();
    if (textOrCaption.startsWith('/')) {
      await this.handleCommand(msg, textOrCaption);
      return;
    }

    const isFirstContact = !this.settings.chatMap[String(msg.chat.id)];

    let conversationId = await this.ensureConversation(msg.chat.id);

    if (isFirstContact) {
      try { await this.api.sendMessage(msg.chat.id, this.welcomeMessage()); } catch { /* ignore */ }
    }

    conversationId = await this.postUserMessageWithRecovery(
      conversationId,
      msg,
      textOrCaption,
    );
    this.emitConversationUpdated(conversationId, 'message');

    // Routine trigger dispatch — if any telegram_message routine matches,
    // it consumes the message and we skip the AI agent reply entirely.
    const matchedRoutines = await this.matchTelegramTriggers(String(msg.chat.id), textOrCaption);
    if (matchedRoutines.length > 0) {
      for (const routine of matchedRoutines) {
        await this.dispatchRoutine(routine, {
          chat_id: String(msg.chat.id),
          sender_id: fromIdStr,
          sender_username: msg.from?.username ?? null,
          message_text: textOrCaption,
          message_id: msg.message_id,
          received_at: new Date(msg.date * 1000).toISOString(),
          conversation_id: conversationId,
        });
      }
      return;
    }

    // Gather attachments (if any) and produce a prompt
    const { prompt, attachmentNote } = await this.buildPromptFromMessage(msg, textOrCaption);

    if (!prompt.trim()) {
      return; // nothing actionable
    }

    if (attachmentNote) {
      try { await this.api.sendMessage(msg.chat.id, attachmentNote); } catch { /* ignore */ }
    }

    // Concurrency: one run per chat
    const existing = this.activeRuns.get(msg.chat.id);
    if (existing) {
      const elapsedSec = Math.round((Date.now() - existing.startedAt) / 1000);
      const elapsedLabel = elapsedSec < 60
        ? `${elapsedSec}s`
        : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
      await this.api.sendMessage(
        msg.chat.id,
        `⏳ Still working on the previous message (${elapsedLabel} so far).\n`
        + `Send /cancel to abort it and try a different request.`,
      );
      return;
    }

    // Spawn the run
    const chatIdForRun = msg.chat.id;
    const bumpActivity = () => {
      const r = this.activeRuns.get(chatIdForRun);
      if (r) r.lastActivityAt = Date.now();
    };
    const sink = new TelegramStreamSink(
      this.api,
      msg.chat.id,
      msg.message_id,
      async (finalText, err) => {
        try {
          if (!err) {
            await backendRequest(this.deps.backendPort, 'POST', `/conversations/${conversationId}/messages`, {
              id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
              role: 'assistant',
              content: finalText,
              metadata: { source: 'telegram', telegram_chat_id: msg.chat.id },
            });
            this.emitConversationUpdated(conversationId, 'message');
          }
        } finally {
          this.activeRuns.delete(msg.chat.id);
        }
      },
      bumpActivity,
    );

    const expertId = this.settings.chatExpertMap[String(msg.chat.id)] || null;

    const runRequest: AgentRunRequest = {
      conversationId,
      content: prompt,
      expertId,
      source: { kind: 'telegram', chatId: msg.chat.id },
    };

    try {
      const runId = await this.deps.agentRuntime.startRun(sink, runRequest);
      const now = Date.now();
      this.activeRuns.set(msg.chat.id, {
        runId,
        conversationId,
        sink,
        userContent: prompt,
        startedAt: now,
        lastActivityAt: now,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError('startRun failed', errMsg);
      try {
        await this.api.sendMessage(msg.chat.id, `⚠️ Failed to start: ${scrubTokenish(errMsg)}`);
      } catch { /* ignore */ }
    }
  }

  private welcomeMessage(): string {
    return (
      '👋 Hi — I am Cerebro.\n\n'
      + 'Just send me a message to start chatting. I can plan, research, run routines, and delegate to your experts.\n\n'
      + 'Commands:\n'
      + '/help — show commands\n'
      + '/expert list — show available experts\n'
      + '/expert <slug> — route this chat to a specific expert\n'
      + '/expert clear — go back to the default\n'
      + '/cancel — abort the message I am currently working on\n'
      + '/reset — start a fresh conversation\n\n'
      + 'You can also send photos, voice notes, and documents.'
    );
  }

  private async postUserMessageWithRecovery(
    conversationId: string,
    msg: TelegramMessage,
    textOrCaption: string,
  ): Promise<string> {
    const body = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
      role: 'user' as const,
      content: textOrCaption || '(attachment)',
      metadata: {
        source: 'telegram',
        telegram_chat_id: msg.chat.id,
        telegram_message_id: msg.message_id,
      },
    };
    const res = await backendRequest(
      this.deps.backendPort,
      'POST',
      `/conversations/${conversationId}/messages`,
      body,
    );
    if (res.status !== 404) return conversationId;

    log(`chatMap entry for chat ${msg.chat.id} → ${conversationId} is stale (404); recreating`);
    delete this.settings.chatMap[String(msg.chat.id)];
    const fresh = await this.createConversation(msg.chat.id);
    await backendRequest(
      this.deps.backendPort,
      'POST',
      `/conversations/${fresh}/messages`,
      { ...body, id: crypto.randomUUID().replace(/-/g, '').slice(0, 32) },
    );
    return fresh;
  }

  private async cleanupActiveRun(chatId: number, message: string): Promise<void> {
    const run = this.activeRuns.get(chatId);
    if (run) {
      try { this.deps.agentRuntime.cancelRun(run.runId); } catch { /* ignore */ }
      this.activeRuns.delete(chatId);
    }
    if (this.api) {
      await this.api.sendMessage(chatId, message).catch(() => { /* ignore */ });
    }
  }

  private startRunWatchdog(): void {
    if (this.runWatchdogTimer) return;
    this.runWatchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [chatId, run] of this.activeRuns) {
        if (now - run.lastActivityAt < RUN_IDLE_TIMEOUT_MS) continue;
        log(`watchdog: reclaiming stuck run ${run.runId} for chat ${chatId}`);
        void this.cleanupActiveRun(
          chatId,
          '⚠️ The previous request stopped responding and was cancelled.\n'
          + 'You can send a new message now.',
        );
      }
    }, RUN_WATCHDOG_INTERVAL_MS);
    if (typeof this.runWatchdogTimer.unref === 'function') {
      this.runWatchdogTimer.unref();
    }
  }

  private async handleCommand(msg: TelegramMessage, text: string): Promise<void> {
    if (!this.api) return;
    const chatId = msg.chat.id;
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();

    if (cmd === '/start') {
      await this.api.sendMessage(chatId, this.welcomeMessage());
      return;
    }

    if (cmd === '/help') {
      await this.api.sendMessage(chatId, this.welcomeMessage());
      return;
    }

    if (cmd === '/reset') {
      delete this.settings.chatMap[String(chatId)];
      await this.persistChatMap();
      await this.api.sendMessage(chatId, '🧹 Fresh conversation. Your next message starts a new thread.');
      return;
    }

    if (cmd === '/cancel' || cmd === '/stop') {
      if (!this.activeRuns.has(chatId)) {
        await this.api.sendMessage(chatId, 'Nothing to cancel — I am not working on anything right now.');
        return;
      }
      await this.cleanupActiveRun(
        chatId,
        '🛑 Cancelled. Send your next message whenever you are ready.',
      );
      return;
    }

    if (cmd === '/expert') {
      const sub = (rest[0] ?? '').toLowerCase();

      if (sub === 'clear') {
        delete this.settings.chatExpertMap[String(chatId)];
        await this.persistChatExpertMap();
        await this.api.sendMessage(chatId, '✅ Expert cleared (using default).');
        return;
      }

      const res = await backendRequest<{ experts: Array<{ id: string; slug: string | null; name: string }> }>(
        this.deps.backendPort, 'GET', '/experts',
      );
      const experts = res.data?.experts ?? [];

      if (sub === '' || sub === 'list') {
        if (experts.length === 0) {
          await this.api.sendMessage(chatId, 'No experts configured.');
          return;
        }
        const lines = experts.map((e) => `• ${e.slug ?? e.id} — ${e.name}`);
        const current = this.settings.chatExpertMap[String(chatId)];
        const active = current ? `\n\nCurrent: ${current}` : '\n\n(using default)';
        await this.api.sendMessage(chatId, `Available experts:\n${lines.join('\n')}${active}`);
        return;
      }

      const match = experts.find(
        (e) => e.slug?.toLowerCase() === sub || e.id.toLowerCase().startsWith(sub),
      );
      if (!match) {
        await this.api.sendMessage(chatId, `No expert matched "${sub}". Try /expert list.`);
        return;
      }
      this.settings.chatExpertMap[String(chatId)] = match.id;
      await this.persistChatExpertMap();
      await this.api.sendMessage(chatId, `✅ Switched expert to ${match.name}.`);
      return;
    }

    await this.api.sendMessage(chatId, `Unknown command: ${cmd}. Try /help.`);
  }

  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    if (!this.api) return;
    const fromId = String(cb.from.id);
    if (!this.settings.allowlist.includes(fromId)) {
      await this.api.answerCallbackQuery(cb.id, 'Not authorized').catch(() => { /* ignore */ });
      return;
    }

    const parsed = parseApprovalCallback(cb.data ?? '');
    if (!parsed) {
      await this.api.answerCallbackQuery(cb.id, 'Unknown action').catch(() => { /* ignore */ });
      return;
    }
    const { action, approvalId } = parsed;
    const approved = action === 'approve';

    // Optional replay-protection: verify the bot is actually tracking this approval.
    const expectedChat = this.approvalChatMap.get(approvalId);
    if (expectedChat !== undefined && cb.message?.chat.id !== expectedChat) {
      await this.api.answerCallbackQuery(cb.id, 'Mismatched chat').catch(() => { /* ignore */ });
      return;
    }

    const res = await backendRequest(this.deps.backendPort, 'PATCH', `/engine/approvals/${approvalId}/resolve`, {
      decision: approved ? 'approved' : 'denied',
      reason: approved ? null : 'Denied via Telegram',
    });

    const note = approved ? '✅ Approved' : '❌ Denied';
    if (cb.message) {
      try {
        await this.api.editMessageText(
          cb.message.chat.id,
          cb.message.message_id,
          `${scrubTokenish(cb.message.text ?? '(approval request)')}\n\n${note}`,
        );
      } catch { /* ignore */ }
    }
    await this.api.answerCallbackQuery(cb.id, res.ok ? note : 'Failed').catch(() => { /* ignore */ });
  }

  private async ensureConversation(chatId: number): Promise<string> {
    const key = String(chatId);
    const cached = this.settings.chatMap[key];
    if (cached) return cached;
    return this.createConversation(chatId);
  }

  private async createConversation(chatId: number): Promise<string> {
    const key = String(chatId);
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    await backendRequest(this.deps.backendPort, 'POST', '/conversations', {
      id,
      title: `Telegram (${chatId})`,
      source: 'telegram',
      external_chat_id: key,
    });
    this.settings.chatMap[key] = id;
    await this.persistChatMap();
    this.emitConversationUpdated(id, 'created');
    return id;
  }

  private emitConversationUpdated(conversationId: string, kind: 'created' | 'message'): void {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    try {
      this.webContents.send(IPC_CHANNELS.TELEGRAM_CONVERSATION_UPDATED, { conversationId, kind });
    } catch { /* ignore */ }
  }

  /**
   * One-shot backfill on bridge start: any conversation in chatMap that doesn't
   * yet have source='telegram' (older row, pre-migration) gets PATCHed.
   * Idempotent and fire-and-forget — failures are logged but don't block startup.
   */
  private async backfillConversationSources(): Promise<void> {
    const entries = Object.entries(this.settings.chatMap);
    if (entries.length === 0) return;
    let pruned = 0;
    for (const [chatId, conversationId] of entries) {
      try {
        const res = await backendRequest(
          this.deps.backendPort,
          'PATCH',
          `/conversations/${conversationId}`,
          { source: 'telegram', external_chat_id: chatId },
        );
        if (res.status === 404) {
          delete this.settings.chatMap[chatId];
          pruned++;
        }
      } catch (err) {
        log('backfill skipped for', conversationId, err instanceof Error ? err.message : String(err));
      }
    }
    if (pruned > 0) {
      log(`pruned ${pruned} stale chatMap entr${pruned === 1 ? 'y' : 'ies'}`);
      await this.persistChatMap();
    }
  }

  /** Delete files in telegram-tmp older than 24h. Best-effort, sync. */
  private sweepOrphanAttachments(): void {
    const dir = this.tempDir();
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - ORPHAN_SWEEP_AGE_MS;
    let removed = 0;
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // file vanished or is not statable — ignore
      }
    }
    if (removed > 0) log(`swept ${removed} orphan attachment(s) from telegram-tmp/`);
  }

  // ── Routine trigger dispatch ─────────────────────────────────────

  /**
   * Fetch (with a short cache) all enabled routines whose trigger_type is
   * 'telegram_message', then run their per-routine match logic. Returns the
   * routines whose chat-id + filter both match the inbound message.
   */
  private async matchTelegramTriggers(
    chatId: string,
    text: string,
  ): Promise<TelegramTriggerRoutine[]> {
    if (!this.deps.executionEngine) return [];
    const now = Date.now();
    if (!this.routineCache || now - this.routineCache.fetchedAt > ROUTINE_CACHE_TTL_MS) {
      const res = await backendRequest<{ routines: BackendRoutineRecord[] }>(
        this.deps.backendPort,
        'GET',
        '/routines?trigger_type=telegram_message',
      );
      const list = (res.data?.routines ?? [])
        .filter((r) => r.is_enabled && r.dag_json)
        .map(parseTelegramTriggerRoutine)
        .filter((r): r is TelegramTriggerRoutine => r !== null);
      this.routineCache = { fetchedAt: now, routines: list };
    }
    return matchRoutineTriggers(this.routineCache.routines, chatId, text);
  }

  /** Spawn a routine run with the trigger payload available as a synthetic
   *  `__trigger__` step output (steps wire it via inputMappings). */
  private async dispatchRoutine(
    routine: TelegramTriggerRoutine,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const engine = this.deps.executionEngine;
    if (!engine) return;
    if (!this.webContents || this.webContents.isDestroyed()) {
      logError(`routine "${routine.name}" not dispatched: main window not available`);
      return;
    }
    try {
      // Bump backend run metadata so the routine's "last run" timestamps update.
      backendRequest(this.deps.backendPort, 'POST', `/routines/${routine.id}/run`).catch(() => {/* ignore */});

      const runId = await engine.startRun(this.webContents, {
        dag: routine.dag,
        routineId: routine.id,
        triggerSource: 'telegram_message',
        triggerPayload: payload,
      });
      log(`dispatched routine "${routine.name}" (${routine.id}) from chat ${payload.chat_id} → run ${runId}`);
    } catch (err) {
      logError('dispatchRoutine failed', err instanceof Error ? err.message : String(err));
    }
  }

  private async buildPromptFromMessage(
    msg: TelegramMessage,
    text: string,
  ): Promise<{ prompt: string; attachmentNote?: string }> {
    if (!this.api) return { prompt: text };

    // Voice → transcribe
    if (msg.voice) {
      const filePath = await this.downloadAttachment(msg.voice.file_id, 'audio/ogg', msg.voice.file_size);
      if (!filePath) return { prompt: text || '(voice note could not be downloaded)' };
      const transcript = await this.transcribeAudio(filePath);
      if (transcript) {
        return {
          prompt: transcript + (text ? `\n\n${text}` : ''),
          attachmentNote: `🎙️ Heard: ${transcript.length > 200 ? transcript.slice(0, 200) + '…' : transcript}`,
        };
      }
      return {
        prompt: `[voice note: ${filePath}]${text ? `\n\n${text}` : ''}`,
        attachmentNote: '🎙️ Could not transcribe automatically — passing the audio file to the agent.',
      };
    }

    // Photo → pick largest variant, download, inline path
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const filePath = await this.downloadAttachment(largest.file_id, 'image/jpeg', largest.file_size);
      if (filePath) {
        return { prompt: `[image attached at ${filePath}]${text ? `\n\n${text}` : ''}` };
      }
    }

    // Document
    if (msg.document) {
      const mime = msg.document.mime_type ?? 'application/octet-stream';
      const filePath = await this.downloadAttachment(msg.document.file_id, mime, msg.document.file_size);
      if (filePath) {
        return { prompt: `[document attached at ${filePath}]${text ? `\n\n${text}` : ''}` };
      }
    }

    // Audio (non-voice)
    if (msg.audio) {
      const mime = msg.audio.mime_type ?? 'audio/mpeg';
      const filePath = await this.downloadAttachment(msg.audio.file_id, mime, msg.audio.file_size);
      if (filePath) {
        const transcript = await this.transcribeAudio(filePath);
        if (transcript) {
          return {
            prompt: transcript + (text ? `\n\n${text}` : ''),
            attachmentNote: `🎙️ Heard: ${transcript.length > 200 ? transcript.slice(0, 200) + '…' : transcript}`,
          };
        }
        return { prompt: `[audio attached at ${filePath}]${text ? `\n\n${text}` : ''}` };
      }
    }

    return { prompt: text };
  }

  private async downloadAttachment(
    fileId: string,
    declaredMime: string,
    declaredSize: number | undefined,
  ): Promise<string | null> {
    if (!this.api) return null;
    if (!ALLOWED_MIME.has(declaredMime)) {
      log(`attachment rejected: mime ${declaredMime} not allowed`);
      return null;
    }
    if (declaredSize !== undefined && declaredSize > ATTACHMENT_MAX_BYTES) {
      log(`attachment rejected: size ${declaredSize} > ${ATTACHMENT_MAX_BYTES}`);
      return null;
    }

    let info;
    try {
      info = await this.api.getFile(fileId);
    } catch (err) {
      logError('getFile failed', err instanceof Error ? err.message : String(err));
      return null;
    }
    if (!info.file_path) return null;
    if (info.file_size !== undefined && info.file_size > ATTACHMENT_MAX_BYTES) return null;

    const ext = MIME_TO_EXT[declaredMime] ?? 'bin';
    const dest = path.join(this.tempDir(), `${crypto.randomUUID()}.${ext}`);
    try {
      await this.api.downloadFile(info.file_path, dest);
    } catch (err) {
      logError('downloadFile failed', err instanceof Error ? err.message : String(err));
      return null;
    }

    // TTL cleanup
    const timer = setTimeout(() => {
      fs.rm(dest, { force: true }, () => { /* ignore */ });
      this.tempFiles.delete(dest);
    }, ATTACHMENT_TTL_MS);
    this.tempFiles.set(dest, timer);

    return dest;
  }

  private async transcribeAudio(filePath: string): Promise<string | null> {
    // Ensure the STT model is loaded. /voice/stt/transcribe-file lazy-loads too
    // but the explicit load keeps errors on our side surface-able.
    const status = await backendRequest<{ stt: string }>(this.deps.backendPort, 'GET', '/voice/status');
    if (status.data?.stt !== 'ready') {
      await backendRequest(this.deps.backendPort, 'POST', '/voice/stt/load');
    }

    const res = await backendRequest<{ text: string }>(
      this.deps.backendPort,
      'POST',
      '/voice/stt/transcribe-file',
      { file_path: filePath },
    );
    if (!res.ok || !res.data) {
      logError('transcribe-file failed', res.status);
      return null;
    }
    const text = (res.data.text ?? '').trim();
    return text || null;
  }

  private redactForChat(text: string): string {
    return redactForChat(text, this.deps.dataDir);
  }

  private shouldReplyUnknown(fromId: string): boolean {
    // Bound map growth: if we've tracked too many strangers, evict the oldest.
    const UNKNOWN_MAP_MAX = 10_000;
    if (this.unknownUserLastReply.size > UNKNOWN_MAP_MAX) {
      const oldest = this.unknownUserLastReply.keys().next().value;
      if (oldest !== undefined) this.unknownUserLastReply.delete(oldest);
    }

    const last = this.unknownUserLastReply.get(fromId) ?? 0;
    if (Date.now() - last < UNKNOWN_USER_RATE_LIMIT_MS) return false;
    this.unknownUserLastReply.set(fromId, Date.now());
    return true;
  }

  private tempDir(): string {
    return path.join(this.deps.dataDir, 'telegram-tmp');
  }
}

// ── Module helpers ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptySettings(): TelegramSettings {
  return {
    token: null,
    allowlist: [],
    enabled: false,
    forwardAllApprovals: false,
    chatMap: {},
    chatExpertMap: {},
    chatUsernames: {},
    lastUpdateId: 0,
  };
}

