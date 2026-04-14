/**
 * Thin typed wrapper around the Telegram Bot API.
 *
 * Uses Node's built-in `fetch`. The token appears only in constructed URLs —
 * `sanitizeUrl()` redacts it before any log line so we never leak it.
 */

import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type {
  TelegramApiEnvelope,
  TelegramUpdate,
  TelegramUser,
  TelegramFile,
  TelegramSentMessage,
  SendMessageOptions,
  InlineKeyboardMarkup,
} from './types';

const BASE = 'https://api.telegram.org';

export class TelegramApiError extends Error {
  readonly code: number | null;
  readonly method: string;

  constructor(method: string, code: number | null, description: string) {
    // Defence-in-depth: description comes from Telegram and should never contain
    // the token, but strip anything that looks like one just in case.
    super(scrubTokenish(description));
    this.name = 'TelegramApiError';
    this.code = code;
    this.method = method;
  }
}

/** Remove anything resembling a bot token from a string. */
export function scrubTokenish(s: string): string {
  return s.replace(/\d{6,12}:[A-Za-z0-9_-]{20,}/g, '***');
}

/**
 * Replace `/bot<token>/` with `/bot[redacted]/` in URLs, for safe logging.
 */
export function sanitizeUrl(url: string): string {
  return url.replace(/\/bot[^/]+\//, '/bot[redacted]/');
}

export class TelegramApi {
  private token: string;
  private abortController: AbortController | null = null;

  constructor(token: string) {
    this.token = token;
  }

  /** Swap out the token (used on hot-update from settings). */
  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string {
    return this.token;
  }

  /** Cancel any in-flight long-poll (called on stop()). */
  abortPending(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async getMe(): Promise<TelegramUser> {
    return this.call('getMe', {});
  }

  async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    this.abortController = new AbortController();
    const combined = combineSignals(signal, this.abortController.signal);
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ['message', 'callback_query'],
      },
      combined,
    );
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<TelegramSentMessage> {
    return this.call('sendMessage', { chat_id: chatId, text, ...opts });
  }

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    opts: SendMessageOptions = {},
  ): Promise<TelegramSentMessage | boolean> {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...opts,
    });
  }

  async sendChatAction(chatId: number | string, action: 'typing' | 'upload_photo'): Promise<boolean> {
    return this.call('sendChatAction', { chat_id: chatId, action });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<boolean> {
    return this.call('answerCallbackQuery', { callback_query_id: id, text });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call('getFile', { file_id: fileId });
  }

  /** Download a file identified by `file_path` (returned from getFile) to `destPath`. */
  async downloadFile(filePath: string, destPath: string): Promise<void> {
    const url = `${BASE}/file/bot${this.token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new TelegramApiError('downloadFile', res.status, `download failed (${res.status})`);
    }
    // Node 20's fetch returns a Web ReadableStream — convert to Node Readable for pipeline.
    const nodeStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
    await pipeline(nodeStream, createWriteStream(destPath));
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = `${BASE}/bot${this.token}/${method}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TelegramApiError(method, null, scrubTokenish(msg));
    }

    let json: TelegramApiEnvelope<T>;
    try {
      json = (await res.json()) as TelegramApiEnvelope<T>;
    } catch {
      throw new TelegramApiError(method, res.status, `non-JSON response (${res.status})`);
    }

    if (!json.ok || json.result === undefined) {
      throw new TelegramApiError(method, json.error_code ?? res.status, json.description ?? 'unknown error');
    }
    return json.result;
  }
}

// ── Utilities ──────────────────────────────────────────────────────

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}

/** Escape MarkdownV2 special characters so arbitrary text stays literal. */
export function escapeMarkdownV2(s: string): string {
  // Ref: https://core.telegram.org/bots/api#markdownv2-style
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/** Build an Approve/Deny inline keyboard for an approval id. */
export function approvalKeyboard(approvalId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: 'Approve ✓', callback_data: `approve:${approvalId}` },
      { text: 'Deny ✗', callback_data: `deny:${approvalId}` },
    ]],
  };
}
