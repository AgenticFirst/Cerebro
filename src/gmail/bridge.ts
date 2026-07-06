/**
 * GmailBridge — main-process owner of the Gmail OAuth account, encrypted
 * tokens, and all Gmail API traffic (send, drafts, labels, search, and — from
 * Phase B — the local-store sync loop).
 *
 * Why main (not the Python backend): safeStorage (secure-token.ts) only works
 * in main, and OAuth client secrets / tokens must never reach the renderer or
 * the backend process. The bridge writes only normalized, secret-free rows to
 * the backend store.
 *
 * Shape mirrors CalendarBridge (OAuth account lifecycle, refresh-on-expiry,
 * interval sync) — single account in v1, but persistence is keyed by accountId
 * (`gmail_<id>_<field>` + `gmail_accounts_index`) so multi-account is additive.
 */

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import {
  encryptForStorage,
  decryptFromStorage,
  backend as secureTokenBackend,
} from '../secure-token';
import {
  backendGetSetting,
  backendPutSetting,
  backendJsonRequest,
} from '../shared/backend-settings';
import { IPC_CHANNELS } from '../types/ipc';
import { runOAuthFlow, TokenExpiredError, type TokenSet } from '../shared/oauth';
import { GmailOAuthProvider } from './provider';
import * as api from './api';
import { buildRawMessage } from './mime';
import { syncGmailAccount } from './sync';
import { renderEmailTemplate } from './templates';
import {
  classifyThreads,
  draftEmail,
  summarizeThread,
  type AiLabel,
  type MessageForAi,
  type ThreadToClassify,
} from './ai';
import type { GmailChannel } from '../engine/actions/gmail-channel';
import type { ExecutionEngine } from '../engine/engine';
import {
  buildGmailTriggerPayload,
  matchesGmailTrigger,
  parseGmailTriggerRoutine,
  splitAddresses,
  type BackendRoutineRecord,
  type GmailTriggerRoutine,
} from './helpers';
import {
  GMAIL_INDEX_KEY,
  GMAIL_ACCOUNT_FIELDS,
  gmailSettingKey,
  type GmailAccountInfo,
  type GmailAccountStatus,
  type GmailMessageSummary,
  type GmailSendInput,
  type GmailSendResult,
  type GmailStatus,
  type GmailThreadDTO,
} from './types';

const TOKEN_REFRESH_SKEW_MS = 60_000;
const FOREGROUND_INTERVAL_MS = 60_000;
const BACKGROUND_INTERVAL_MS = 5 * 60_000;

/** Display names for the Cerebro/<Category> Gmail mirror labels. Typed against
 *  AiLabel so adding a category to ai.ts forces an entry here. */
const MIRROR_LABEL_NAMES: Record<AiLabel, string> = {
  important: 'Important',
  awaiting_reply: 'Awaiting reply',
  team: 'Team',
  marketing: 'Marketing',
  notifications: 'Notifications',
};

interface Account {
  id: string;
  email: string;
  displayName: string | null;
  clientId: string;
  clientSecret: string;
  tokens: TokenSet;
  status: GmailAccountStatus;
  lastError: string | null;
  lastSyncedAt: string | null;
  historyId: string | null;
}

export interface GmailBridgeDeps {
  backendPort: number;
  /** For dispatching gmail_message-triggered routines. */
  executionEngine?: ExecutionEngine;
}

const ROUTINE_CACHE_TTL_MS = 30_000;

