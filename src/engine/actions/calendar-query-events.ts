/**
 * calendar_query_events — read events in a time window across all connected
 * calendars. Powers "what does my week look like" and resolves which event a
 * follow-up action ("move my 3pm") should target (returns ids).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { CalendarChannel } from './calendar-channel';

interface QueryParams {
  start: string;
  end: string;
}

export function createCalendarQueryEventsAction(deps: {
  getChannel: () => CalendarChannel | null;
}): ActionDefinition {
  return {
    type: 'calendar_query_events',
    name: 'Calendar: Query Events',
    description: 'List calendar events within a time window.',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'calendar',
    chatLabel: { en: 'Look up calendar events', es: 'Consultar eventos del calendario' },
    chatDescription: {
      en: 'Read your events between two times (to summarize a day/week or find a specific meeting).',
      es: 'Lee tus eventos entre dos horas (para resumir un día/semana o encontrar una reunión específica).',
    },
    chatExamples: [
      { en: 'What does my week look like?', es: '¿Cómo se ve mi semana?' },
      { en: "What's on my calendar tomorrow?", es: '¿Qué tengo en el calendario mañana?' },
    ],
    availabilityCheck: () => {
      // Available whenever the bridge exists — the local calendar works without
      // any connected provider.
      return deps.getChannel() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#calendar',

    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Window start, ISO 8601.' },
        end: { type: 'string', description: 'Window end, ISO 8601.' },
      },
      required: ['start', 'end'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        events: { type: 'array' },
      },
      required: ['count', 'events'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Calendar: Query Events — no calendar connected.');
      const params = input.params as unknown as QueryParams;
      const vars = input.wiredInputs ?? {};
      const start = renderTemplate(params.start ?? '', vars).trim();
      const end = renderTemplate(params.end ?? '', vars).trim();
      if (!start || !end) throw new Error('Calendar: Query Events — start and end are required.');

      const events = await channel.queryEvents({ startISO: start, endISO: end });
      // Trim to the fields the agent needs (id for follow-ups; no secrets).
      const slim = events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start_utc,
        end: e.end_utc,
        all_day: e.all_day,
        location: e.location,
        attendees: e.attendees?.map((a) => a.email) ?? [],
        busy: e.transparency !== 'transparent',
        rsvp: e.rsvp_status,
      }));
      return {
        data: { count: slim.length, events: slim },
        summary: `Found ${slim.length} event${slim.length === 1 ? '' : 's'}`,
      };
    },
  };
}
