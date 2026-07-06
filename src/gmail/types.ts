/**
 * Shared types for the Gmail integration (bring-your-own Google OAuth client,
 * single account in v1 but persistence is keyed by accountId like calendar so
 * multi-account is an index change, not a rework).
 */

/** Multi-account index (mirrors calendar_accounts_index). */
export const GMAIL_INDEX_KEY = 'gmail_accounts_index';

/** Per-account settings are `gmail_<accountId>_<field>` — same scheme as calendar. */
export function gmailSettingKey(accountId: string, field: string): string {
  return `gmail_${accountId}_${field}`;
}

/** Fields persisted per account (client secret + tokens encrypted at rest). */
export const GMAIL_ACCOUNT_FIELDS = [
  'email',
  'display_name',
  'client_id',
  'client_secret',
  'access_token',
  'refresh_token',
  'token_expiry',
  'status',
  'history_id',
  'last_full_sync_at',
] as const;

export type GmailAccountStatus = 'connected' | 'token_expired' | 'error';

export interface GmailAccountInfo {
  id: string;
  email: string;
  displayName: string | null;
  status: GmailAccountStatus;
  lastError: string | null;
  lastSyncedAt: string | null;
}

export interface GmailStatus {
  connected: boolean;
  accounts: GmailAccountInfo[];
  /** Messages sent through Cerebro since local midnight (mailbox caps are the
   *  real limiter for outreach — ~500/day consumer, ~2000/day Workspace). */
  sentToday: number;
  tokenBackend: 'os-keychain' | 'plaintext-fallback';
}

// ── Message shapes exposed to the renderer / engine (secret-free) ───────────

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  /** ISO 8601 receive time (Gmail internalDate). */
  receivedAt: string;
  labelIds: string[];
  unread: boolean;
  hasAttachments: boolean;
}

export interface GmailAttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GmailMessageFull extends GmailMessageSummary {
  cc: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: GmailAttachmentInfo[];
}

export interface GmailThreadDTO {
  threadId: string;
  subject: string;
  messages: GmailMessageFull[];
}

export interface GmailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body; an HTML alternative may be provided alongside. */
  text: string;
  html?: string;
  /** Reply threading — the bridge resolves References/In-Reply-To from the thread. */
  replyToThreadId?: string;
  attachments?: Array<{ filename: string; mimeType: string; contentBase64: string }>;
}

export interface GmailSendResult {
  ok: boolean;
  messageId?: string;
  threadId?: string;
  error?: string;
}
