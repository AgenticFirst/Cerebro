/**
 * gmail_search_messages — search the connected mailbox. Local FTS answers
 * instantly; Gmail operator queries (from:, is:unread, after:, …) fall through
 * to a live Gmail search. Read-only: skips the approval gate.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GmailChannel } from './gmail-channel';

interface SearchParams {
  query: string;
  max_results?: number;
}

export function createGmailSearchMessagesAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_search_messages',
    name: 'Gmail: Search Messages',
    description: 'Search email by free text or Gmail query syntax (from:, subject:, is:unread…).',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Search your email', es: 'Buscar en tu correo' },
    chatDescription: {
      en: 'Find emails by sender, subject, content, or Gmail operators (from:, has:attachment, after:…).',
      es: 'Encuentra correos por remitente, asunto, contenido u operadores de Gmail (from:, has:attachment, after:…).',
    },
    chatExamples: [
      { en: 'Did Acme reply about the invoice?', es: '¿Acme respondió sobre la factura?' },
      {
        en: 'Find unread emails from alice@acme.com',
        es: 'Busca correos sin leer de alice@acme.com',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      return ch?.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#gmail',

    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free text or Gmail search syntax (from:, to:, subject:, is:unread, has:attachment, after:YYYY/MM/DD…). Templated.',
        },
        max_results: { type: 'number', description: 'Max messages to return (default 25).' },
      },
      required: ['query'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        messages: { type: 'array' },
      },
      required: ['count', 'messages'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: Search Messages — no Gmail account connected.');
      const params = input.params as unknown as SearchParams;
      const query = renderTemplate(params.query ?? '', input.wiredInputs ?? {}).trim();
      if (!query) throw new Error('Gmail: Search Messages — query is empty.');

      const messages = await channel.search(query, params.max_results ?? 25);
      // Trim to what the agent needs (ids for follow-ups; no bodies here —
      // gmail_get_thread reads full content).
      const slim = messages.map((m) => ({
        message_id: m.id,
        thread_id: m.threadId,
        from: m.from,
        to: m.to,
        subject: m.subject,
        snippet: m.snippet,
        received_at: m.receivedAt,
        unread: m.unread,
        has_attachments: m.hasAttachments,
      }));
      return {
        data: { count: slim.length, messages: slim },
        summary: `Found ${slim.length} email${slim.length === 1 ? '' : 's'} for "${query}"`,
      };
    },
  };
}
