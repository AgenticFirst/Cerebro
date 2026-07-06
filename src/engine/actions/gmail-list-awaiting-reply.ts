/**
 * gmail_list_awaiting_reply — outreach follow-up detection: outbound threads
 * with no reply after N days. Read-only. Combined with a cron trigger +
 * gmail_send_message this replaces a "sequences" engine for simple follow-ups.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import type { GmailChannel } from './gmail-channel';

export function createGmailListAwaitingReplyAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_list_awaiting_reply',
    name: 'Gmail: Awaiting Reply',
    description: 'List sent emails that got no reply after N days (follow-up candidates).',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Who hasn’t replied?', es: '¿Quién no ha respondido?' },
    chatDescription: {
      en: 'Find outreach emails you sent that never got an answer, so you can follow up.',
      es: 'Encuentra correos que enviaste y nunca recibieron respuesta, para hacer seguimiento.',
    },
    chatExamples: [
      {
        en: 'Which emails from this week are still unanswered?',
        es: '¿Qué correos de esta semana siguen sin respuesta?',
      },
      { en: 'Who do I need to follow up with?', es: '¿A quién le debo hacer seguimiento?' },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      return ch?.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#gmail',

    inputSchema: {
      type: 'object',
      properties: {
        older_than_days: {
          type: 'number',
          description: 'Only threads whose last outbound message is at least this old (default 3).',
        },
      },
    },

    outputSchema: {
      type: 'object',
      properties: { count: { type: 'number' }, threads: { type: 'array' } },
      required: ['count', 'threads'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: Awaiting Reply — no Gmail account connected.');
      const days = Number((input.params as { older_than_days?: number }).older_than_days ?? 3);
      const threads = await channel.listAwaitingReply(Number.isFinite(days) ? days : 3);
      return {
        data: { count: threads.length, threads },
        summary: `${threads.length} thread${threads.length === 1 ? '' : 's'} awaiting a reply (${days}+ days)`,
      };
    },
  };
}
