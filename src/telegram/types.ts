/**
 * Telegram Bot API types — just the slice we need.
 *
 * Ref: https://core.telegram.org/bots/api
 */

// ── Incoming update payloads ───────────────────────────────────────

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  chat_instance: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// ── Response envelope ──────────────────────────────────────────────

export interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramSentMessage {
  message_id: number;
  chat: TelegramChat;
  date: number;
  text?: string;
}

// ── Settings shape (stored via /settings/{key}) ────────────────────

export interface TelegramSettings {
  token: string | null;
  allowlist: string[]; // numeric user IDs as strings
  enabled: boolean;
  forwardAllApprovals: boolean;
  chatMap: Record<string, string>; // chatId → conversationId
  chatExpertMap: Record<string, string>; // chatId → expertId
  chatUsernames: Record<string, string>; // chatId → @username (best effort, refreshed on each inbound message)
  lastUpdateId: number;
}

export const TELEGRAM_SETTING_KEYS = {
  token: 'telegram_bot_token',
  allowlist: 'telegram_allowlist',
  enabled: 'telegram_enabled',
  forwardAllApprovals: 'telegram_forward_all_approvals',
  chatMap: 'telegram_chat_map',
  chatExpertMap: 'telegram_chat_expert_map',
  chatUsernames: 'telegram_chat_username_map',
  lastUpdateId: 'telegram_last_update_id',
} as const;

// ── IPC surface (re-exports of the canonical types in types/ipc.ts) ──

export type { TelegramVerifyResponse as TelegramVerifyResult } from '../types/ipc';
export type { TelegramStatusResponse as TelegramStatus } from '../types/ipc';

// ── Inline keyboard / outgoing message options ─────────────────────

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  reply_markup?: InlineKeyboardMarkup;
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}
