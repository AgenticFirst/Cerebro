/**
 * Minimal interface the calendar engine actions depend on, implemented by
 * CalendarBridge (main process). Mirrors hubspot-channel.ts — keeps the actions
 * decoupled from the bridge's internals and easy to stub in tests.
 */

import type {
  CalendarAccountInfo,
  CalendarEventDTO,
  CalendarEventInput,
  RsvpResponse,
} from '../../types/calendar';

export interface FreeSlot {
  startISO: string;
  endISO: string;
}

export interface CalendarChannel {
  isConnected(): boolean;
  listAccounts(): CalendarAccountInfo[];
  createEvent(
    input: CalendarEventInput,
  ): Promise<{ ok: boolean; event?: CalendarEventDTO; error?: string }>;
  updateEvent(
    eventId: string,
    patch: Partial<CalendarEventInput>,
  ): Promise<{ ok: boolean; event?: CalendarEventDTO; error?: string }>;
  deleteEvent(eventId: string): Promise<{ ok: boolean; error?: string }>;
  rsvp(eventId: string, response: RsvpResponse): Promise<{ ok: boolean; error?: string }>;
  /** Read normalized events in a UTC window (for summaries + "move my 3pm"). */
  queryEvents(opts: { startISO: string; endISO: string }): Promise<CalendarEventDTO[]>;
  /** Compute open slots of a given length across all busy events in a window. */
  findFreeTime(opts: {
    durationMins: number;
    startISO: string;
    endISO: string;
    workdayStartHour?: number;
    workdayEndHour?: number;
  }): Promise<FreeSlot[]>;
}
