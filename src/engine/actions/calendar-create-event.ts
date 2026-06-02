/**
 * calendar_create_event — create an event on a connected calendar (Google /
 * Outlook) via the CalendarBridge. Times are ISO 8601; the command bar / chat
 * agent resolves natural language ("tomorrow at 2") to concrete instants before
 * calling this. Externally visible (emails attendees) → approval-gated.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { CalendarChannel } from './calendar-channel';
import type { CalendarEventInput } from '../../types/calendar';

interface CreateParams {
  title: string;
  start: string;
  end: string;
  tz?: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  attendees?: string[] | string;
  busy?: boolean;
  visibility?: 'default' | 'public' | 'private';
  conference?: boolean;
  calendar_id?: string;
}

function toAttendees(v: string[] | string | undefined, vars: Record<string, unknown>): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : renderTemplate(v, vars).split(',');
  return arr.map((s) => s.trim()).filter(Boolean);
}

export function createCalendarCreateEventAction(deps: {
  getChannel: () => CalendarChannel | null;
}): ActionDefinition {
  return {
    type: 'calendar_create_event',
    name: 'Calendar: Create Event',
    description: 'Create an event on a connected calendar.',

    chatExposable: true,
    chatGroup: 'calendar',
    chatLabel: { en: 'Create calendar event', es: 'Crear evento de calendario' },
    chatDescription: {
      en: 'Add an event to your calendar with a title, start/end time, optional attendees, location, and video link.',
      es: 'Agrega un evento a tu calendario con título, hora de inicio/fin, invitados opcionales, ubicación y enlace de video.',
    },
    chatExamples: [
      { en: 'Create a meeting with John tomorrow at 2pm for 30 minutes.', es: 'Crea una reunión con John mañana a las 2pm por 30 minutos.' },
      { en: 'Put "Dentist" on my calendar Friday at 9am.', es: 'Agenda "Dentista" el viernes a las 9am.' },
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
        title: { type: 'string', description: 'Event title. Templated.' },
        start: { type: 'string', description: 'Start time, ISO 8601 (e.g. 2026-06-03T14:00:00). Templated.' },
        end: { type: 'string', description: 'End time, ISO 8601. Templated.' },
        tz: { type: 'string', description: 'IANA time zone (defaults to the system zone).' },
        all_day: { type: 'boolean' },
        location: { type: 'string' },
        description: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses.' },
        busy: { type: 'boolean', description: 'Show as busy (default true) vs free.' },
        visibility: { type: 'string', enum: ['default', 'public', 'private'] },
        conference: { type: 'boolean', description: 'Add a video conferencing link.' },
        calendar_id: { type: 'string', description: 'Target calendar id (defaults to the primary calendar).' },
      },
      required: ['title', 'start', 'end'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        created: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Calendar: Create Event — no calendar connected. Connect one in Integrations first.');
      const params = input.params as unknown as CreateParams;
      const vars = input.wiredInputs ?? {};

      const title = renderTemplate(params.title ?? '', vars).trim();
      const start = renderTemplate(params.start ?? '', vars).trim();
      const end = renderTemplate(params.end ?? '', vars).trim();
      if (!title) throw new Error('Calendar: Create Event — title is empty.');
      if (!start || !end) throw new Error('Calendar: Create Event — start and end are required.');

      const eventInput: CalendarEventInput = {
        title,
        start,
        end,
        tz: params.tz?.trim() || undefined,
        all_day: params.all_day,
        location: renderTemplate(params.location ?? '', vars).trim() || undefined,
        description: renderTemplate(params.description ?? '', vars).trim() || undefined,
        attendees: toAttendees(params.attendees, vars),
        busy: params.busy,
        visibility: params.visibility,
        conference: params.conference,
        calendar_id: params.calendar_id?.trim() || undefined,
      };

      const res = await channel.createEvent(eventInput);
      if (!res.ok) {
        input.context.log(`Calendar create failed: ${res.error}`);
        return { data: { created: false, error: res.error ?? 'unknown' }, summary: `Calendar create failed: ${res.error}` };
      }
      input.context.log(`Created calendar event "${title}"`);
      return { data: { created: true, error: null }, summary: `Created calendar event "${title}"` };
    },
  };
}
