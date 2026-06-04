import { describe, it, expect } from 'vitest';
import { expandEventsForWindow } from './recurrence';
import type { CalendarEventDTO } from '../types/calendar';

function ev(partial: Partial<CalendarEventDTO>): CalendarEventDTO {
  return {
    id: 'e1',
    account_id: 'a1',
    calendar_id: 'primary',
    provider_event_id: 'p1',
    etag: null,
    ical_uid: null,
    title: 'Event',
    description: null,
    location: null,
    start_utc: null,
    end_utc: null,
    start_tz: null,
    end_tz: null,
    all_day: false,
    recurrence: null,
    recurring_master_id: null,
    attendees: null,
    organizer_email: null,
    rsvp_status: null,
    visibility: 'default',
    transparency: 'opaque',
    status: 'confirmed',
    conference_url: null,
    provider_updated_at: null,
    origin: 'provider',
    sync_status: 'synced',
    conflict: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...partial,
  };
}

const WIN_START = Date.parse('2026-06-01T00:00:00Z'); // Monday
const WIN_END = Date.parse('2026-06-08T00:00:00Z'); // next Monday

describe('expandEventsForWindow', () => {
  it('passes through a single non-recurring event in window', () => {
    const out = expandEventsForWindow(
      [ev({ start_utc: '2026-06-03T09:00:00Z', end_utc: '2026-06-03T09:30:00Z' })],
      WIN_START,
      WIN_END,
    );
    expect(out).toHaveLength(1);
    expect(out[0].recurring).toBe(false);
    expect(out[0].key).toBe('e1');
  });

  it('excludes events outside the window', () => {
    const out = expandEventsForWindow(
      [ev({ start_utc: '2026-05-01T09:00:00Z', end_utc: '2026-05-01T09:30:00Z' })],
      WIN_START,
      WIN_END,
    );
    expect(out).toHaveLength(0);
  });

  it('excludes cancelled events', () => {
    const out = expandEventsForWindow(
      [
        ev({
          status: 'cancelled',
          start_utc: '2026-06-03T09:00:00Z',
          end_utc: '2026-06-03T09:30:00Z',
        }),
      ],
      WIN_START,
      WIN_END,
    );
    expect(out).toHaveLength(0);
  });

  it('expands a daily RRULE across the window', () => {
    const out = expandEventsForWindow(
      [
        ev({
          start_utc: '2026-06-01T08:00:00Z',
          end_utc: '2026-06-01T08:15:00Z',
          recurrence: ['RRULE:FREQ=DAILY'],
        }),
      ],
      WIN_START,
      WIN_END,
    );
    // 7 days in the window (Jun 1..7).
    expect(out.length).toBe(7);
    expect(out.every((o) => o.recurring)).toBe(true);
    // distinct keys per instance
    expect(new Set(out.map((o) => o.key)).size).toBe(7);
  });

  it('expands a weekly BYDAY RRULE to the listed weekdays', () => {
    // Mondays & Wednesdays. Window Jun 1 (Mon) .. Jun 7 (Sun) → Jun 1, 3.
    const out = expandEventsForWindow(
      [
        ev({
          start_utc: '2026-06-01T10:00:00Z',
          end_utc: '2026-06-01T10:30:00Z',
          recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'],
        }),
      ],
      WIN_START,
      WIN_END,
    );
    const days = out.map((o) => new Date(o.startMs).getUTCDate()).sort((a, b) => a - b);
    expect(days).toEqual([1, 3]);
  });

  it('honors COUNT on a daily rule', () => {
    const out = expandEventsForWindow(
      [
        ev({
          start_utc: '2026-06-01T08:00:00Z',
          end_utc: '2026-06-01T08:15:00Z',
          recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
        }),
      ],
      WIN_START,
      WIN_END,
    );
    expect(out.length).toBe(3);
  });

  it('suppresses a generated instance when an override exists at that instant', () => {
    const master = ev({
      id: 'master',
      provider_event_id: 'series-1',
      start_utc: '2026-06-01T08:00:00Z',
      end_utc: '2026-06-01T08:30:00Z',
      recurrence: ['RRULE:FREQ=DAILY'],
    });
    const override = ev({
      id: 'override',
      provider_event_id: 'inst-2',
      recurring_master_id: 'series-1',
      title: 'Moved instance',
      start_utc: '2026-06-02T08:00:00Z',
      end_utc: '2026-06-02T08:30:00Z',
    });
    const out = expandEventsForWindow([master, override], WIN_START, WIN_END);
    // The Jun 2 generated occurrence is replaced by the override (one entry at that time).
    const jun2 = out.filter((o) => new Date(o.startMs).getUTCDate() === 2);
    expect(jun2).toHaveLength(1);
    expect(jun2[0].event.id).toBe('override');
  });
});
