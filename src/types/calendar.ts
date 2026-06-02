/**
 * Shared calendar types used by both the Electron main process (sync engine,
 * provider adapters, bridge) and the renderer (Calendar screen, context,
 * command palette). DTO field names mirror the backend /calendar payloads so
 * rows fetched via `window.cerebro.invoke` deserialize directly.
 */

export type CalendarProviderId = 'google' | 'outlook' | 'local';

/**
 * The built-in on-device calendar. Always present, needs no OAuth — users can
 * add and manage events without connecting Google or Outlook. Events on it are
 * stored locally (and replicate to Supabase when connected) but are never pushed
 * to an external provider.
 */
export const LOCAL_CALENDAR_ACCOUNT_ID = 'local';
export const LOCAL_CALENDAR_ID = 'local';

export type CalendarAccountStatus = 'connected' | 'token_expired' | 'error' | 'disconnected';

export type RsvpResponse = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export interface CalendarAttendee {
  email: string;
  name?: string;
  response?: RsvpResponse;
  optional?: boolean;
  organizer?: boolean;
}

/** A single calendar within a connected account. */
export interface RemoteCalendar {
  id: string;
  name: string;
  color?: string;
  /** Whether the user has this calendar visible in the unified view. */
  selected?: boolean;
}

/** Normalized event DTO — matches backend CalendarEventResponse. */
export interface CalendarEventDTO {
  id: string;
  account_id: string;
  calendar_id: string;
  provider_event_id: string | null;
  etag: string | null;
  ical_uid: string | null;
  title: string | null;
  description: string | null;
  location: string | null;
  start_utc: string | null;
  end_utc: string | null;
  start_tz: string | null;
  end_tz: string | null;
  all_day: boolean;
  recurrence: string[] | null;
  recurring_master_id: string | null;
  attendees: CalendarAttendee[] | null;
  organizer_email: string | null;
  rsvp_status: RsvpResponse | null;
  visibility: 'default' | 'public' | 'private';
  transparency: 'opaque' | 'transparent';
  status: 'confirmed' | 'cancelled';
  conference_url: string | null;
  color: string | null;
  provider_updated_at: string | null;
  origin: 'provider' | 'cerebro';
  sync_status: 'synced' | 'pending_push' | 'pending_delete' | 'error';
  conflict: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/** Account info DTO — matches backend CalendarAccountResponse. */
export interface CalendarAccountInfo {
  id: string;
  provider: CalendarProviderId;
  email: string;
  display_name: string | null;
  primary_calendar_id: string | null;
  calendars: RemoteCalendar[] | null;
  status: CalendarAccountStatus;
  last_error: string | null;
  last_synced_at: string | null;
}

/** Input the UI / agent supplies to create or edit an event. */
export interface CalendarEventInput {
  account_id?: string;
  calendar_id?: string;
  title: string;
  description?: string;
  location?: string;
  /** ISO 8601; if all_day, date-only is acceptable. */
  start: string;
  end: string;
  /** IANA zone the start/end are expressed in. Defaults to the system zone. */
  tz?: string;
  all_day?: boolean;
  attendees?: string[];
  visibility?: 'default' | 'public' | 'private';
  /** true => busy (opaque), false => free (transparent). Defaults busy. */
  busy?: boolean;
  /** Request a video conference link (Meet / Teams). */
  conference?: boolean;
  /** Hex color for the event block. */
  color?: string;
}

export interface CalendarStatus {
  connected: boolean;
  accounts: CalendarAccountInfo[];
}

/** Result of NL command-bar parsing (Claude Code maps text → a calendar action). */
export interface CalendarParsedCommand {
  /** One of the calendar_* engine action types, or 'none' if unparseable. */
  action: string;
  params: Record<string, unknown>;
  /** Short human-readable restatement of what will happen, for confirmation. */
  summary?: string;
}
