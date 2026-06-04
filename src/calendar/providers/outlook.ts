/**
 * Microsoft Outlook / 365 provider adapter (Microsoft Graph).
 *
 * Incremental sync uses calendarView delta: the first call takes a time window
 * and returns a `@odata.deltaLink`; subsequent calls follow that link and report
 * changes + `@removed` tombstones. An expired delta link (410) → full resync.
 * calendarView returns recurrences pre-expanded into instances, so no
 * client-side RRULE expansion is needed for Outlook events.
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

const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES =
  'openid email profile offline_access https://graph.microsoft.com/Calendars.ReadWrite';

interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
  '@removed'?: { reason?: string };
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  seriesMasterId?: string;
  attendees?: Array<{
    emailAddress?: { address?: string; name?: string };
    status?: { response?: string };
    type?: string;
  }>;
  organizer?: { emailAddress?: { address?: string } };
  responseStatus?: { response?: string };
  sensitivity?: string;
  showAs?: string;
  onlineMeeting?: { joinUrl?: string };
  lastModifiedDateTime?: string;
}

export class OutlookCalendarProvider implements CalendarProvider {
  readonly id = 'outlook' as const;

  buildAuthUrl(opts: {
    client: OAuthClient;
    pkceChallenge: string;
    state: string;
    loginHint?: string;
  }): string {
    const p = new URLSearchParams({
      client_id: opts.client.clientId,
      redirect_uri: opts.client.redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: opts.pkceChallenge,
      code_challenge_method: 'S256',
      state: opts.state,
      response_mode: 'query',
    });
    if (opts.loginHint) p.set('login_hint', opts.loginHint);
    return `${AUTH_URL}?${p.toString()}`;
  }

  async exchangeCode(opts: {
    client: OAuthClient;
    code: string;
    pkceVerifier: string;
  }): Promise<TokenSet> {
    const body = new URLSearchParams({
      code: opts.code,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      redirect_uri: opts.client.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: opts.pkceVerifier,
      scope: SCOPES,
    });
    return tokenRequest(body);
  }

  async refresh(opts: { client: OAuthClient; refreshToken: string }): Promise<TokenSet> {
    const body = new URLSearchParams({
      refresh_token: opts.refreshToken,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      grant_type: 'refresh_token',
      scope: SCOPES,
    });
    const tokens = await tokenRequest(body);
    // Microsoft rotates the refresh token — keep the new one, fall back if absent.
    if (!tokens.refreshToken) tokens.refreshToken = opts.refreshToken;
    return tokens;
  }

  async getUserInfo(accessToken: string): Promise<{ email: string; name?: string }> {
    const me = await apiGet<{ mail?: string; userPrincipalName?: string; displayName?: string }>(
      `${GRAPH}/me`,
      accessToken,
    );
    return { email: me.mail ?? me.userPrincipalName ?? '', name: me.displayName };
  }

  async listCalendars(accessToken: string): Promise<RemoteCalendar[]> {
    const r = await apiGet<{
      value?: Array<{ id: string; name?: string; hexColor?: string; isDefaultCalendar?: boolean }>;
    }>(`${GRAPH}/me/calendars`, accessToken);
    return (r.value ?? []).map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      color: c.hexColor && c.hexColor !== 'auto' ? c.hexColor : undefined,
      selected: true,
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
    let nextCursor: string | null = null;

    let url =
      opts.syncCursor ??
      `${GRAPH}/me/calendars/${encodeURIComponent(opts.calendarId)}/calendarView/delta` +
        `?startDateTime=${encodeURIComponent(opts.timeMin)}&endDateTime=${encodeURIComponent(opts.timeMax)}`;

    // Follow nextLink pages until we reach the deltaLink.
    for (let guard = 0; guard < 50; guard += 1) {
      let page: {
        value?: GraphEvent[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      try {
        page = await apiGet(url, opts.accessToken, { Prefer: 'outlook.timezone="UTC"' });
      } catch (err) {
        if (
          err instanceof ProviderHttpError &&
          (err.status === 410 || err.status === 400) &&
          opts.syncCursor
        ) {
          return { events: [], deletions: [], nextCursor: null, cursorExpired: true };
        }
        throw err;
      }

      for (const ev of page.value ?? []) {
        if (ev['@removed'] || ev.isCancelled) {
          deletions.push(ev.id);
        } else {
          events.push(normalizeGraphEvent(ev));
        }
      }

      if (page['@odata.nextLink']) {
        url = page['@odata.nextLink'];
        continue;
      }
      if (page['@odata.deltaLink']) nextCursor = page['@odata.deltaLink'];
      break;
    }

    return { events, deletions, nextCursor, cursorExpired: false };
  }

  async createEvent(opts: {
    accessToken: string;
    calendarId: string;
    event: ProviderEventWrite;
  }): Promise<WriteResult> {
    const r = await apiSend<GraphEvent>(
      `${GRAPH}/me/calendars/${encodeURIComponent(opts.calendarId)}/events`,
      opts.accessToken,
      'POST',
      toGraphWrite(opts.event),
    );
    return { providerEventId: r.id, etag: r['@odata.etag'] ?? null };
  }

  async updateEvent(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    event: ProviderEventWrite;
  }): Promise<WriteResult> {
    const r = await apiSend<GraphEvent>(
      `${GRAPH}/me/events/${encodeURIComponent(opts.providerEventId)}`,
      opts.accessToken,
      'PATCH',
      toGraphWrite(opts.event),
    );
    return { providerEventId: r.id ?? opts.providerEventId, etag: r['@odata.etag'] ?? null };
  }

  async deleteEvent(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
  }): Promise<void> {
    await apiSend(
      `${GRAPH}/me/events/${encodeURIComponent(opts.providerEventId)}`,
      opts.accessToken,
      'DELETE',
    );
  }

  async setRsvp(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    response: string;
  }): Promise<void> {
    const action =
      opts.response === 'accepted'
        ? 'accept'
        : opts.response === 'declined'
          ? 'decline'
          : 'tentativelyAccept';
    await apiSend(
      `${GRAPH}/me/events/${encodeURIComponent(opts.providerEventId)}/${action}`,
      opts.accessToken,
      'POST',
      { sendResponse: true },
    );
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const tokenRequest = (body: URLSearchParams) => oauthTokenRequest(TOKEN_URL, body, 'Microsoft');
const apiGet = <T>(
  url: string,
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Promise<T> => providerFetch<T>(url, accessToken, { headers: extraHeaders, label: 'Graph' });
const apiSend = <T = unknown>(
  url: string,
  accessToken: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> => providerFetch<T>(url, accessToken, { method, body, label: 'Graph' });

function mapResponse(s?: string): CalendarAttendee['response'] {
  switch (s) {
    case 'accepted':
    case 'organizer':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentativelyAccepted':
      return 'tentative';
    default:
      return 'needsAction';
  }
}

/** Graph (with Prefer outlook.timezone="UTC") returns naive UTC datetimes — append Z. */
function graphIso(slot?: { dateTime?: string }): string | null {
  if (!slot?.dateTime) return null;
  const raw = slot.dateTime;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  return new Date(withZone).toISOString();
}

