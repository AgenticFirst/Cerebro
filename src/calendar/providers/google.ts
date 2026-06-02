/**
 * Google Calendar provider adapter (Calendar API v3).
 *
 * Incremental sync uses `syncToken`; an expired token returns HTTP 410, which we
 * surface as `cursorExpired` so the engine does a windowed full resync. Events
 * are fetched with `singleEvents=false` so recurring masters keep their RRULE
 * (the client expands them for the visible range).
 */

import type {
  CalendarProvider,
  NormalizedEvent,
  OAuthClient,
  ProviderEventWrite,
  PullResult,
  TokenSet,
  WriteResult,
} from './types';
import { ProviderHttpError, oauthTokenRequest, providerFetch } from './http';
import type { CalendarAttendee, RemoteCalendar } from '../../types/calendar';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const API_BASE = 'https://www.googleapis.com/calendar/v3';
const SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar';

interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
    organizer?: boolean;
    self?: boolean;
  }>;
  organizer?: { email?: string };
  visibility?: string;
  transparency?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri?: string; entryPointType?: string }> };
  updated?: string;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly id = 'google' as const;

  buildAuthUrl(opts: { client: OAuthClient; pkceChallenge: string; state: string; loginHint?: string }): string {
    const p = new URLSearchParams({
      client_id: opts.client.clientId,
      redirect_uri: opts.client.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: opts.pkceChallenge,
      code_challenge_method: 'S256',
      state: opts.state,
      access_type: 'offline',
      prompt: 'consent',
    });
    if (opts.loginHint) p.set('login_hint', opts.loginHint);
    return `${AUTH_URL}?${p.toString()}`;
  }

  async exchangeCode(opts: { client: OAuthClient; code: string; pkceVerifier: string }): Promise<TokenSet> {
    const body = new URLSearchParams({
      code: opts.code,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      redirect_uri: opts.client.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: opts.pkceVerifier,
    });
    return tokenRequest(body);
  }

  async refresh(opts: { client: OAuthClient; refreshToken: string }): Promise<TokenSet> {
    const body = new URLSearchParams({
      refresh_token: opts.refreshToken,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      grant_type: 'refresh_token',
    });
    const tokens = await tokenRequest(body);
    // Google omits refresh_token on refresh — keep the existing one.
    if (!tokens.refreshToken) tokens.refreshToken = opts.refreshToken;
    return tokens;
  }

  async getUserInfo(accessToken: string): Promise<{ email: string; name?: string }> {
    const r = await apiGet<{ email?: string; name?: string }>(USERINFO_URL, accessToken);
    return { email: r.email ?? '', name: r.name };
  }

  async listCalendars(accessToken: string): Promise<RemoteCalendar[]> {
    const r = await apiGet<{ items?: Array<{ id: string; summary?: string; backgroundColor?: string; primary?: boolean; selected?: boolean }> }>(
      `${API_BASE}/users/me/calendarList`,
      accessToken,
    );
    return (r.items ?? []).map((c) => ({
      id: c.id,
      name: c.summary ?? c.id,
      color: c.backgroundColor,
      selected: c.selected !== false,
    }));
  }

  async pullEvents(opts: {
    accessToken: string;
    calendarId: string;
    syncCursor: string | null;
    timeMin: string;
    timeMax: string;
  }): Promise<PullResult> {
    const events: NormalizedEvent[] = [];
    const deletions: string[] = [];
    let pageToken: string | undefined;
    let nextCursor: string | null = null;

    do {
      const params = new URLSearchParams({
        singleEvents: 'false',
        showDeleted: 'true',
        maxResults: '250',
      });
      if (opts.syncCursor) {
        params.set('syncToken', opts.syncCursor);
      } else {
        params.set('timeMin', opts.timeMin);
        params.set('timeMax', opts.timeMax);
      }
      if (pageToken) params.set('pageToken', pageToken);

      const url = `${API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events?${params.toString()}`;
      let page: { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      try {
        page = await apiGet(url, opts.accessToken);
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status === 410) {
          return { events: [], deletions: [], nextCursor: null, cursorExpired: true };
        }
        throw err;
      }

      for (const ev of page.items ?? []) {
        if (ev.status === 'cancelled') {
          deletions.push(ev.id);
        } else {
          events.push(normalizeGoogleEvent(ev));
        }
      }
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) nextCursor = page.nextSyncToken;
    } while (pageToken);

    return { events, deletions, nextCursor, cursorExpired: false };
  }

  async createEvent(opts: { accessToken: string; calendarId: string; event: ProviderEventWrite }): Promise<WriteResult> {
    const body = toGoogleWrite(opts.event);
    const conf = opts.event.conference ? '?conferenceDataVersion=1' : '';
    const r = await apiSend<GoogleEvent>(
      `${API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events${conf}`,
      opts.accessToken,
      'POST',
      body,
    );
    return { providerEventId: r.id, etag: r.etag ?? null };
  }

  async updateEvent(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    event: ProviderEventWrite;
  }): Promise<WriteResult> {
    const body = toGoogleWrite(opts.event);
    const r = await apiSend<GoogleEvent>(
      `${API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.providerEventId)}`,
      opts.accessToken,
      'PATCH',
      body,
    );
    return { providerEventId: r.id, etag: r.etag ?? null };
  }

  async deleteEvent(opts: { accessToken: string; calendarId: string; providerEventId: string }): Promise<void> {
    await apiSend(
      `${API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.providerEventId)}`,
      opts.accessToken,
      'DELETE',
    );
  }

  async setRsvp(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    response: string;
    selfEmail: string;
  }): Promise<void> {
    // Google requires patching the attendees array with the self attendee's status.
    const current = await apiGet<GoogleEvent>(
      `${API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.providerEventId)}`,
      opts.accessToken,
    );
    const attendees = (current.attendees ?? []).map((a) =>
      a.self || a.email?.toLowerCase() === opts.selfEmail.toLowerCase()
        ? { ...a, responseStatus: opts.response }
        : a,
    );
    await apiSend(
      `${API_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events/${encodeURIComponent(opts.providerEventId)}`,
      opts.accessToken,
      'PATCH',
      { attendees },
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const tokenRequest = (body: URLSearchParams) => oauthTokenRequest(TOKEN_URL, body, 'Google');
const apiGet = <T>(url: string, accessToken: string): Promise<T> =>
  providerFetch<T>(url, accessToken, { label: 'Google API' });
const apiSend = <T = unknown>(
  url: string,
  accessToken: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> => providerFetch<T>(url, accessToken, { method, body, label: 'Google API' });

function mapResponseStatus(s?: string): CalendarAttendee['response'] {
  switch (s) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'tentative';
    default:
      return 'needsAction';
  }
}

function normalizeGoogleEvent(ev: GoogleEvent): NormalizedEvent {
  const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
  const startUtc = isoFromGoogle(ev.start);
  const endUtc = isoFromGoogle(ev.end);
  const self = (ev.attendees ?? []).find((a) => a.self);
  const conferenceUrl =
    ev.hangoutLink ??
    ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
    null;
  const visibility = ev.visibility === 'private' || ev.visibility === 'confidential'
    ? 'private'
    : ev.visibility === 'public'
      ? 'public'
      : 'default';
  return {
    providerEventId: ev.id,
    etag: ev.etag ?? null,
    icalUid: ev.iCalUID ?? null,
    title: ev.summary ?? null,
    description: ev.description ?? null,
    location: ev.location ?? null,
    startUtc,
    endUtc,
    startTz: ev.start?.timeZone ?? null,
    endTz: ev.end?.timeZone ?? null,
    allDay,
    recurrence: ev.recurrence ?? null,
    recurringMasterId: ev.recurringEventId ?? null,
    attendees: ev.attendees
      ? ev.attendees.map((a) => ({
          email: a.email ?? '',
          name: a.displayName,
          response: mapResponseStatus(a.responseStatus),
          optional: a.optional,
          organizer: a.organizer,
        }))
      : null,
    organizerEmail: ev.organizer?.email ?? null,
    rsvpStatus: self ? mapResponseStatus(self.responseStatus) ?? null : null,
    visibility,
    transparency: ev.transparency === 'transparent' ? 'transparent' : 'opaque',
    status: ev.status === 'cancelled' ? 'cancelled' : 'confirmed',
    conferenceUrl,
    providerUpdatedAt: ev.updated ?? null,
  };
}

function isoFromGoogle(slot?: { dateTime?: string; date?: string }): string | null {
  if (!slot) return null;
  if (slot.dateTime) return new Date(slot.dateTime).toISOString();
  if (slot.date) return new Date(`${slot.date}T00:00:00Z`).toISOString();
  return null;
}

function toGoogleWrite(e: ProviderEventWrite): Record<string, unknown> {
  const out: Record<string, unknown> = {
    summary: e.title,
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    visibility: e.visibility && e.visibility !== 'default' ? e.visibility : undefined,
    transparency: e.transparency === 'transparent' ? 'transparent' : undefined,
  };
  if (e.allDay) {
    out.start = { date: e.startUtc.slice(0, 10) };
    out.end = { date: e.endUtc.slice(0, 10) };
  } else {
    out.start = { dateTime: e.startUtc, timeZone: e.tz };
    out.end = { dateTime: e.endUtc, timeZone: e.tz };
  }
  if (e.attendees?.length) {
    out.attendees = e.attendees.map((email) => ({ email }));
  }
  if (e.conference) {
    out.conferenceData = {
      createRequest: { requestId: `cerebro-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
    };
  }
  return out;
}
