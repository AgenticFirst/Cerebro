/**
 * calendar_update_event — edit or move an existing event by id. Also covers
 * "move my 3pm to Friday" (the command bar resolves the event id + new times).
 * Externally visible → approval-gated.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { CalendarChannel } from './calendar-channel';
import type { CalendarEventInput } from '../../types/calendar';

interface UpdateParams {
  event_id: string;
  title?: string;
  start?: string;
  end?: string;
  tz?: string;
  location?: string;
  description?: string;
  busy?: boolean;
  visibility?: 'default' | 'public' | 'private';
}

export function createCalendarUpdateEventAction(deps: {
  getChannel: () => CalendarChannel | null;
}): ActionDefinition {
  return {
    type: 'calendar_update_event',
    name: 'Calendar: Update Event',
    description: 'Edit or reschedule an existing calendar event by id.',

    chatExposable: true,
    chatGroup: 'calendar',
    chatLabel: { en: 'Edit or move calendar event', es: 'Editar o mover evento de calendario' },
    chatDescription: {
      en: 'Change the time, title, location, or other details of an existing event. Use to reschedule ("move my 3pm to Friday").',
      es: 'Cambia la hora, título, ubicación u otros detalles de un evento existente. Úsalo para reprogramar ("mueve mi reunión de las 3 al viernes").',
    },
    chatExamples: [
      {
        en: 'Move my 3pm meeting to Friday at the same time.',
        es: 'Mueve mi reunión de las 3pm al viernes a la misma hora.',
      },
      { en: 'Rename the standup to "Daily sync".', es: 'Renombra el standup a "Daily sync".' },
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
        event_id: {
          type: 'string',
          description: 'Id of the event to update (from calendar_query_events).',
        },
        title: { type: 'string' },
        start: { type: 'string', description: 'New start, ISO 8601.' },
        end: { type: 'string', description: 'New end, ISO 8601.' },
        tz: { type: 'string' },
        location: { type: 'string' },
        description: { type: 'string' },
        busy: { type: 'boolean' },
        visibility: { type: 'string', enum: ['default', 'public', 'private'] },
      },
      required: ['event_id'],
    },

    outputSchema: {
      type: 'object',
      properties: { updated: { type: 'boolean' }, error: { type: ['string', 'null'] } },
      required: ['updated'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Calendar: Update Event — no calendar connected.');
      const params = input.params as unknown as UpdateParams;
      const vars = input.wiredInputs ?? {};
      const eventId = renderTemplate(params.event_id ?? '', vars).trim();
      if (!eventId) throw new Error('Calendar: Update Event — event_id is required.');

      const patch: Partial<CalendarEventInput> = {};
      const title = renderTemplate(params.title ?? '', vars).trim();
      if (title) patch.title = title;
      const start = renderTemplate(params.start ?? '', vars).trim();
      if (start) patch.start = start;
      const end = renderTemplate(params.end ?? '', vars).trim();
      if (end) patch.end = end;
      if (params.tz) patch.tz = params.tz.trim();
      const location = renderTemplate(params.location ?? '', vars).trim();
      if (location) patch.location = location;
      const description = renderTemplate(params.description ?? '', vars).trim();
      if (description) patch.description = description;
      if (typeof params.busy === 'boolean') patch.busy = params.busy;
      if (params.visibility) patch.visibility = params.visibility;

      const res = await channel.updateEvent(eventId, patch);
      if (!res.ok) {
        input.context.log(`Calendar update failed: ${res.error}`);
        return {
          data: { updated: false, error: res.error ?? 'unknown' },
          summary: `Calendar update failed: ${res.error}`,
        };
      }
      input.context.log(`Updated calendar event ${eventId}`);
      return { data: { updated: true, error: null }, summary: `Updated calendar event` };
    },
  };
}
