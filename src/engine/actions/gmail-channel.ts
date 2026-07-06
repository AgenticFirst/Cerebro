/**
 * Minimal interface the Gmail engine actions depend on, implemented by
 * GmailBridge (main process). Mirrors calendar-channel.ts — keeps the actions
 * decoupled from the bridge's internals and easy to stub in tests.
 */

import type {
  GmailMessageSummary,
  GmailSendInput,
  GmailSendResult,
  GmailThreadDTO,
} from '../../gmail/types';

export interface GmailChannel {
  isConnected(): boolean;
  /** Connected address, used in action summaries ("send as …"). */
  getAccountEmail(): string | null;
  /** Local-first search; accepts free text or Gmail `q` operator syntax. */
  search(query: string, maxResults?: number): Promise<GmailMessageSummary[]>;
  getThread(threadId: string): Promise<GmailThreadDTO>;
  listLabels(): Promise<Array<{ id: string; name: string; type?: string }>>;
  sendMessage(input: GmailSendInput): Promise<GmailSendResult>;
  createDraft(input: GmailSendInput): Promise<{ ok: boolean; draftId?: string; error?: string }>;
  modifyLabels(
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  /** Render a stored template ({{var}} tokens) — fails listing missing vars. */
  resolveTemplate(
    templateId: string,
    variables: Record<string, string>,
  ): Promise<{ ok: boolean; subject?: string; text?: string; error?: string; missing?: string[] }>;
  /** Queue an email for a future send (send-later). */
  scheduleSend(
    input: GmailSendInput & { sendAtISO: string },
  ): Promise<{ ok: boolean; scheduledId?: string; error?: string }>;
  /** Outbound threads with no reply after N days. */
  listAwaitingReply(olderThanDays: number): Promise<
    Array<{
      thread_id: string;
      subject: string | null;
      last_outbound_at: string | null;
      snippet: string | null;
    }>
  >;
}
