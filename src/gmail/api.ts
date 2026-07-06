/**
 * Thin Gmail REST API v1 client (users/me), fetch-based like the calendar
 * provider adapters. All functions take the access token — token refresh and
 * retry live in the bridge, not here.
 *
 * Also contains the raw-payload → secret-free DTO normalizers shared by sync
 * and the on-demand thread fetch.
 */

import { providerFetch, ProviderHttpError } from '../shared/oauth';
import type { GmailAttachmentInfo, GmailMessageFull, GmailMessageSummary } from './types';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ── Raw API shapes (subset we read) ──────────────────────────────────────────

export interface RawMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: RawMessagePart[];
}

export interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: RawMessagePart;
  historyId?: string;
}

export interface RawThread {
  id: string;
  historyId?: string;
  messages?: RawMessage[];
}

export interface HistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string }; labelIds: string[] }>;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesUnread?: number;
}

// ── Endpoints ────────────────────────────────────────────────────────────────

export async function getProfile(
  accessToken: string,
): Promise<{ emailAddress: string; historyId: string; messagesTotal?: number }> {
  return providerFetch(`${BASE}/profile`, accessToken, { label: 'Gmail profile' });
}

export async function listMessages(
  accessToken: string,
  opts: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string },
): Promise<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }> {
  const p = new URLSearchParams();
  if (opts.q) p.set('q', opts.q);
  for (const l of opts.labelIds ?? []) p.append('labelIds', l);
  p.set('maxResults', String(opts.maxResults ?? 50));
  if (opts.pageToken) p.set('pageToken', opts.pageToken);
  return providerFetch(`${BASE}/messages?${p}`, accessToken, { label: 'Gmail list' });
}

export async function getMessage(
  accessToken: string,
  id: string,
  format: 'full' | 'metadata' | 'minimal' = 'full',
): Promise<RawMessage> {
  const p = new URLSearchParams({ format });
  if (format === 'metadata') {
    for (const h of ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'Date']) {
      p.append('metadataHeaders', h);
    }
  }
  return providerFetch(`${BASE}/messages/${id}?${p}`, accessToken, { label: 'Gmail message' });
}

export async function getThread(accessToken: string, id: string): Promise<RawThread> {
  return providerFetch(`${BASE}/threads/${id}?format=full`, accessToken, {
    label: 'Gmail thread',
  });
}

export async function sendMessage(
  accessToken: string,
  raw: string,
  threadId?: string,
): Promise<{ id: string; threadId: string }> {
  return providerFetch(`${BASE}/messages/send`, accessToken, {
    method: 'POST',
    body: threadId ? { raw, threadId } : { raw },
    label: 'Gmail send',
  });
}

export async function createDraft(
  accessToken: string,
  raw: string,
  threadId?: string,
): Promise<{ id: string; message: { id: string; threadId: string } }> {
  return providerFetch(`${BASE}/drafts`, accessToken, {
    method: 'POST',
    body: { message: threadId ? { raw, threadId } : { raw } },
    label: 'Gmail draft',
  });
}

export async function modifyMessage(
  accessToken: string,
  id: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<RawMessage> {
  return providerFetch(`${BASE}/messages/${id}/modify`, accessToken, {
    method: 'POST',
    body: { addLabelIds, removeLabelIds },
    label: 'Gmail modify',
  });
}

export async function modifyThread(
  accessToken: string,
  id: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<RawThread> {
  return providerFetch(`${BASE}/threads/${id}/modify`, accessToken, {
    method: 'POST',
    body: { addLabelIds, removeLabelIds },
    label: 'Gmail thread modify',
  });
}

export async function listLabels(accessToken: string): Promise<{ labels?: GmailLabel[] }> {
  return providerFetch(`${BASE}/labels`, accessToken, { label: 'Gmail labels' });
}

export async function createLabel(accessToken: string, name: string): Promise<GmailLabel> {
  return providerFetch(`${BASE}/labels`, accessToken, {
    method: 'POST',
    body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    label: 'Gmail create label',
  });
}

/**
 * Incremental changes since `startHistoryId`. Gmail returns 404 when the
 * cursor is too old (~1 week retention) — surfaced as `expired: true` so the
 * bridge falls back to a windowed re-sync.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<{
  history?: HistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
  expired?: boolean;
}> {
  const p = new URLSearchParams({ startHistoryId, maxResults: '500' });
  if (pageToken) p.set('pageToken', pageToken);
  try {
    return await providerFetch(`${BASE}/history?${p}`, accessToken, { label: 'Gmail history' });
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 404) return { expired: true };
    throw err;
  }
}

export async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<{ size: number; data: string }> {
  return providerFetch(`${BASE}/messages/${messageId}/attachments/${attachmentId}`, accessToken, {
    label: 'Gmail attachment',
  });
}

// ── Normalizers ──────────────────────────────────────────────────────────────

export function headerValue(msg: RawMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decodeBody(data: string | undefined): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function walkParts(part: RawMessagePart | undefined, out: RawMessagePart[]): void {
  if (!part) return;
  out.push(part);
  for (const p of part.parts ?? []) walkParts(p, out);
}

/** Extract text + html bodies and attachment metadata from a full-format payload. */
export function extractBodies(msg: RawMessage): {
  text: string;
  html: string | null;
  attachments: GmailAttachmentInfo[];
} {
  const parts: RawMessagePart[] = [];
  walkParts(msg.payload, parts);
  let text = '';
  let html: string | null = null;
  const attachments: GmailAttachmentInfo[] = [];
  for (const p of parts) {
    if (p.filename && p.body?.attachmentId) {
      attachments.push({
        attachmentId: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        sizeBytes: p.body.size ?? 0,
      });
    } else if (p.mimeType === 'text/plain' && !text) {
      text = decodeBody(p.body?.data);
    } else if (p.mimeType === 'text/html' && html === null) {
      html = decodeBody(p.body?.data);
    }
  }
  // HTML-only messages: keep text empty here; callers may strip tags for search.
  return { text, html, attachments };
}

export function toSummary(msg: RawMessage): GmailMessageSummary {
  const labelIds = msg.labelIds ?? [];
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headerValue(msg, 'From'),
    to: headerValue(msg, 'To'),
    subject: headerValue(msg, 'Subject'),
    snippet: msg.snippet ?? '',
    receivedAt: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date(0).toISOString(),
    labelIds,
    unread: labelIds.includes('UNREAD'),
    hasAttachments: false,
  };
}

export function toFull(msg: RawMessage): GmailMessageFull {
  const { text, html, attachments } = extractBodies(msg);
  return {
    ...toSummary(msg),
    cc: headerValue(msg, 'Cc'),
    bodyText: text,
    bodyHtml: html,
    attachments,
    hasAttachments: attachments.length > 0,
  };
}