function normalizeGraphEvent(ev: GraphEvent): NormalizedEvent {
  const self = ev.responseStatus?.response;
  const visibility =
    ev.sensitivity === 'private' || ev.sensitivity === 'confidential' ? 'private' : 'default';
  return {
    providerEventId: ev.id,
    etag: ev['@odata.etag'] ?? null,
    icalUid: ev.iCalUId ?? null,
    title: ev.subject ?? null,
    description: ev.body?.content ?? ev.bodyPreview ?? null,
    location: ev.location?.displayName ?? null,
    startUtc: graphIso(ev.start),
    endUtc: graphIso(ev.end),
    startTz: 'UTC',
    endTz: 'UTC',
    allDay: Boolean(ev.isAllDay),
    recurrence: null, // calendarView delta returns expanded instances
    recurringMasterId: ev.seriesMasterId ?? null,
    attendees: ev.attendees
      ? ev.attendees.map((a) => ({
          email: a.emailAddress?.address ?? '',
          name: a.emailAddress?.name,
          response: mapResponse(a.status?.response),
          optional: a.type === 'optional',
        }))
      : null,
    organizerEmail: ev.organizer?.emailAddress?.address ?? null,
    rsvpStatus: self ? (mapResponse(self) ?? null) : null,
    visibility,
    transparency: ev.showAs === 'free' ? 'transparent' : 'opaque',
    status: ev.isCancelled ? 'cancelled' : 'confirmed',
    conferenceUrl: ev.onlineMeeting?.joinUrl ?? null,
    providerUpdatedAt: ev.lastModifiedDateTime ?? null,
  };
}

function toGraphWrite(e: ProviderEventWrite): Record<string, unknown> {
  const out: Record<string, unknown> = {
    subject: e.title,
    body: e.description ? { contentType: 'text', content: e.description } : undefined,
    location: e.location ? { displayName: e.location } : undefined,
    isAllDay: e.allDay,
    sensitivity: e.visibility === 'private' ? 'private' : undefined,
    showAs: e.transparency === 'transparent' ? 'free' : 'busy',
    start: { dateTime: e.startUtc.replace(/Z$/, ''), timeZone: 'UTC' },
    end: { dateTime: e.endUtc.replace(/Z$/, ''), timeZone: 'UTC' },
  };
  if (e.attendees?.length) {
    out.attendees = e.attendees.map((address) => ({ emailAddress: { address }, type: 'required' }));
  }
  if (e.conference) {
    out.isOnlineMeeting = true;
    out.onlineMeetingProvider = 'teamsForBusiness';
  }
  return out;
}
