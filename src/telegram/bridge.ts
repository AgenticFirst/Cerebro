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
import type { AgentRuntime, AgentEventSink, AgentRunRequest, RendererAgentEvent } from '../agents';
import type { ExecutionEvent } from '../engine/events/types';
import { ENGINE_EVENT, type EngineEventContext } from '../engine/events/emitter';
import { TelegramApi, TelegramApiError, approvalKeyboard, scrubTokenish } from './api';
import { chunkText, SlidingWindowLimiter, redactForChat, parseApprovalCallback } from './helpers';
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
  private api: TelegramApi;
  private chatId: number;
  private replyToMessageId?: number;
  public runId: string | null = null;

  constructor(
    api: TelegramApi,
    chatId: number,
    replyToMessageId: number | undefined,
    onDone: (finalText: string, err?: string) => void,
  ) {
    this.api = api;
    this.chatId = chatId;
    this.replyToMessageId = replyToMessageId;
    this.onDoneCb = onDone;
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
}

// ── TelegramBridge ────────────────────────────────────────────────

export interface TelegramBridgeDeps {
  backendPort: number;
  agentRuntime: AgentRuntime;
  dataDir: string;
  engineEventBus: EventEmitter;
}

export class TelegramBridge {
  private deps: TelegramBridgeDeps;
  private api: TelegramApi | null = null;
  private settings: TelegramSettings = emptySettings();
  private polling = false;
  private pollAbort: AbortController | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;

  private unknownUserLastReply = new Map<string, number>();
  private authorizedRateLimiter = new SlidingWindowLimiter(AUTHORIZED_RATE_LIMIT_PER_MIN, 60_000);
  private proactiveRateLimiter = new SlidingWindowLimiter(PROACTIVE_RATE_LIMIT_PER_HOUR, 60 * 60 * 1_000);

  private activeRuns = new Map<number, ActiveTelegramRun>(); // chatId → run
  private approvalChatMap = new Map<string, number>(); // approvalId → chatId
  private tempFiles = new Map<string, NodeJS.Timeout>();

  private engineListener: ((event: ExecutionEvent, ctx: EngineEventContext) => void) | null = null;

