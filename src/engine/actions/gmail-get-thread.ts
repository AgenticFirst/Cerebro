/**
 * gmail_get_thread — read a full email conversation (all messages with
 * bodies). Read-only: skips the approval gate.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GmailChannel } from './gmail-channel';

const BODY_CHAR_LIMIT = 4_000;

export function createGmailGetThreadAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_get_thread',
    name: 'Gmail: Read Thread',
    description: 'Read a full email conversation, including message bodies.',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Read an email thread', es: 'Leer un hilo de correo' },
    chatDescription: {
      en: 'Read all messages in an email conversation (use after a search returns a thread_id).',
      es: 'Lee todos los mensajes de una conversación de correo (úsalo tras una búsqueda que devuelva thread_id).',
    },
    chatExamples: [
      { en: 'What did Alice say in that thread?', es: '¿Qué dijo Alice en ese hilo?' },
      { en: 'Summarize my conversation with Acme', es: 'Resume mi conversación con Acme' },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      return ch?.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#gmail',

    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread id. Templated.' },
      },
      required: ['thread_id'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        subject: { type: 'string' },
        message_count: { type: 'number' },
        messages: { type: 'array' },
      },
      required: ['thread_id', 'messages'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: Read Thread — no Gmail account connected.');
      const threadId = renderTemplate(
        String((input.params as { thread_id?: string }).thread_id ?? ''),
        input.wiredInputs ?? {},
      ).trim();
      if (!threadId) throw new Error('Gmail: Read Thread — thread_id is required.');

      const thread = await channel.getThread(threadId);
      const messages = thread.messages.map((m) => ({
        message_id: m.id,
        from: m.from,
        to: m.to,
        cc: m.cc,
        date: m.receivedAt,
        // Cap bodies so a long thread doesn't blow up the step output.
        body: (m.bodyText || m.snippet).slice(0, BODY_CHAR_LIMIT),
        attachments: m.attachments.map((a) => ({ filename: a.filename, size: a.sizeBytes })),
      }));
      return {
        data: {
          thread_id: thread.threadId,
          subject: thread.subject,
          message_count: messages.length,
          messages,
        },
        summary: `Read thread "${thread.subject}" (${messages.length} message${
          messages.length === 1 ? '' : 's'
        })`,
      };
    },
  };
}
