/**
 * CalendarBridge — main-process owner of OAuth, encrypted tokens, provider HTTP
 * calls, and the two-way sync engine for the calendar integration.
 *
 * Why main (not the Python backend): safeStorage (secure-token.ts) only works in
 * main, and OAuth client secrets / tokens must never reach the renderer or the
 * backend process. The bridge calls providers directly and writes normalized,
 * secret-free rows to the backend store (/calendar/*), which the renderer reads
 * and which replicates to Supabase. Tokens live under device-local `calendar_`
 * settings (excluded from sync by prefix).
 *
 * Shape mirrors HubSpotHolder (token persistence) + WhatsAppBridge (interval
 * watchdog). It implements CalendarChannel so engine actions can drive it.
 */

import { BrowserWindow, type WebContents } from 'electron';
import { encryptForStorage, decryptFromStorage } from '../secure-token';
import {
  backendGetSetting,
  backendPutSetting,
  backendJsonRequest,
} from '../shared/backend-settings';
import { IPC_CHANNELS } from '../types/ipc';
import type {
  CalendarAccountInfo,
  CalendarProviderId,
  CalendarStatus,
  CalendarEventInput,
  CalendarEventDTO,
  CalendarParsedCommand,
  RemoteCalendar,
  RsvpResponse,
} from '../types/calendar';
import { LOCAL_CALENDAR_ACCOUNT_ID, LOCAL_CALENDAR_ID } from '../types/calendar';
import { parseCalendarCommand, summarizeCalendar } from './ai';
import type { CalendarChannel, FreeSlot } from '../engine/actions/calendar-channel';
import type { CalendarProvider, ProviderEventWrite, TokenSet } from './providers/types';
import { TokenExpiredError } from './providers/types';
import { GoogleCalendarProvider } from './providers/google';
import { OutlookCalendarProvider } from './providers/outlook';
import { runOAuthFlow } from './oauth';

const INDEX_KEY = 'calendar_accounts_index';
const FOREGROUND_INTERVAL_MS = 60_000;
const BACKGROUND_INTERVAL_MS = 5 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
// Windowed full-sync range used on first connect / cursor expiry.
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 180;

function settingKey(accountId: string, field: string): string {
  return `calendar_${accountId}_${field}`;
}

interface Account {
  id: string;
  provider: CalendarProviderId;
  email: string;
  displayName: string | null;
  clientId: string;
  clientSecret: string;
  tokens: TokenSet;
  calendars: RemoteCalendar[];
  primaryCalendarId: string | null;
  status: CalendarAccountInfo['status'];
  lastError: string | null;
  lastSyncedAt: string | null;
}

export interface CalendarBridgeDeps {
  backendPort: number;
}

export class CalendarBridge implements CalendarChannel {
  private accounts = new Map<string, Account>();
  private providers = new Map<CalendarProviderId, CalendarProvider>();
  private webContents: WebContents | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = FOREGROUND_INTERVAL_MS;
  private syncing = false;

  constructor(private deps: CalendarBridgeDeps) {
    this.providers.set('google', new GoogleCalendarProvider());
    this.providers.set('outlook', new OutlookCalendarProvider());
  }

  setWebContents(wc: WebContents | null): void {
    this.webContents = wc;
  }

