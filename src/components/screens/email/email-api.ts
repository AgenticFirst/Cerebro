/**
 * Renderer-side data access for the Email screen. Thread/message reads go
 * straight to the backend's local mail store (fast, offline-friendly) via the
 * generic backend invoke; account status, live search, and all writes go
 * through window.cerebro.gmail (main process owns tokens + the Gmail API).
 */

import { headerAddress } from '../../../gmail/helpers';
import type { AiLabel } from '../../../gmail/ai';

// AI-label tabs derive from the taxonomy in gmail/ai.ts so a category change
// can't silently drift; the rest are Gmail system views.
export type EmailTab = 'inbox' | AiLabel | 'snoozed' | 'sent' | 'all';

export interface EmailThread {
  id: string;
  thread_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: string | null;
  message_count: number;
  unread_count: number;
  has_attachments: boolean;
  label_ids: string[];
  ai_summary: string | null;
  ai_label: string | null;
  snoozed_until: string | null;
  awaiting_reply: boolean;
}

export interface EmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface EmailMessage {
  id: string;
  message_id: string;
  thread_id: string;
  from_addr: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  label_ids: string[];
  internal_date: string | null;
  is_unread: boolean;
  is_outbound: boolean;
  has_attachments: boolean;
  attachments: EmailAttachment[];
}

export async function fetchThreads(
  tab: EmailTab,
  limit = 50,
  offset = 0,
): Promise<{ threads: EmailThread[]; total: number }> {
  const res = await window.cerebro.invoke<{ threads: EmailThread[]; total: number }>({
    method: 'GET',
    path: `/gmail/threads?tab=${tab}&limit=${limit}&offset=${offset}`,
  });
  if (!res.ok || !res.data) return { threads: [], total: 0 };
  return res.data;
}

export async function fetchThreadMessages(threadId: string): Promise<EmailMessage[]> {
  const res = await window.cerebro.invoke<{ messages: EmailMessage[] }>({
    method: 'GET',
    path: `/gmail/threads/${encodeURIComponent(threadId)}/messages`,
  });
  return res.ok && res.data ? res.data.messages : [];
}

export async function snoozeThread(rowId: string, untilISO: string | null): Promise<void> {
  await window.cerebro.invoke({
    method: 'PATCH',
    path: `/gmail/threads/${encodeURIComponent(rowId)}`,
    body: untilISO ? { snoozed_until: untilISO } : { clear_snooze: true },
  });
}

/** "Display Name <a@b.c>" → "Display Name" (or the bare address). */
export function senderName(fromHeader: string | null): string {
  if (!fromHeader) return '';
  const m = fromHeader.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m) return m[1].trim();
  return fromHeader.replace(/[<>]/g, '').trim();
}

export function senderAddress(fromHeader: string | null): string {
  return fromHeader ? headerAddress(fromHeader) : '';
}

export function formatWhen(iso: string | null, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
