/**
 * Provider-adapter seam. Each calendar provider (Google, Outlook, future ones)
 * implements this interface and normalizes its native payloads into the shared
 * NormalizedEvent shape, so the sync engine, the backend store, and the UI stay
 * provider-agnostic. Adding a provider = one new file implementing this.
 */

import type { CalendarProviderId, CalendarAttendee, RemoteCalendar } from '../../types/calendar';

export interface TokenSet {
  accessToken: string;
  /** Null when the provider doesn't return a refresh token (re-consent needed). */
  refreshToken: string | null;
  /** Epoch milliseconds at which accessToken expires. */
  expiresAt: number;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** Loopback redirect captured for this flow (http://127.0.0.1:<port>/callback). */
  redirectUri: string;
}

/** A normalized event produced by a provider adapter from a raw payload. */
export interface NormalizedEvent {
  providerEventId: string;
  etag: string | null;
  icalUid: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
  startUtc: string | null;
  endUtc: string | null;
  startTz: string | null;
  endTz: string | null;
  allDay: boolean;
  recurrence: string[] | null;
  recurringMasterId: string | null;
  attendees: CalendarAttendee[] | null;
  organizerEmail: string | null;
  rsvpStatus: string | null;
  visibility: 'default' | 'public' | 'private';
  transparency: 'opaque' | 'transparent';
  status: 'confirmed' | 'cancelled';
  conferenceUrl: string | null;
  providerUpdatedAt: string | null;
}

export interface PullResult {
  events: NormalizedEvent[];
  /** providerEventIds that were cancelled/removed remotely. */
  deletions: string[];
  /** Opaque cursor (Google syncToken / Outlook deltaLink) for the next pull. */
  nextCursor: string | null;
  /** True when the stored cursor was rejected (410 / expired) — full resync needed. */
  cursorExpired: boolean;
}

/** Fields the engine/UI supply to write an event to a provider. */
export interface ProviderEventWrite {
  title: string;
  description?: string | null;
  location?: string | null;
  /** ISO 8601 instants (UTC). */
  startUtc: string;
  endUtc: string;
  /** IANA zone the event should be expressed in. */
  tz: string;
  allDay: boolean;
  attendees?: string[];
  visibility?: 'default' | 'public' | 'private';
  transparency?: 'opaque' | 'transparent';
  /** Request a video conference link (Meet / Teams). */
  conference?: boolean;
}

export interface WriteResult {
  providerEventId: string;
  etag: string | null;
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;

  // ── OAuth ──
  buildAuthUrl(opts: { client: OAuthClient; pkceChallenge: string; state: string; loginHint?: string }): string;
  exchangeCode(opts: { client: OAuthClient; code: string; pkceVerifier: string }): Promise<TokenSet>;
  refresh(opts: { client: OAuthClient; refreshToken: string }): Promise<TokenSet>;
  getUserInfo(accessToken: string): Promise<{ email: string; name?: string }>;

  // ── Calendars ──
  listCalendars(accessToken: string): Promise<RemoteCalendar[]>;

  // ── Incremental sync (abstracts syncToken vs delta link) ──
  pullEvents(opts: {
    accessToken: string;
    calendarId: string;
    syncCursor: string | null;
    timeMin: string;
    timeMax: string;
  }): Promise<PullResult>;

  // ── Two-way push ──
  createEvent(opts: { accessToken: string; calendarId: string; event: ProviderEventWrite }): Promise<WriteResult>;
  updateEvent(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    event: ProviderEventWrite;
  }): Promise<WriteResult>;
  deleteEvent(opts: { accessToken: string; calendarId: string; providerEventId: string }): Promise<void>;
  setRsvp(opts: {
    accessToken: string;
    calendarId: string;
    providerEventId: string;
    response: string;
    selfEmail: string;
  }): Promise<void>;
}

/** Thrown when a refresh fails because the grant was revoked/expired. */
export class TokenExpiredError extends Error {
  constructor(message = 'OAuth token expired or revoked') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}
