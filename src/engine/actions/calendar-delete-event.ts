/**
 * calendar_delete_event — remove an event by id (soft-delete locally, removed at
 * the provider). Externally visible → approval-gated.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { CalendarChannel } from './calendar-channel';

interface DeleteParams {
  event_id: string;
}

export function createCalendarDeleteEventAction(deps: {
  getChannel: () => CalendarChannel | null;
}): ActionDefinition {
  return {
    type: 'calendar_delete_event',
    name: 'Calendar: Delete Event',
    description: 'Delete a calendar event by id.',

    chatExposable: true,
    chatGroup: 'calendar',
    chatLabel: { en: 'Delete calendar event', es: 'Eliminar evento de calendario' },
    chatDescription: {
      en: 'Cancel and remove an event from your calendar by id (guests are notified).',
      es: 'Cancela y elimina un evento de tu calendario por id (se notifica a los invitados).',
    },
    chatExamples: [
      { en: 'Cancel my 4pm meeting today.', es: 'Cancela mi reunión de las 4pm de hoy.' },
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
        event_id: { type: 'string', description: 'Id of the event to delete (from calendar_query_events).' },
      },
      required: ['event_id'],
    },

    outputSchema: {
      type: 'object',
      properties: { deleted: { type: 'boolean' }, error: { type: ['string', 'null'] } },
      required: ['deleted'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Calendar: Delete Event — no calendar connected.');
      const params = input.params as unknown as DeleteParams;
      const eventId = renderTemplate(params.event_id ?? '', input.wiredInputs ?? {}).trim();
      if (!eventId) throw new Error('Calendar: Delete Event — event_id is required.');

      const res = await channel.deleteEvent(eventId);
      if (!res.ok) {
        input.context.log(`Calendar delete failed: ${res.error}`);
        return { data: { deleted: false, error: res.error ?? 'unknown' }, summary: `Calendar delete failed: ${res.error}` };
      }
      input.context.log(`Deleted calendar event ${eventId}`);
      return { data: { deleted: true, error: null }, summary: 'Deleted calendar event' };
    },
  };
}
