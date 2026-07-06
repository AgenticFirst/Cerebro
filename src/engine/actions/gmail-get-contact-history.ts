/**
 * gmail_get_contact_history — the recent email relationship with one address:
 * latest threads either direction, newest first. Powers "what's my history
 * with X" and gives outreach drafts real context. Read-only.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GmailChannel } from './gmail-channel';

interface ContactHistoryParams {
  email: string;
  max_threads?: number;
}

export function createGmailGetContactHistoryAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_get_contact_history',
    name: 'Gmail: Contact History',
    description: 'Recent email threads exchanged with a specific address.',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Email history with a contact', es: 'Historial de correo con un contacto' },
    chatDescription: {
      en: 'Look up the recent email conversations with one person (both directions).',
      es: 'Consulta las conversaciones de correo recientes con una persona (en ambas direcciones).',
    },
    chatExamples: [
      {
        en: 'When did I last email carlos@acme.com?',
        es: '¿Cuándo fue mi último correo con carlos@acme.com?',
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
        email: { type: 'string', description: 'Contact email address. Templated.' },
        max_threads: { type: 'number', description: 'Max threads to return (default 10).' },
      },
      required: ['email'],
    },

    outputSchema: {
      type: 'object',
      properties: { count: { type: 'number' }, threads: { type: 'array' } },
      required: ['count', 'threads'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: Contact History — no Gmail account connected.');
      const params = input.params as unknown as ContactHistoryParams;
      const email = renderTemplate(params.email ?? '', input.wiredInputs ?? {}).trim();
      if (!email) throw new Error('Gmail: Contact History — email is required.');
      const maxThreads = params.max_threads ?? 10;

      const messages = await channel.search(`from:${email} OR to:${email}`, maxThreads * 4);
      // Collapse to threads, newest message per thread wins.
      const byThread = new Map<string, (typeof messages)[number]>();
      for (const m of messages) {
        const existing = byThread.get(m.threadId);
        if (!existing || m.receivedAt > existing.receivedAt) byThread.set(m.threadId, m);
      }
      const threads = [...byThread.values()]
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
        .slice(0, maxThreads)
        .map((m) => ({
          thread_id: m.threadId,
          subject: m.subject,
          snippet: m.snippet,
          last_message_at: m.receivedAt,
          last_from: m.from,
        }));
      return {
        data: { count: threads.length, threads },
        summary: `Found ${threads.length} thread${threads.length === 1 ? '' : 's'} with ${email}`,
      };
    },
  };
}
