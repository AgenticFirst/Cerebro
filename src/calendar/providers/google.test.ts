import { describe, it, expect, vi, afterEach } from 'vitest';

// google.ts pulls in shared/oauth, which imports `electron` for
// shell.openExternal; stub it for the node env.
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));

import { GoogleCalendarProvider } from './google';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const provider = new GoogleCalendarProvider();

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoogleCalendarProvider.pullEvents', () => {
  it('normalizes a timed event and surfaces the next sync cursor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 'evt1',
              etag: '"abc"',
              status: 'confirmed',
              summary: 'Standup',
              location: 'Room 4',
              start: { dateTime: '2026-06-03T09:00:00-04:00', timeZone: 'America/New_York' },
              end: { dateTime: '2026-06-03T09:30:00-04:00', timeZone: 'America/New_York' },
              attendees: [{ email: 'me@x.com', responseStatus: 'accepted', self: true }],
              organizer: { email: 'me@x.com' },
              transparency: 'opaque',
              updated: '2026-06-01T12:00:00Z',
            },
          ],
          nextSyncToken: 'TOKEN123',
        }),
      ),
    );

    const res = await provider.pullEvents({
      accessToken: 'a',
      calendarId: 'primary',
      syncCursor: null,
      timeMin: '2026-06-01T00:00:00Z',
      timeMax: '2026-06-30T00:00:00Z',
    });

    expect(res.cursorExpired).toBe(false);
    expect(res.nextCursor).toBe('TOKEN123');
    expect(res.events).toHaveLength(1);
    const e = res.events[0];
    expect(e.providerEventId).toBe('evt1');
    expect(e.title).toBe('Standup');
    expect(e.startTz).toBe('America/New_York');
    // -04:00 09:00 → 13:00Z
    expect(e.startUtc).toBe('2026-06-03T13:00:00.000Z');
    expect(e.rsvpStatus).toBe('accepted');
    expect(e.transparency).toBe('opaque');
  });

  it('routes cancelled events into deletions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [{ id: 'gone1', status: 'cancelled' }],
          nextSyncToken: 'TOK',
        }),
      ),
    );
    const res = await provider.pullEvents({
      accessToken: 'a',
      calendarId: 'primary',
      syncCursor: 'prev',
      timeMin: '',
      timeMax: '',
    });
    expect(res.deletions).toEqual(['gone1']);
    expect(res.events).toHaveLength(0);
  });

  it('reports cursorExpired on a 410 from an expired syncToken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Sync token expired', { status: 410 })),
    );
    const res = await provider.pullEvents({
      accessToken: 'a',
      calendarId: 'primary',
      syncCursor: 'staleToken',
      timeMin: '2026-06-01T00:00:00Z',
      timeMax: '2026-06-30T00:00:00Z',
    });
    expect(res.cursorExpired).toBe(true);
    expect(res.nextCursor).toBeNull();
  });

  it('treats an all-day event as all_day with date-only start', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: 'allday',
              status: 'confirmed',
              summary: 'Holiday',
              start: { date: '2026-06-04' },
              end: { date: '2026-06-05' },
            },
          ],
          nextSyncToken: 'TOK',
        }),
      ),
    );
    const res = await provider.pullEvents({
      accessToken: 'a',
      calendarId: 'primary',
      syncCursor: null,
      timeMin: '',
      timeMax: '',
    });
    expect(res.events[0].allDay).toBe(true);
    expect(res.events[0].startUtc).toBe('2026-06-04T00:00:00.000Z');
  });
});
