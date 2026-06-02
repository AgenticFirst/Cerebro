/**
 * calendar_find_free_time — find open slots of a given length across all busy
 * events in a window. Powers "find 30 minutes with Sarah next week" (the agent
 * supplies the window; attendee free/busy is approximated by the user's own
 * calendar for the MVP).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { CalendarChannel } from './calendar-channel';

interface FindParams {
  duration_mins: number | string;
  start: string;
  end: string;
  workday_start_hour?: number;
  workday_end_hour?: number;
}

export function createCalendarFindFreeTimeAction(deps: {
  getChannel: () => CalendarChannel | null;
}): ActionDefinition {
  return {
    type: 'calendar_find_free_time',
    name: 'Calendar: Find Free Time',
    description: 'Find open time slots of a given duration within a window.',

    chatExposable: true,
    chatGroup: 'calendar',
    chatLabel: { en: 'Find free time', es: 'Encontrar tiempo libre' },
    chatDescription: {
      en: 'Suggest open slots of a given length (e.g. 30 minutes) within a date range, avoiding your busy events.',
      es: 'Sugiere espacios libres de cierta duración (p. ej. 30 minutos) dentro de un rango de fechas, evitando tus eventos ocupados.',
    },
    chatExamples: [
      { en: 'Find 30 minutes next week for a call with Sarah.', es: 'Encuentra 30 minutos la próxima semana para una llamada con Sarah.' },
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
        duration_mins: { type: 'number', description: 'Slot length in minutes.' },
        start: { type: 'string', description: 'Search window start, ISO 8601.' },
        end: { type: 'string', description: 'Search window end, ISO 8601.' },
        workday_start_hour: { type: 'number', description: 'Earliest hour to suggest (local, default 9).' },
        workday_end_hour: { type: 'number', description: 'Latest hour to suggest (local, default 18).' },
      },
      required: ['duration_mins', 'start', 'end'],
    },

    outputSchema: {
      type: 'object',
      properties: { slots: { type: 'array' }, count: { type: 'number' } },
      required: ['slots', 'count'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Calendar: Find Free Time — no calendar connected.');
      const params = input.params as unknown as FindParams;
      const vars = input.wiredInputs ?? {};
      const duration = Number(renderTemplate(String(params.duration_mins ?? ''), vars).trim()) || 30;
      const start = renderTemplate(params.start ?? '', vars).trim();
      const end = renderTemplate(params.end ?? '', vars).trim();
      if (!start || !end) throw new Error('Calendar: Find Free Time — start and end are required.');

      const slots = await channel.findFreeTime({
        durationMins: duration,
        startISO: start,
        endISO: end,
        workdayStartHour: params.workday_start_hour,
        workdayEndHour: params.workday_end_hour,
      });
      return {
        data: { slots, count: slots.length },
        summary: `Found ${slots.length} open slot${slots.length === 1 ? '' : 's'} of ${duration} min`,
      };
    },
  };
}