  private getProvider(id: CalendarProviderId): CalendarProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`Calendar provider not available: ${id}`);
    return p;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, INDEX_KEY)) ?? [];
    for (const id of index) {
      try {
        const acc = await this.loadAccount(id);
        if (acc) this.accounts.set(id, acc);
      } catch (err) {
        console.error(`[Calendar] failed to load account ${id}:`, err);
      }
    }
  }

  /** Begin the background reconcile loop and run one immediate tick. */
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

  /** Switch cadence: faster when the app/calendar is in the foreground. */
  setForeground(foreground: boolean): void {
    const next = foreground ? FOREGROUND_INTERVAL_MS : BACKGROUND_INTERVAL_MS;
    if (next === this.intervalMs) return;
    this.intervalMs = next;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.syncAll(), this.intervalMs);
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private async loadAccount(id: string): Promise<Account | null> {
    const port = this.deps.backendPort;
    const [
      provider,
      email,
      displayName,
      clientId,
      encSecret,
      encAccess,
      encRefresh,
      expiry,
      calendars,
      primary,
      status,
    ] = await Promise.all([
      backendGetSetting<string>(port, settingKey(id, 'provider')),
      backendGetSetting<string>(port, settingKey(id, 'email')),
      backendGetSetting<string>(port, settingKey(id, 'display_name')),
      backendGetSetting<string>(port, settingKey(id, 'client_id')),
      backendGetSetting<string>(port, settingKey(id, 'client_secret')),
      backendGetSetting<string>(port, settingKey(id, 'access_token')),
      backendGetSetting<string>(port, settingKey(id, 'refresh_token')),
      backendGetSetting<number>(port, settingKey(id, 'token_expiry')),
      backendGetSetting<RemoteCalendar[]>(port, settingKey(id, 'calendars')),
      backendGetSetting<string>(port, settingKey(id, 'primary_calendar_id')),
      backendGetSetting<string>(port, settingKey(id, 'status')),
    ]);
    if (!provider || !clientId || !encSecret || !encAccess) return null;
    const clientSecret = decryptFromStorage(encSecret);
    const accessToken = decryptFromStorage(encAccess);
    const refreshToken = encRefresh ? decryptFromStorage(encRefresh) : null;
    if (!clientSecret || !accessToken) return null;
    return {
      id,
      provider: provider as CalendarProviderId,
      email: email ?? '',
      displayName: displayName ?? null,
      clientId,
      clientSecret,
      tokens: { accessToken, refreshToken, expiresAt: expiry ?? 0 },
      calendars: calendars ?? [],
      primaryCalendarId: primary ?? null,
      status: (status as Account['status']) ?? 'connected',
      lastError: null,
      lastSyncedAt: null,
    };
  }

  private async persistAccountSettings(acc: Account): Promise<void> {
    const port = this.deps.backendPort;
    await Promise.all([
      backendPutSetting(port, settingKey(acc.id, 'provider'), acc.provider),
      backendPutSetting(port, settingKey(acc.id, 'email'), acc.email),
      backendPutSetting(port, settingKey(acc.id, 'display_name'), acc.displayName ?? ''),
      backendPutSetting(port, settingKey(acc.id, 'client_id'), acc.clientId),
      backendPutSetting(
        port,
        settingKey(acc.id, 'client_secret'),
        encryptForStorage(acc.clientSecret),
      ),
      backendPutSetting(
        port,
        settingKey(acc.id, 'access_token'),
        encryptForStorage(acc.tokens.accessToken),
      ),
      backendPutSetting(
        port,
        settingKey(acc.id, 'refresh_token'),
        acc.tokens.refreshToken ? encryptForStorage(acc.tokens.refreshToken) : '',
      ),
      backendPutSetting(port, settingKey(acc.id, 'token_expiry'), acc.tokens.expiresAt),
      backendPutSetting(port, settingKey(acc.id, 'calendars'), acc.calendars),
      backendPutSetting(
        port,
        settingKey(acc.id, 'primary_calendar_id'),
        acc.primaryCalendarId ?? '',
      ),
      backendPutSetting(port, settingKey(acc.id, 'status'), acc.status),
    ]);
  }

  private async persistTokens(acc: Account): Promise<void> {
    const port = this.deps.backendPort;
    await Promise.all([
      backendPutSetting(
        port,
        settingKey(acc.id, 'access_token'),
        encryptForStorage(acc.tokens.accessToken),
      ),
      backendPutSetting(
        port,
        settingKey(acc.id, 'refresh_token'),
        acc.tokens.refreshToken ? encryptForStorage(acc.tokens.refreshToken) : '',
      ),
      backendPutSetting(port, settingKey(acc.id, 'token_expiry'), acc.tokens.expiresAt),
    ]);
  }

  private async addToIndex(id: string): Promise<void> {
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, INDEX_KEY)) ?? [];
    if (!index.includes(id)) {
      index.push(id);
      await backendPutSetting(this.deps.backendPort, INDEX_KEY, index);
    }
  }

  private async removeFromIndex(id: string): Promise<void> {
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, INDEX_KEY)) ?? [];
    await backendPutSetting(
      this.deps.backendPort,
      INDEX_KEY,
      index.filter((x) => x !== id),
    );
  }

  private async patchBackendAccount(acc: Account): Promise<void> {
    await backendJsonRequest(this.deps.backendPort, 'PATCH', `/calendar/accounts/${acc.id}`, {
      display_name: acc.displayName,
      primary_calendar_id: acc.primaryCalendarId,
      calendars: acc.calendars,
      status: acc.status,
      last_error: acc.lastError ?? '',
      last_synced_at: acc.lastSyncedAt,
    });
  }

  // ── Connect / reconnect / disconnect ──────────────────────────────────────

  async startOAuth(input: {
    provider: CalendarProviderId;
    clientId: string;
    clientSecret: string;
  }): Promise<{
    ok: boolean;
    account?: CalendarAccountInfo;
    error?: string;
  }> {
    try {
      const provider = this.getProvider(input.provider);
      const tokens = await runOAuthFlow(provider, input.clientId.trim(), input.clientSecret.trim());
      const userInfo = await provider.getUserInfo(tokens.accessToken);
      const calendars = await provider.listCalendars(tokens.accessToken);
      const primary = calendars.find((c) => c.id === 'primary') ?? calendars[0] ?? null;

      // Create the backend (synced) account row; it owns the id.
      const created = await backendJsonRequest<{ id: string }>(
        this.deps.backendPort,
        'POST',
        '/calendar/accounts',
        {
          provider: input.provider,
          email: userInfo.email,
          display_name: userInfo.name ?? null,
          primary_calendar_id: primary?.id ?? null,
          calendars,
        },
      );
      if (!created.ok || !created.data?.id) {
        return { ok: false, error: 'Failed to create account record' };
      }
      const id = created.data.id;
      const acc: Account = {
        id,
        provider: input.provider,
        email: userInfo.email,
        displayName: userInfo.name ?? null,
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret.trim(),
        tokens,
        calendars,
        primaryCalendarId: primary?.id ?? null,
        status: 'connected',
        lastError: null,
        lastSyncedAt: null,
      };
      this.accounts.set(id, acc);
      await this.persistAccountSettings(acc);
      await this.addToIndex(id);
      // Kick an immediate sync for the new account.
      void this.syncAccount(acc).then(() => this.emitChanged());
      return { ok: true, account: toAccountInfo(acc) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async reconnect(
    accountId: string,
  ): Promise<{ ok: boolean; account?: CalendarAccountInfo; error?: string }> {
    const acc = this.accounts.get(accountId);
    if (!acc) return { ok: false, error: 'Account not found' };
    return this.startOAuth({
      provider: acc.provider,
      clientId: acc.clientId,
      clientSecret: acc.clientSecret,
    }).then(async (res) => {
      if (res.ok) {
        // OAuth created a fresh account row; retire the stale one.
        await this.disconnect(accountId);
      }
      return res;
    });
  }

  async disconnect(accountId: string): Promise<{ ok: boolean; error?: string }> {
    this.accounts.delete(accountId);
    await backendJsonRequest(this.deps.backendPort, 'DELETE', `/calendar/accounts/${accountId}`);
    await this.clearAccountSettings(accountId);
    await this.removeFromIndex(accountId);
    this.emitChanged();
    return { ok: true };
  }

  private async clearAccountSettings(id: string): Promise<void> {
    const port = this.deps.backendPort;
    const fields = [
      'provider',
      'email',
      'display_name',
      'client_id',
      'client_secret',
      'access_token',
      'refresh_token',
      'token_expiry',
      'calendars',
      'primary_calendar_id',
      'status',
    ];
    await Promise.all(fields.map((f) => backendPutSetting(port, settingKey(id, f), '')));
  }

  async setCalendars(
    accountId: string,
    selectedCalendarIds: string[],
  ): Promise<{ ok: boolean; error?: string }> {
    const acc = this.accounts.get(accountId);
    if (!acc) return { ok: false, error: 'Account not found' };
    const selected = new Set(selectedCalendarIds);
    acc.calendars = acc.calendars.map((c) => ({ ...c, selected: selected.has(c.id) }));
    await backendPutSetting(this.deps.backendPort, settingKey(acc.id, 'calendars'), acc.calendars);
    await this.patchBackendAccount(acc);
    void this.syncAccount(acc).then(() => this.emitChanged());
    return { ok: true };
  }

  // ── Status ────────────────────────────────────────────────────────────────

  listAccounts(): CalendarAccountInfo[] {
    return [...this.accounts.values()].map(toAccountInfo);
  }

  status(): CalendarStatus {
    const accounts = this.listAccounts();
    return { connected: accounts.some((a) => a.status === 'connected'), accounts };
  }

  isConnected(): boolean {
    return [...this.accounts.values()].some((a) => a.status === 'connected');
  }

  // ── Token management ───────────────────────────────────────────────────────

  private async getValidAccessToken(acc: Account): Promise<string> {
    if (acc.tokens.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return acc.tokens.accessToken;
    }
    if (!acc.tokens.refreshToken) {
      throw new TokenExpiredError('No refresh token; reconnect required');
    }
    const provider = this.getProvider(acc.provider);
    const refreshed = await provider.refresh({
      client: { clientId: acc.clientId, clientSecret: acc.clientSecret, redirectUri: '' },
      refreshToken: acc.tokens.refreshToken,
    });
    acc.tokens = refreshed;
    await this.persistTokens(acc);
    return acc.tokens.accessToken;
  }

  // ── Sync engine ─────────────────────────────────────────────────────────────

  /** Run a reconcile across all accounts (background tick + manual Refresh). */
  async syncAll(): Promise<{ ok: boolean; error?: string }> {
    if (this.syncing) return { ok: true };
    this.syncing = true;
    try {
      // Accounts are independent (different providers + rows) — sync in parallel.
      const results = await Promise.all(
        [...this.accounts.values()].map((acc) => this.syncAccount(acc)),
      );
      if (results.some(Boolean)) this.emitChanged();
    } finally {
      this.syncing = false;
    }
    return { ok: true };
  }

  /** Reconcile one account: push pending local mutations, then pull incremental. */
  private async syncAccount(acc: Account): Promise<boolean> {
    let changed = false;
    try {
      const accessToken = await this.getValidAccessToken(acc);
      changed = (await this.pushPending(acc, accessToken)) || changed;

      const provider = this.getProvider(acc.provider);
      const selected = acc.calendars.filter((c) => c.selected !== false);
      const cals = selected.length ? selected : acc.calendars;
      // Fetch all sync cursors for this account once, not once per calendar.
      const cursors = await this.getSyncCursors(acc.id);
      for (const cal of cals) {
        changed =
          (await this.pullCalendar(
            acc,
            provider,
            accessToken,
            cal.id,
            cursors.get(cal.id) ?? null,
          )) || changed;
      }

      acc.status = 'connected';
      acc.lastError = null;
      acc.lastSyncedAt = new Date().toISOString();
      await this.patchBackendAccount(acc);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        acc.status = 'token_expired';
        acc.lastError = err.message;
      } else {
        acc.status = 'error';
        acc.lastError = err instanceof Error ? err.message : String(err);
      }
      await this.patchBackendAccount(acc).catch(() => undefined);
    }
    return changed;
  }

  private async pullCalendar(
    acc: Account,
    provider: CalendarProvider,
    accessToken: string,
    calendarId: string,
    syncCursor: string | null,
  ): Promise<boolean> {
    const now = Date.now();
    const timeMin = new Date(now - WINDOW_PAST_DAYS * 86_400_000).toISOString();
    const timeMax = new Date(now + WINDOW_FUTURE_DAYS * 86_400_000).toISOString();

    let result = await provider.pullEvents({
      accessToken,
      calendarId,
      syncCursor,
      timeMin,
      timeMax,
    });
    if (result.cursorExpired) {
      // Stored cursor rejected — full windowed resync.
      result = await provider.pullEvents({
        accessToken,
        calendarId,
        syncCursor: null,
        timeMin,
        timeMax,
      });
    }

    const hasChanges = result.events.length > 0 || result.deletions.length > 0;
    if (hasChanges) {
      await backendJsonRequest(this.deps.backendPort, 'POST', '/calendar/events/sync', {
        account_id: acc.id,
        upserts: result.events.map((e) => ({
          calendar_id: calendarId,
          provider_event_id: e.providerEventId,
          etag: e.etag,
          ical_uid: e.icalUid,
          title: e.title,
          description: e.description,
          location: e.location,
          start_utc: e.startUtc,
          end_utc: e.endUtc,
          start_tz: e.startTz,
          end_tz: e.endTz,
          all_day: e.allDay,
          recurrence: e.recurrence,
          recurring_master_id: e.recurringMasterId,
          attendees: e.attendees,
          organizer_email: e.organizerEmail,
          rsvp_status: e.rsvpStatus,
          visibility: e.visibility,
          transparency: e.transparency,
          status: e.status,
          conference_url: e.conferenceUrl,
          provider_updated_at: e.providerUpdatedAt,
        })),
        deletions: result.deletions,
      });
    }

    if (result.nextCursor) {
      await backendJsonRequest(this.deps.backendPort, 'PUT', '/calendar/sync-state', {
        account_id: acc.id,
        calendar_id: calendarId,
        sync_cursor: result.nextCursor,
      });
    }
    return hasChanges;
  }

  /** All persisted sync cursors for an account, keyed by calendar id. */
  private async getSyncCursors(accountId: string): Promise<Map<string, string | null>> {
    const res = await backendJsonRequest<{
      states: Array<{ calendar_id: string; sync_cursor: string | null }>;
    }>(
      this.deps.backendPort,
      'GET',
      `/calendar/sync-state?account_id=${encodeURIComponent(accountId)}`,
    );
    return new Map((res.data?.states ?? []).map((s) => [s.calendar_id, s.sync_cursor]));
  }

  /** Flush Cerebro-origin pending mutations to the provider (push-before-pull). */
  private async pushPending(acc: Account, accessToken: string): Promise<boolean> {
    const res = await backendJsonRequest<{ events: CalendarEventDTO[] }>(
      this.deps.backendPort,
      'GET',
      `/calendar/events/pending?account_id=${encodeURIComponent(acc.id)}`,
    );
    const pending = res.data?.events ?? [];
    if (!pending.length) return false;
    const provider = this.getProvider(acc.provider);

    for (const ev of pending) {
      try {
        if (ev.sync_status === 'pending_delete') {
          if (ev.provider_event_id) {
            await provider.deleteEvent({
              accessToken,
              calendarId: ev.calendar_id,
              providerEventId: ev.provider_event_id,
            });
          }
          await backendJsonRequest(this.deps.backendPort, 'DELETE', `/calendar/events/${ev.id}`);
        } else if (ev.provider_event_id) {
          const w = await provider.updateEvent({
            accessToken,
            calendarId: ev.calendar_id,
            providerEventId: ev.provider_event_id,
            event: dtoToWrite(ev),
          });
          await this.markPushed(ev.id, w.providerEventId, w.etag);
        } else {
          const w = await provider.createEvent({
            accessToken,
            calendarId: ev.calendar_id,
            event: dtoToWrite(ev),
          });
          await this.markPushed(ev.id, w.providerEventId, w.etag);
        }
      } catch (err) {
        console.error(`[Calendar] push failed for event ${ev.id}:`, err);
      }
    }
    return true;
  }

  private async markPushed(
    eventId: string,
    providerEventId: string,
    etag: string | null,
  ): Promise<void> {
    const q = new URLSearchParams({ provider_event_id: providerEventId });
    if (etag) q.set('etag', etag);
    await backendJsonRequest(
      this.deps.backendPort,
      'POST',
      `/calendar/events/${eventId}/pushed?${q.toString()}`,
    );
  }

  // ── Direct UI mutations (CalendarChannel + IPC) ─────────────────────────────

  async createEvent(
    input: CalendarEventInput,
  ): Promise<{ ok: boolean; event?: CalendarEventDTO; error?: string }> {
    // Local calendar (explicit or because no provider is connected): store on
    // device, never push to a provider.
    const acc =
      input.account_id === LOCAL_CALENDAR_ACCOUNT_ID ? null : this.resolveAccount(input.account_id);
    if (!acc) {
      return this.createLocalEvent(input);
    }
    const calendarId = input.calendar_id ?? acc.primaryCalendarId ?? 'primary';
    try {
      const accessToken = await this.getValidAccessToken(acc);
      const provider = this.getProvider(acc.provider);
      const write = inputToWrite(input);
      await provider.createEvent({ accessToken, calendarId, event: write });
      // Pull the calendar so the new event lands normalized in the store.
      void this.syncAccount(acc).then(() => this.emitChanged());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async createLocalEvent(
    input: CalendarEventInput,
  ): Promise<{ ok: boolean; error?: string }> {
    const tz = input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const body = {
      calendar_id: input.calendar_id ?? LOCAL_CALENDAR_ID,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      start_utc: new Date(input.start).toISOString(),
      end_utc: new Date(input.end).toISOString(),
      start_tz: tz,
      all_day: input.all_day ?? false,
      attendees: (input.attendees ?? []).map((email) => ({ email })),
      visibility: input.visibility ?? 'default',
      transparency: input.busy === false ? 'transparent' : 'opaque',
      color: input.color ?? null,
    };
    const r = await backendJsonRequest(this.deps.backendPort, 'POST', '/calendar/events', body);
    this.emitChanged();
    return r.ok ? { ok: true } : { ok: false, error: 'Failed to create local event' };
  }

  async updateEvent(
    eventId: string,
    patch: Partial<CalendarEventInput>,
  ): Promise<{ ok: boolean; event?: CalendarEventDTO; error?: string }> {
    try {
      const ev = await this.fetchEvent(eventId);
      if (!ev) return { ok: false, error: 'Event not found' };
      if (isLocalEvent(ev)) {
        const r = await backendJsonRequest(
          this.deps.backendPort,
          'PATCH',
          `/calendar/events/${eventId}`,
          patchToBackend(patch),
        );
        this.emitChanged();
        return r.ok ? { ok: true } : { ok: false, error: 'Failed to update local event' };
      }
      const acc = this.accounts.get(ev.account_id);
      if (!acc) return { ok: false, error: 'Account not found' };
      const accessToken = await this.getValidAccessToken(acc);
      const provider = this.getProvider(acc.provider);
      if (!ev.provider_event_id) return { ok: false, error: 'Event has no provider id yet' };
      await provider.updateEvent({
        accessToken,
        calendarId: ev.calendar_id,
        providerEventId: ev.provider_event_id,
        event: dtoToWrite(applyPatch(ev, patch)),
      });
      void this.syncAccount(acc).then(() => this.emitChanged());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteEvent(eventId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const ev = await this.fetchEvent(eventId);
      if (!ev) return { ok: false, error: 'Event not found' };
      // Provider events: remove at the provider first (local events skip this).
      if (!isLocalEvent(ev) && ev.provider_event_id) {
        const acc = this.accounts.get(ev.account_id);
        if (acc) {
          const accessToken = await this.getValidAccessToken(acc);
          const provider = this.getProvider(acc.provider);
          await provider.deleteEvent({
            accessToken,
            calendarId: ev.calendar_id,
            providerEventId: ev.provider_event_id,
          });
        }
      }
      await backendJsonRequest(this.deps.backendPort, 'DELETE', `/calendar/events/${eventId}`);
      this.emitChanged();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async rsvp(eventId: string, response: RsvpResponse): Promise<{ ok: boolean; error?: string }> {
    try {
      const ev = await this.fetchEvent(eventId);
      if (!ev) return { ok: false, error: 'Event not found' };
      const acc = this.accounts.get(ev.account_id);
      if (!acc || !ev.provider_event_id) return { ok: false, error: 'Cannot RSVP to this event' };
      const accessToken = await this.getValidAccessToken(acc);
      const provider = this.getProvider(acc.provider);
      await provider.setRsvp({
        accessToken,
        calendarId: ev.calendar_id,
        providerEventId: ev.provider_event_id,
        response,
        selfEmail: acc.email,
      });
      void this.syncAccount(acc).then(() => this.emitChanged());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private resolveAccount(accountId?: string): Account | null {
    if (accountId) return this.accounts.get(accountId) ?? null;
    for (const a of this.accounts.values()) {
      if (a.status === 'connected') return a;
    }
    return null;
  }

  private async fetchEvent(eventId: string): Promise<CalendarEventDTO | null> {
    const res = await backendJsonRequest<CalendarEventDTO>(
      this.deps.backendPort,
      'GET',
      `/calendar/events/${encodeURIComponent(eventId)}`,
    );
    return res.ok ? res.data : null;
  }

  // ── Command bar + AI ─────────────────────────────────────────────────────

  /** Parse a natural-language command into a calendar action via Claude Code. */
  async parseCommand(
    text: string,
  ): Promise<{ ok: boolean; command?: CalendarParsedCommand; error?: string }> {
    return parseCalendarCommand(text, { queryEvents: (o) => this.queryEvents(o) });
  }

  /** Summarize the user's day/week via Claude Code. */
  async aiSummary(input: {
    range: 'day' | 'week' | 'month';
    startISO: string;
  }): Promise<{ ok: boolean; text?: string; error?: string }> {
    return summarizeCalendar(input.range, input.startISO, {
      queryEvents: (o) => this.queryEvents(o),
    });
  }

  // ── Read queries (CalendarChannel) ──────────────────────────────────────────

  async queryEvents(opts: { startISO: string; endISO: string }): Promise<CalendarEventDTO[]> {
    const q = new URLSearchParams({ start: opts.startISO, end: opts.endISO });
    const res = await backendJsonRequest<{ events: CalendarEventDTO[] }>(
      this.deps.backendPort,
      'GET',
      `/calendar/events?${q.toString()}`,
    );
    return res.data?.events ?? [];
  }

  /** Find open slots of `durationMins` between startISO/endISO, honoring busy events. */
  async findFreeTime(opts: {
    durationMins: number;
    startISO: string;
    endISO: string;
    workdayStartHour?: number;
    workdayEndHour?: number;
  }): Promise<FreeSlot[]> {
    const events = await this.queryEvents({ startISO: opts.startISO, endISO: opts.endISO });
    const busy = events
      .filter(
        (e) =>
          e.transparency !== 'transparent' && e.status !== 'cancelled' && e.start_utc && e.end_utc,
      )
      .map((e) => ({
        start: new Date(e.start_utc!).getTime(),
        end: new Date(e.end_utc!).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    const dayStart = opts.workdayStartHour ?? 9;
    const dayEnd = opts.workdayEndHour ?? 18;
    const durationMs = opts.durationMins * 60_000;
    const slots: FreeSlot[] = [];
    const rangeStart = new Date(opts.startISO);
    const rangeEnd = new Date(opts.endISO);

    for (let d = new Date(rangeStart); d <= rangeEnd; d.setDate(d.getDate() + 1)) {
      const winStart = new Date(d);
      winStart.setHours(dayStart, 0, 0, 0);
      const winEnd = new Date(d);
      winEnd.setHours(dayEnd, 0, 0, 0);
      let cursor = Math.max(winStart.getTime(), rangeStart.getTime(), Date.now());
      const end = Math.min(winEnd.getTime(), rangeEnd.getTime());
      const dayBusy = busy.filter((b) => b.end > cursor && b.start < end);
      for (const b of dayBusy) {
        if (b.start - cursor >= durationMs) {
          slots.push({
            startISO: new Date(cursor).toISOString(),
            endISO: new Date(cursor + durationMs).toISOString(),
          });
        }
        cursor = Math.max(cursor, b.end);
      }
      if (end - cursor >= durationMs) {
        slots.push({
          startISO: new Date(cursor).toISOString(),
          endISO: new Date(cursor + durationMs).toISOString(),
        });
      }
      if (slots.length >= 10) break;
    }
    return slots.slice(0, 10);
  }

  // ── Events-changed notification ─────────────────────────────────────────────

  private emitChanged(): void {
    // Broadcast to every open window rather than a single stored webContents —
    // the bridge is created after the window, so a stored reference can be stale
    // or unset. This guarantees the Calendar screen refreshes immediately after
    // a create/edit/delete or a background sync tick.
    try {
      if (this.webContents && !this.webContents.isDestroyed()) {
        this.webContents.send(IPC_CHANNELS.CALENDAR_EVENTS_CHANGED);
        return;
      }
    } catch {
      /* fall through to broadcast */
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.CALENDAR_EVENTS_CHANGED);
    }
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────────

function toAccountInfo(acc: Account): CalendarAccountInfo {
  return {
    id: acc.id,
    provider: acc.provider,
    email: acc.email,
    display_name: acc.displayName,
    primary_calendar_id: acc.primaryCalendarId,
    calendars: acc.calendars,
    status: acc.status,
    last_error: acc.lastError,
    last_synced_at: acc.lastSyncedAt,
  };
}

/** A local (on-device) event — stored in the backend, never pushed to a provider. */
function isLocalEvent(ev: CalendarEventDTO): boolean {
  return (
    ev.account_id === LOCAL_CALENDAR_ACCOUNT_ID ||
    (!ev.provider_event_id && ev.origin === 'cerebro')
  );
}

/** Map a UI patch to the backend CalendarEventUpdate body. */
function patchToBackend(patch: Partial<CalendarEventInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.start !== undefined) body.start_utc = new Date(patch.start).toISOString();
  if (patch.end !== undefined) body.end_utc = new Date(patch.end).toISOString();
  if (patch.tz !== undefined) body.start_tz = patch.tz;
  if (patch.all_day !== undefined) body.all_day = patch.all_day;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.visibility !== undefined) body.visibility = patch.visibility;
  if (patch.busy !== undefined) body.transparency = patch.busy ? 'opaque' : 'transparent';
  if (patch.color !== undefined) body.color = patch.color;
  return body;
}

function inputToWrite(input: CalendarEventInput): ProviderEventWrite {
  const tz = input.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    startUtc: new Date(input.start).toISOString(),
    endUtc: new Date(input.end).toISOString(),
    tz,
    allDay: input.all_day ?? false,
    attendees: input.attendees,
    visibility: input.visibility,
    transparency: input.busy === false ? 'transparent' : 'opaque',
    conference: input.conference,
  };
}

function dtoToWrite(ev: CalendarEventDTO): ProviderEventWrite {
  return {
    title: ev.title ?? '(no title)',
    description: ev.description,
    location: ev.location,
    startUtc: ev.start_utc ?? new Date().toISOString(),
    endUtc: ev.end_utc ?? ev.start_utc ?? new Date().toISOString(),
    tz: ev.start_tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    allDay: ev.all_day,
    attendees: ev.attendees?.map((a) => a.email).filter(Boolean),
    visibility: ev.visibility,
    transparency: ev.transparency,
  };
}

function applyPatch(ev: CalendarEventDTO, patch: Partial<CalendarEventInput>): CalendarEventDTO {
  return {
    ...ev,
    title: patch.title ?? ev.title,
    description: patch.description ?? ev.description,
    location: patch.location ?? ev.location,
    start_utc: patch.start ? new Date(patch.start).toISOString() : ev.start_utc,
    end_utc: patch.end ? new Date(patch.end).toISOString() : ev.end_utc,
    start_tz: patch.tz ?? ev.start_tz,
    all_day: patch.all_day ?? ev.all_day,
    transparency:
      patch.busy === undefined ? ev.transparency : patch.busy ? 'opaque' : 'transparent',
    visibility: patch.visibility ?? ev.visibility,
  };
}