export class GmailBridge implements GmailChannel {
  private accounts = new Map<string, Account>();
  private webContents: WebContents | null = null;
  private provider = new GmailOAuthProvider();
  private sentToday = { date: todayKey(), count: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = FOREGROUND_INTERVAL_MS;
  private syncing = false;

  constructor(protected deps: GmailBridgeDeps) {}

  setWebContents(wc: WebContents | null): void {
    this.webContents = wc;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, GMAIL_INDEX_KEY)) ?? [];
    for (const id of index) {
      try {
        const acc = await this.loadAccount(id);
        if (acc) this.accounts.set(id, acc);
      } catch (err) {
        console.error(`[Gmail] failed to load account ${id}:`, err);
      }
    }
  }

  /** Begin the background sync loop and run one immediate tick. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.syncAll(), this.intervalMs);
    void this.syncAll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Switch cadence: faster while the app is focused. */
  setForeground(foreground: boolean): void {
    const next = foreground ? FOREGROUND_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.syncAll(), this.intervalMs);
    }
  }

  /** Reconcile the local mail store with Gmail (background tick + manual). */
  async syncAll(): Promise<{ ok: boolean; error?: string }> {
    if (this.syncing) return { ok: true };
    this.syncing = true;
    try {
      for (const acc of this.accounts.values()) {
        await this.syncAccount(acc);
      }
      // Send-later queue rides the sync tick (also catches up after a
      // restart, since the first tick runs at boot).
      if (this.isConnected()) {
        await this.processDueScheduledSends().catch((err) =>
          console.error('[Gmail] scheduled sends failed:', err),
        );
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.syncing = false;
    }
  }

  private async syncAccount(acc: Account): Promise<void> {
    try {
      const accessToken = await this.getValidAccessToken(acc);
      const outcome = await syncGmailAccount({
        backendPort: this.deps.backendPort,
        accountId: acc.id,
        accessToken,
        historyId: acc.historyId,
        log: (m) => console.log(`[Gmail] ${m}`),
      });

      if (outcome.newHistoryId && outcome.newHistoryId !== acc.historyId) {
        acc.historyId = outcome.newHistoryId;
        await backendPutSetting(
          this.deps.backendPort,
          gmailSettingKey(acc.id, 'history_id'),
          acc.historyId,
        );
      }
      acc.status = 'connected';
      acc.lastError = null;
      acc.lastSyncedAt = new Date().toISOString();
      await this.patchBackendAccount(acc, outcome.fullSync);

      if (outcome.changed) this.emitChanged();
      if (outcome.inboundNew.length) {
        for (const msg of outcome.inboundNew) this.onInboundMessage(msg);
      }
      if (outcome.touchedThreadIds.length) this.onThreadsTouched(outcome.touchedThreadIds);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        acc.status = 'token_expired';
      } else {
        acc.status = 'error';
      }
      acc.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[Gmail] sync failed for ${acc.email}:`, acc.lastError);
      await this.patchBackendAccount(acc, false).catch(() => undefined);
      this.emitChanged();
    }
  }

  private routineCache: { fetchedAt: number; routines: GmailTriggerRoutine[] } | null = null;

  /** A new inbound INBOX message landed — dispatch matching routines. */
  protected onInboundMessage(msg: GmailMessageSummary): void {
    void this.dispatchTriggers(msg).catch((err) =>
      console.error('[Gmail] trigger dispatch failed:', err),
    );
  }

  private async cachedTriggerRoutines(): Promise<GmailTriggerRoutine[]> {
    const now = Date.now();
    if (this.routineCache && now - this.routineCache.fetchedAt < ROUTINE_CACHE_TTL_MS) {
      return this.routineCache.routines;
    }
    const res = await backendJsonRequest<{ routines: BackendRoutineRecord[] }>(
      this.deps.backendPort,
      'GET',
      '/routines?trigger_type=gmail_message',
    );
    const list = (res.data?.routines ?? [])
      .filter((r) => r.is_enabled)
      .map((r) => parseGmailTriggerRoutine(r))
      .filter((r): r is GmailTriggerRoutine => r !== null);
    this.routineCache = { fetchedAt: now, routines: list };
    return list;
  }

  private async dispatchTriggers(msg: GmailMessageSummary): Promise<void> {
    const engine = this.deps.executionEngine;
    if (!engine) return;
    const routines = await this.cachedTriggerRoutines();
    const matches = routines.filter((r) => matchesGmailTrigger(r.trigger, msg));
    if (!matches.length) return;
    if (!this.webContents || this.webContents.isDestroyed()) {
      console.error('[Gmail] routines not dispatched: main window not available');
      return;
    }
    const payload = buildGmailTriggerPayload(msg);
    for (const routine of matches) {
      try {
        backendJsonRequest(this.deps.backendPort, 'POST', `/routines/${routine.id}/run`).catch(
          () => undefined,
        );
        const runId = await engine.startRun(this.webContents, {
          dag: routine.dag,
          routineId: routine.id,
          triggerSource: 'gmail_message',
          triggerPayload: payload,
        });
        console.log(
          `[Gmail] dispatched routine "${routine.name}" for mail from ${payload.from_address} → run ${runId}`,
        );
      } catch (err) {
        console.error(
          `[Gmail] routine ${routine.name} dispatch failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /** Threads changed this tick — batch-classify anything still unlabeled. */
  protected onThreadsTouched(threadIds: string[]): void {
    void threadIds;
    void this.labelNewThreads().catch((err) =>
      console.error('[Gmail] AI labeling failed:', err instanceof Error ? err.message : err),
    );
  }

  private labeling = false;
  /** Gmail label ids for the Cerebro/<Category> mirror labels, by category. */
  private mirrorLabelIds = new Map<string, string>();

  private async labelNewThreads(): Promise<void> {
    if (this.labeling) return;
    this.labeling = true;
    try {
      const acc = this.resolveAccount();
      if (!acc) return;
      const res = await backendJsonRequest<{ threads: ThreadToClassify[] }>(
        this.deps.backendPort,
        'GET',
        `/gmail/threads/unlabeled?account_id=${encodeURIComponent(acc.id)}`,
      );
      const pending = res.data?.threads ?? [];
      if (!pending.length) return;

      const labels = await classifyThreads(pending);
      if (!Object.keys(labels).length) return;
      await backendJsonRequest(this.deps.backendPort, 'POST', '/gmail/threads/ai-labels', {
        account_id: acc.id,
        labels,
      });
      this.emitChanged();
      // Mirror as real Gmail labels (Cerebro/Important, …) so triage
      // round-trips into Gmail proper. Best-effort — quota-priced.
      await this.mirrorAiLabels(labels).catch(() => undefined);
    } finally {
      this.labeling = false;
    }
  }

  private async mirrorAiLabels(labels: Record<string, AiLabel>): Promise<void> {
    await this.withAccount(async (token) => {
      if (!this.mirrorLabelIds.size) {
        const existing = (await api.listLabels(token)).labels ?? [];
        for (const l of existing) {
          if (l.name.startsWith('Cerebro/')) this.mirrorLabelIds.set(l.name, l.id);
        }
      }
      // Resolve/create label ids sequentially (shared cache), then apply to
      // all threads concurrently — one RTT instead of one per thread.
      const applies: Array<{ threadId: string; labelId: string }> = [];
      for (const [threadId, category] of Object.entries(labels)) {
        const name = `Cerebro/${MIRROR_LABEL_NAMES[category]}`;
        let labelId = this.mirrorLabelIds.get(name);
        if (!labelId) {
          try {
            labelId = (await api.createLabel(token, name)).id;
          } catch {
            // Label may exist already (race) — refresh the cache once.
            const all = (await api.listLabels(token)).labels ?? [];
            labelId = all.find((l) => l.name === name)?.id;
          }
          if (!labelId) continue;
          this.mirrorLabelIds.set(name, labelId);
        }
        applies.push({ threadId, labelId });
      }
      await Promise.allSettled(
        applies.map(({ threadId, labelId }) => api.modifyThread(token, threadId, [labelId], [])),
      );
    });
  }

  // ── Outreach: templates + send-later + follow-ups ─────────────────────────

  /** Render a stored template with variables; fails listing missing tokens. */
  async resolveTemplate(
    templateId: string,
    variables: Record<string, string>,
  ): Promise<{ ok: boolean; subject?: string; text?: string; error?: string; missing?: string[] }> {
    const res = await backendJsonRequest<{
      subject_template: string | null;
      body_template: string;
      name: string;
    }>(this.deps.backendPort, 'GET', `/gmail/templates/${encodeURIComponent(templateId)}`);
    if (!res.ok || !res.data) return { ok: false, error: `Template ${templateId} not found` };
    const body = renderEmailTemplate(res.data.body_template, variables);
    const subject = renderEmailTemplate(res.data.subject_template ?? '', variables);
    if (!body.ok || !subject.ok) {
      const missing = [...new Set([...body.missing, ...subject.missing])];
      return {
        ok: false,
        missing,
        error: `Template "${res.data.name}" is missing values for: ${missing.join(', ')}`,
      };
    }
    return { ok: true, subject: subject.text, text: body.text };
  }

  /** Queue an email for a future send (processed on sync ticks + boot). */
  async scheduleSend(
    input: GmailSendInput & { sendAtISO: string },
  ): Promise<{ ok: boolean; scheduledId?: string; error?: string }> {
    const acc = this.resolveAccount();
    if (!acc) return { ok: false, error: 'No Gmail account connected' };
    const res = await backendJsonRequest<{ id: string }>(
      this.deps.backendPort,
      'POST',
      '/gmail/scheduled-sends',
      {
        account_id: acc.id,
        to_addrs: input.to.join(', '),
        cc_addrs: input.cc?.join(', ') ?? '',
        bcc_addrs: input.bcc?.join(', ') ?? '',
        subject: input.subject,
        body_text: input.text,
        reply_to_thread_id: input.replyToThreadId ?? '',
        send_at: input.sendAtISO,
      },
    );
    if (!res.ok || !res.data?.id) return { ok: false, error: 'Failed to schedule send' };
    this.emitChanged();
    return { ok: true, scheduledId: res.data.id };
  }

  /** Send every due scheduled email. Runs on each sync tick and at boot, so a
   *  send missed while the app was closed goes out on next launch. */
  private async processDueScheduledSends(): Promise<void> {
    const res = await backendJsonRequest<{
      scheduled: Array<{
        id: string;
        to_addrs: string;
        cc_addrs: string | null;
        bcc_addrs: string | null;
        subject: string | null;
        body_text: string;
        reply_to_thread_id: string | null;
      }>;
    }>(this.deps.backendPort, 'GET', '/gmail/scheduled-sends?due=true');
    for (const s of res.data?.scheduled ?? []) {
      const result = await this.sendMessage({
        to: splitAddresses(s.to_addrs),
        cc: splitAddresses(s.cc_addrs ?? ''),
        bcc: splitAddresses(s.bcc_addrs ?? ''),
        subject: s.subject ?? '',
        text: s.body_text,
        replyToThreadId: s.reply_to_thread_id ?? undefined,
      });
      await backendJsonRequest(
        this.deps.backendPort,
        'PATCH',
        `/gmail/scheduled-sends/${s.id}`,
        result.ok
          ? { status: 'sent', sent_message_id: result.messageId ?? '' }
          : { status: 'failed', error: result.error ?? 'send failed' },
      );
    }
  }

  /** Outbound threads with no reply after N days — follow-up candidates. */
  async listAwaitingReply(olderThanDays: number): Promise<
    Array<{
      thread_id: string;
      subject: string | null;
      last_outbound_at: string | null;
      snippet: string | null;
    }>
  > {
    const acc = this.resolveAccount();
    if (!acc) return [];
    const res = await backendJsonRequest<{
      threads: Array<{
        thread_id: string;
        subject: string | null;
        last_outbound_at: string | null;
        snippet: string | null;
      }>;
    }>(
      this.deps.backendPort,
      'GET',
      `/gmail/threads/awaiting-reply?account_id=${encodeURIComponent(acc.id)}&older_than_days=${olderThanDays}`,
    );
    return res.data?.threads ?? [];
  }

  // ── AI: summaries + voice drafts ──────────────────────────────────────────

  /** Load a locally-synced thread as the {subject, messages} shape ai.ts eats. */
  private async fetchThreadForAi(
    accountId: string,
    threadId: string,
  ): Promise<{ subject: string; messages: MessageForAi[] } | null> {
    const res = await backendJsonRequest<{
      messages: Array<{
        from_addr: string | null;
        internal_date: string | null;
        body_text: string | null;
        snippet: string | null;
        subject: string | null;
        is_outbound: boolean;
      }>;
    }>(
      this.deps.backendPort,
      'GET',
      `/gmail/threads/${encodeURIComponent(threadId)}/messages?account_id=${encodeURIComponent(accountId)}`,
    );
    const msgs = res.data?.messages ?? [];
    if (!msgs.length) return null;
    return {
      subject: msgs[0]?.subject ?? '',
      messages: msgs.map((m) => ({
        from: m.from_addr ?? '',
        date: m.internal_date ?? '',
        body: m.body_text || m.snippet || '',
        outbound: m.is_outbound,
      })),
    };
  }

  /** Compute (and cache) the one-line summary for a locally-synced thread. */
  async summarizeThreadCached(
    threadId: string,
  ): Promise<{ ok: boolean; summary?: string; error?: string }> {
    const acc = this.resolveAccount();
    if (!acc) return { ok: false, error: 'No Gmail account connected' };
    const thread = await this.fetchThreadForAi(acc.id, threadId);
    if (!thread) return { ok: false, error: 'Thread not synced locally' };
    const summary = await summarizeThread(thread.subject, thread.messages);
    if (!summary) return { ok: false, error: 'Summary unavailable' };
    await backendJsonRequest(this.deps.backendPort, 'POST', '/gmail/threads/ai-summary', {
      account_id: acc.id,
      thread_id: threadId,
      summary,
      message_count: thread.messages.length,
    });
    this.emitChanged();
    return { ok: true, summary };
  }

  /** Draft an email body in the user's voice (recent sent mail as samples). */
  async aiDraft(input: {
    to: string;
    instruction: string;
    replyToThreadId?: string;
  }): Promise<{ ok: boolean; body?: string; error?: string }> {
    const acc = this.resolveAccount();
    if (!acc) return { ok: false, error: 'No Gmail account connected' };

    const address = splitAddresses(input.to)[0] ?? '';
    const fetchSamples = async (to?: string) => {
      const p = new URLSearchParams({ account_id: acc.id, limit: '8' });
      if (to) p.set('to', to);
      const r = await backendJsonRequest<{
        messages: Array<{ to_addrs: string | null; body_text: string | null }>;
      }>(this.deps.backendPort, 'GET', `/gmail/messages/recent-sent?${p}`);
      return (r.data?.messages ?? [])
        .filter((m) => m.body_text)
        .map((m) => ({ to: m.to_addrs ?? '', body: m.body_text ?? '' }));
    };
    let samples = address ? await fetchSamples(address) : [];
    if (samples.length < 3) samples = [...samples, ...(await fetchSamples())].slice(0, 8);

    const thread = input.replyToThreadId
      ? ((await this.fetchThreadForAi(acc.id, input.replyToThreadId)) ?? undefined)
      : undefined;

    const body = await draftEmail({
      instruction: input.instruction,
      thread,
      to: input.to,
      voiceSamples: samples,
      senderName: acc.displayName ?? acc.email,
    });
    if (!body) return { ok: false, error: 'Draft unavailable — is Claude Code signed in?' };
    return { ok: true, body };
  }

  /** Mirror non-secret account state into the backend store. */
  private async patchBackendAccount(acc: Account, fullSync: boolean): Promise<void> {
    await backendJsonRequest(this.deps.backendPort, 'PATCH', `/gmail/accounts/${acc.id}`, {
      status: acc.status,
      last_error: acc.lastError ?? '',
      last_synced_at: acc.lastSyncedAt,
      last_history_id: acc.historyId ?? '',
      ...(fullSync ? { last_full_sync_at: new Date().toISOString() } : {}),
    });
  }

  // ── Persistence (settings are device-local via the gmail_ prefix) ─────────

  private async loadAccount(id: string): Promise<Account | null> {
    const port = this.deps.backendPort;
    const [
      email,
      displayName,
      clientId,
      encSecret,
      encAccess,
      encRefresh,
      expiry,
      status,
      historyId,
    ] = await Promise.all([
      backendGetSetting<string>(port, gmailSettingKey(id, 'email')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'display_name')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'client_id')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'client_secret')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'access_token')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'refresh_token')),
      backendGetSetting<number>(port, gmailSettingKey(id, 'token_expiry')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'status')),
      backendGetSetting<string>(port, gmailSettingKey(id, 'history_id')),
    ]);
    if (!clientId || !encSecret || !encAccess) return null;
    const clientSecret = decryptFromStorage(encSecret);
    const accessToken = decryptFromStorage(encAccess);
    const refreshToken = encRefresh ? decryptFromStorage(encRefresh) : null;
    if (!clientSecret || !accessToken) return null;
    return {
      id,
      email: email ?? '',
      displayName: displayName || null,
      clientId,
      clientSecret,
      tokens: { accessToken, refreshToken, expiresAt: expiry ?? 0 },
      status: (status as GmailAccountStatus) || 'connected',
      lastError: null,
      lastSyncedAt: null,
      historyId: historyId || null,
    };
  }

  private async persistAccount(acc: Account): Promise<void> {
    const port = this.deps.backendPort;
    await Promise.all([
      backendPutSetting(port, gmailSettingKey(acc.id, 'email'), acc.email),
      backendPutSetting(port, gmailSettingKey(acc.id, 'display_name'), acc.displayName ?? ''),
      backendPutSetting(port, gmailSettingKey(acc.id, 'client_id'), acc.clientId),
      backendPutSetting(
        port,
        gmailSettingKey(acc.id, 'client_secret'),
        encryptForStorage(acc.clientSecret),
      ),
      backendPutSetting(port, gmailSettingKey(acc.id, 'status'), acc.status),
      backendPutSetting(port, gmailSettingKey(acc.id, 'history_id'), acc.historyId ?? ''),
      this.persistTokens(acc),
    ]);
  }

  private async persistTokens(acc: Account): Promise<void> {
    const port = this.deps.backendPort;
    await Promise.all([
      backendPutSetting(
        port,
        gmailSettingKey(acc.id, 'access_token'),
        encryptForStorage(acc.tokens.accessToken),
      ),
      backendPutSetting(
        port,
        gmailSettingKey(acc.id, 'refresh_token'),
        acc.tokens.refreshToken ? encryptForStorage(acc.tokens.refreshToken) : '',
      ),
      backendPutSetting(port, gmailSettingKey(acc.id, 'token_expiry'), acc.tokens.expiresAt),
    ]);
  }

  private async clearAccountSettings(id: string): Promise<void> {
    const port = this.deps.backendPort;
    await Promise.all(
      GMAIL_ACCOUNT_FIELDS.map((f) => backendPutSetting(port, gmailSettingKey(id, f), '')),
    );
  }

  // ── Connect / reconnect / disconnect ──────────────────────────────────────

  async startOAuth(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<{ ok: boolean; account?: GmailAccountInfo; error?: string }> {
    try {
      const tokens = await runOAuthFlow(
        this.provider,
        input.clientId.trim(),
        input.clientSecret.trim(),
        { successTitle: 'Gmail connected' },
      );
      const userInfo = await this.provider.getUserInfo(tokens.accessToken);
      const profile = await api.getProfile(tokens.accessToken);

      // Single-account v1: connecting again replaces the existing account.
      for (const existing of [...this.accounts.keys()]) {
        await this.disconnect(existing);
      }

      const acc: Account = {
        id: randomUUID(),
        email: profile.emailAddress || userInfo.email,
        displayName: userInfo.name ?? null,
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        tokens,
        status: 'connected',
        lastError: null,
        lastSyncedAt: null,
        // Start incremental sync from "now" — the windowed backfill (Phase B)
        // covers the past.
        historyId: profile.historyId ?? null,
      };
      this.accounts.set(acc.id, acc);
      await this.persistAccount(acc);
      const index =
        (await backendGetSetting<string[]>(this.deps.backendPort, GMAIL_INDEX_KEY)) ?? [];
      if (!index.includes(acc.id)) {
        index.push(acc.id);
        await backendPutSetting(this.deps.backendPort, GMAIL_INDEX_KEY, index);
      }
      // Create the backend (local-only) account row, then kick the backfill.
      await backendJsonRequest(this.deps.backendPort, 'PUT', '/gmail/accounts', {
        id: acc.id,
        email: acc.email,
        display_name: acc.displayName,
        status: 'connected',
      });
      this.emitChanged();
      void this.syncAll();
      return { ok: true, account: toAccountInfo(acc) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reconnect(
    accountId: string,
  ): Promise<{ ok: boolean; account?: GmailAccountInfo; error?: string }> {
    const acc = this.accounts.get(accountId);
    if (!acc) return { ok: false, error: 'Account not found' };
    return this.startOAuth({ clientId: acc.clientId, clientSecret: acc.clientSecret });
  }

  async disconnect(accountId: string): Promise<{ ok: boolean; error?: string }> {
    this.accounts.delete(accountId);
    // Drop the local mail mirror (messages/threads cascade with the account row).
    await backendJsonRequest(this.deps.backendPort, 'DELETE', `/gmail/accounts/${accountId}`).catch(
      () => undefined,
    );
    await this.clearAccountSettings(accountId);
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, GMAIL_INDEX_KEY)) ?? [];
    await backendPutSetting(
      this.deps.backendPort,
      GMAIL_INDEX_KEY,
      index.filter((x) => x !== accountId),
    );
    this.emitChanged();
    return { ok: true };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  listAccounts(): GmailAccountInfo[] {
    return [...this.accounts.values()].map(toAccountInfo);
  }

  status(): GmailStatus {
    this.rolloverSentCounter();
    return {
      connected: [...this.accounts.values()].some((a) => a.status === 'connected'),
      accounts: this.listAccounts(),
      sentToday: this.sentToday.count,
      tokenBackend: secureTokenBackend(),
    };
  }

  isConnected(): boolean {
    return [...this.accounts.values()].some((a) => a.status === 'connected');
  }

  getAccountEmail(): string | null {
    return this.resolveAccount()?.email ?? null;
  }

  // ── Token management ───────────────────────────────────────────────────────

  protected resolveAccount(accountId?: string): Account | null {
    if (accountId) return this.accounts.get(accountId) ?? null;
    return this.accounts.values().next().value ?? null;
  }

  protected async getValidAccessToken(acc: Account): Promise<string> {
    if (acc.tokens.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return acc.tokens.accessToken;
    }
    if (!acc.tokens.refreshToken) {
      throw new TokenExpiredError('No refresh token; reconnect required');
    }
    const refreshed = await this.provider.refresh({
      client: { clientId: acc.clientId, clientSecret: acc.clientSecret, redirectUri: '' },
      refreshToken: acc.tokens.refreshToken,
    });
    acc.tokens = refreshed;
    await this.persistTokens(acc);
    return acc.tokens.accessToken;
  }

  /** Run an API call with the account's token; map token expiry to account status. */
  protected async withAccount<T>(
    fn: (accessToken: string, acc: Account) => Promise<T>,
  ): Promise<T> {
    const acc = this.resolveAccount();
    if (!acc) throw new Error('No Gmail account connected');
    try {
      const token = await this.getValidAccessToken(acc);
      const result = await fn(token, acc);
      if (acc.status !== 'connected') {
        acc.status = 'connected';
        acc.lastError = null;
        await backendPutSetting(
          this.deps.backendPort,
          gmailSettingKey(acc.id, 'status'),
          acc.status,
        );
        this.emitChanged();
      }
      return result;
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        acc.status = 'token_expired';
        acc.lastError = err.message;
        await backendPutSetting(
          this.deps.backendPort,
          gmailSettingKey(acc.id, 'status'),
          acc.status,
        ).catch(() => undefined);
        this.emitChanged();
      }
      throw err;
    }
  }

  // ── Mail operations (live API; local-store variants come with sync) ───────

  /**
   * Local-first search. Plain text hits the FTS index instantly; queries using
   * Gmail operators (from:, is:, after:, …) or with thin local results also
   * run a live Gmail search and merge, deduped by message id.
   */
  async search(query: string, maxResults = 25): Promise<GmailMessageSummary[]> {
    const local = await this.searchLocal(query, maxResults);
    const hasOperators = /(^|\s)[a-z_]+:(\S)/i.test(query);
    if (!hasOperators && local.length >= Math.min(maxResults, 5)) return local;
    let live: GmailMessageSummary[] = [];
    try {
      live = await this.searchLive(query, maxResults);
    } catch {
      // Offline / rate-limited — local results are still useful.
      return local;
    }
    const seen = new Set(local.map((m) => m.id));
    return [...local, ...live.filter((m) => !seen.has(m.id))].slice(0, maxResults);
  }

  private async searchLocal(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    const res = await backendJsonRequest<{
      messages: Array<{
        message_id: string;
        thread_id: string;
        from_addr: string | null;
        to_addrs: string | null;
        subject: string | null;
        snippet: string | null;
        internal_date: string | null;
        label_ids: string[];
        is_unread: boolean;
        has_attachments: boolean;
      }>;
    }>(this.deps.backendPort, 'POST', '/gmail/search', { q: query, limit: maxResults });
    return (res.data?.messages ?? []).map((m) => ({
      id: m.message_id,
      threadId: m.thread_id,
      from: m.from_addr ?? '',
      to: m.to_addrs ?? '',
      subject: m.subject ?? '',
      snippet: m.snippet ?? '',
      receivedAt: m.internal_date ?? new Date(0).toISOString(),
      labelIds: m.label_ids,
      unread: m.is_unread,
      hasAttachments: m.has_attachments,
    }));
  }

  /** Live Gmail search (`q` supports the full Gmail operator syntax). */
  async searchLive(q: string, maxResults = 25): Promise<GmailMessageSummary[]> {
    return this.withAccount(async (token) => {
      const list = await api.listMessages(token, { q, maxResults });
      const out: GmailMessageSummary[] = [];
      for (const m of list.messages ?? []) {
        const raw = await api.getMessage(token, m.id, 'metadata');
        out.push(api.toSummary(raw));
      }
      return out;
    });
  }

  async getThread(threadId: string): Promise<GmailThreadDTO> {
    return this.withAccount(async (token) => {
      const raw = await api.getThread(token, threadId);
      const messages = (raw.messages ?? []).map(api.toFull);
      return {
        threadId: raw.id,
        subject: messages[0]?.subject ?? '',
        messages,
      };
    });
  }

  async listLabels(): Promise<api.GmailLabel[]> {
    return this.withAccount(async (token) => (await api.listLabels(token)).labels ?? []);
  }

  async sendMessage(input: GmailSendInput): Promise<GmailSendResult> {
    try {
      return await this.withAccount(async (token, acc) => {
        const reply = input.replyToThreadId
          ? await this.resolveReplyHeaders(token, input.replyToThreadId)
          : null;
        const raw = buildRawMessage({
          from: acc.displayName ? `${acc.displayName} <${acc.email}>` : acc.email,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          // Reply threading also requires a matching Subject.
          subject: reply?.subject ?? input.subject,
          text: input.text,
          html: input.html,
          inReplyTo: reply?.messageIdHeader,
          references: reply?.references,
          attachments: input.attachments,
        });
        const sent = await api.sendMessage(token, raw, input.replyToThreadId);
        this.rolloverSentCounter();
        this.sentToday.count += 1;
        this.onMessageSent(sent.id, sent.threadId);
        return { ok: true, messageId: sent.id, threadId: sent.threadId };
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Index a just-sent message immediately (follow-up detection sees it now,
   *  not on the next sync tick). Best-effort — the next tick catches misses. */
  protected onMessageSent(_messageId: string, _threadId: string): void {
    void this.syncAll().catch(() => undefined);
  }

  async createDraft(
    input: GmailSendInput,
  ): Promise<{ ok: boolean; draftId?: string; error?: string }> {
    try {
      return await this.withAccount(async (token, acc) => {
        const reply = input.replyToThreadId
          ? await this.resolveReplyHeaders(token, input.replyToThreadId)
          : null;
        const raw = buildRawMessage({
          from: acc.displayName ? `${acc.displayName} <${acc.email}>` : acc.email,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: reply?.subject ?? input.subject,
          text: input.text,
          html: input.html,
          inReplyTo: reply?.messageIdHeader,
          references: reply?.references,
          attachments: input.attachments,
        });
        const draft = await api.createDraft(token, raw, input.replyToThreadId);
        return { ok: true, draftId: draft.id };
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async modifyLabels(
    messageIds: string[],
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.withAccount(async (token) => {
        for (const id of messageIds) {
          await api.modifyMessage(token, id, addLabelIds, removeLabelIds);
        }
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Gather threading headers from the last message in the replied-to thread. */
  private async resolveReplyHeaders(
    token: string,
    threadId: string,
  ): Promise<{ messageIdHeader: string; references: string; subject: string }> {
    const thread = await api.getThread(token, threadId);
    const last = thread.messages?.[thread.messages.length - 1];
    if (!last) throw new Error(`Thread ${threadId} has no messages to reply to`);
    const subjectRaw = api.headerValue(last, 'Subject');
    const subject = /^re:/i.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
    return {
      messageIdHeader: api.headerValue(last, 'Message-ID'),
      references: api.headerValue(last, 'References'),
      subject,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private rolloverSentCounter(): void {
    const today = todayKey();
    if (this.sentToday.date !== today) this.sentToday = { date: today, count: 0 };
  }

  protected emitChanged(): void {
    if (this.webContents && !this.webContents.isDestroyed()) {
      this.webContents.send(IPC_CHANNELS.GMAIL_CHANGED);
    }
  }
}

function todayKey(): string {
  return new Date().toDateString();
}

function toAccountInfo(acc: Account): GmailAccountInfo {
  return {
    id: acc.id,
    email: acc.email,
    displayName: acc.displayName,
    status: acc.status,
    lastError: acc.lastError,
    lastSyncedAt: acc.lastSyncedAt,
  };
}
