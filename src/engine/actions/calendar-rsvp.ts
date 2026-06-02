/**
 * calendar_rsvp — respond to a meeting invite (accept / decline / tentative).
 * Externally visible (notifies the organizer) → approval-gated.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { CalendarChannel } from './calendar-channel';
import type { RsvpResponse } from '../../types/calendar';

interface RsvpParams {
  event_id: string;
  response: string;
}

const VALID = new Set(['accepted', 'declined', 'tentative']);

export function createCalendarRsvpAction(deps: {
  getChannel: () => CalendarChannel | null;
}): ActionDefinition {
  return {
    type: 'calendar_rsvp',
    name: 'Calendar: RSVP',
    description: 'Respond to a calendar invite (accept / decline / tentative).',

    chatExposable: true,
    chatGroup: 'calendar',
    chatLabel: { en: 'RSVP to calendar invite', es: 'Responder a invitación de calendario' },
    chatDescription: {
      en: 'Set your response (yes / no / maybe) on a meeting invitation by event id.',
      es: 'Establece tu respuesta (sí / no / quizá) a una invitación de reunión por id de evento.',
    },
    chatExamples: [
      { en: 'Decline the 5pm budget review.', es: 'Rechaza la revisión de presupuesto de las 5pm.' },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#calendar',

    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'Id of the invite (from calendar_query_events).' },
        response: { type: 'string', enum: ['accepted', 'declined', 'tentative'] },
      },
      required: ['event_id', 'response'],
    },

    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, error: { type: ['string', 'null'] } },
      required: ['ok'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Calendar: RSVP — no calendar connected.');
      const params = input.params as unknown as RsvpParams;
      const vars = input.wiredInputs ?? {};
      const eventId = renderTemplate(params.event_id ?? '', vars).trim();
      const response = renderTemplate(params.response ?? '', vars).trim().toLowerCase();
      if (!eventId) throw new Error('Calendar: RSVP — event_id is required.');
      if (!VALID.has(response)) throw new Error('Calendar: RSVP — response must be accepted, declined, or tentative.');

      const res = await channel.rsvp(eventId, response as RsvpResponse);
      if (!res.ok) {
        input.context.log(`Calendar RSVP failed: ${res.error}`);
        return { data: { ok: false, error: res.error ?? 'unknown' }, summary: `Calendar RSVP failed: ${res.error}` };
      }
      input.context.log(`RSVP ${response} for event ${eventId}`);
      return { data: { ok: true, error: null }, summary: `RSVP'd ${response}` };
    },
  };
}