  constructor(deps: TelegramBridgeDeps) {
    this.deps = deps;
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

    if (!this.settings.enabled || !this.settings.token || this.settings.allowlist.length === 0) {
      log('bridge not started: disabled / missing token / empty allowlist');
      return;
    }

    // Only create the temp dir when we actually need it.
    fs.mkdirSync(this.tempDir(), { recursive: true });

    this.api = new TelegramApi(this.settings.token);

    try {
      const me = await this.api.getMe();
      log(`bridge started as @${me.username} (id=${me.id})`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      logError('bridge failed to start: getMe error —', this.lastError);
      this.api = null;
      return;
    }

    this.polling = true;
    this.pollAbort = new AbortController();
    this.subscribeToEngineEvents();
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
    this.api?.abortPending();
    this.api = null;

    if (this.engineListener) {
      this.deps.engineEventBus.off(ENGINE_EVENT, this.engineListener);
      this.engineListener = null;
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
    };
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
    const [token, allowlist, enabled, forwardAll, chatMap, chatExpertMap, lastUpdate] = await Promise.all([
      backendGetSetting<string>(port, TELEGRAM_SETTING_KEYS.token),
      backendGetSetting<string[]>(port, TELEGRAM_SETTING_KEYS.allowlist),
      backendGetSetting<boolean>(port, TELEGRAM_SETTING_KEYS.enabled),
      backendGetSetting<boolean>(port, TELEGRAM_SETTING_KEYS.forwardAllApprovals),
      backendGetSetting<Record<string, string>>(port, TELEGRAM_SETTING_KEYS.chatMap),
      backendGetSetting<Record<string, string>>(port, TELEGRAM_SETTING_KEYS.chatExpertMap),
      backendGetSetting<number>(port, TELEGRAM_SETTING_KEYS.lastUpdateId),
    ]);

    this.settings = {
      token: token ?? null,
      allowlist: Array.isArray(allowlist) ? allowlist : [],
      enabled: enabled ?? false,
      forwardAllApprovals: forwardAll ?? false,
      chatMap: chatMap ?? {},
      chatExpertMap: chatExpertMap ?? {},
      lastUpdateId: typeof lastUpdate === 'number' ? lastUpdate : 0,
    };
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

    // Commands
    const textOrCaption = (msg.text ?? msg.caption ?? '').trim();
    if (textOrCaption.startsWith('/')) {
      await this.handleCommand(msg, textOrCaption);
      return;
    }

    // Ensure conversation exists
    const conversationId = await this.ensureConversation(msg.chat.id);

    // Gather attachments (if any) and produce a prompt
    const { prompt, attachmentNote } = await this.buildPromptFromMessage(msg, textOrCaption);

    if (!prompt.trim()) {
      return; // nothing actionable
    }

    if (attachmentNote) {
      try { await this.api.sendMessage(msg.chat.id, attachmentNote); } catch { /* ignore */ }
    }

    // Concurrency: one run per chat
    if (this.activeRuns.has(msg.chat.id)) {
      await this.api.sendMessage(msg.chat.id, '⏳ Still working on the previous message — try again when it finishes.');
      return;
    }

    // Persist user message
    await backendRequest(this.deps.backendPort, 'POST', `/conversations/${conversationId}/messages`, {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
      role: 'user',
      content: textOrCaption || '(attachment)',
      metadata: { source: 'telegram', telegram_chat_id: msg.chat.id, telegram_message_id: msg.message_id },
    });

    // Spawn the run
    const sink = new TelegramStreamSink(this.api, msg.chat.id, msg.message_id, async (finalText, err) => {
      try {
        if (!err) {
          await backendRequest(this.deps.backendPort, 'POST', `/conversations/${conversationId}/messages`, {
            id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
            role: 'assistant',
            content: finalText,
            metadata: { source: 'telegram', telegram_chat_id: msg.chat.id },
          });
        }
      } finally {
        this.activeRuns.delete(msg.chat.id);
      }
    });

    const expertId = this.settings.chatExpertMap[String(msg.chat.id)] || null;

    const runRequest: AgentRunRequest = {
      conversationId,
      content: prompt,
      expertId,
      source: { kind: 'telegram', chatId: msg.chat.id },
    };

    try {
      const runId = await this.deps.agentRuntime.startRun(sink, runRequest);
      this.activeRuns.set(msg.chat.id, {
        runId,
        conversationId,
        sink,
        userContent: prompt,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logError('startRun failed', errMsg);
      try {
        await this.api.sendMessage(msg.chat.id, `⚠️ Failed to start: ${scrubTokenish(errMsg)}`);
      } catch { /* ignore */ }
    }
  }

  private async handleCommand(msg: TelegramMessage, text: string): Promise<void> {
    if (!this.api) return;
    const chatId = msg.chat.id;
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();

    if (cmd === '/start') {
      await this.api.sendMessage(
        chatId,
        'Hi — I am Cerebro.\n\n'
          + 'Commands:\n'
          + '/help — show this list\n'
          + '/expert list — show available experts\n'
          + '/expert <slug> — switch expert for this chat\n'
          + '/expert clear — reset to default\n'
          + '/reset — start a fresh conversation\n\n'
          + 'Send text, photos, voice notes, or documents.',
      );
      return;
    }

    if (cmd === '/help') {
      await this.api.sendMessage(
        chatId,
        'Commands:\n'
          + '/expert list | /expert <slug> | /expert clear\n'
          + '/reset — start a fresh conversation',
      );
      return;
    }

    if (cmd === '/reset') {
      delete this.settings.chatMap[String(chatId)];
      await this.persistChatMap();
      await this.api.sendMessage(chatId, '🧹 Fresh conversation. Your next message starts a new thread.');
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
    const existing = this.settings.chatMap[key];
    if (existing) return existing;
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    await backendRequest(this.deps.backendPort, 'POST', '/conversations', {
      id,
      title: `Telegram (${chatId})`,
    });
    this.settings.chatMap[key] = id;
    await this.persistChatMap();
    return id;
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
    lastUpdateId: 0,
  };
}

