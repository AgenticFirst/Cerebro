/**
 * gmail_create_draft — write a draft into the user's Gmail Drafts folder
 * without sending. Nothing leaves the mailbox, but it's still a write to the
 * account, so it stays behind the approval gate (auto-approval rules can
 * waive it per user choice).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { splitAddresses } from '../../gmail/helpers';
import type { GmailChannel } from './gmail-channel';

interface DraftParams {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  reply_to_thread_id?: string;
}

export function createGmailCreateDraftAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_create_draft',
    name: 'Gmail: Create Draft',
    description: 'Save a draft in Gmail (nothing is sent).',

    chatExposable: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Draft an email', es: 'Crear un borrador de correo' },
    chatDescription: {
      en: 'Write a draft into your Gmail Drafts folder for you to review and send later.',
      es: 'Guarda un borrador en tu carpeta de Borradores de Gmail para revisarlo y enviarlo después.',
    },
    chatExamples: [
      {
        en: 'Draft a reply to Alice thanking her for the intro',
        es: 'Prepara un borrador para Alice agradeciéndole la presentación',
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
        to: { type: 'string', description: 'Recipient address(es), comma-separated. Templated.' },
        cc: { type: 'string', description: 'Cc address(es). Optional.' },
        subject: { type: 'string', description: 'Subject line. Templated.' },
        body: { type: 'string', description: 'Plain-text body. Templated.' },
        reply_to_thread_id: {
          type: 'string',
          description: 'Gmail thread id when drafting a reply into an existing conversation.',
        },
      },
      required: ['to', 'subject', 'body'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        created: { type: 'boolean' },
        draft_id: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: Create Draft — no Gmail account connected.');
      const params = input.params as unknown as DraftParams;
      const vars = input.wiredInputs ?? {};

      const to = splitAddresses(renderTemplate(params.to ?? '', vars));
      const subject = renderTemplate(params.subject ?? '', vars).trim();
      const body = renderTemplate(params.body ?? '', vars);
      const replyTo = params.reply_to_thread_id
        ? renderTemplate(params.reply_to_thread_id, vars).trim()
        : undefined;
      if (!to.length) throw new Error('Gmail: Create Draft — "to" is empty.');
      if (!body.trim()) throw new Error('Gmail: Create Draft — body is empty.');

      const result = await channel.createDraft({
        to,
        cc: params.cc ? splitAddresses(renderTemplate(params.cc, vars)) : undefined,
        subject,
        text: body,
        replyToThreadId: replyTo || undefined,
      });
      if (!result.ok) {
        return {
          data: { created: false, draft_id: null, error: result.error ?? null },
          summary: `Draft creation failed: ${result.error}`,
        };
      }
      return {
        data: { created: true, draft_id: result.draftId ?? null, error: null },
        summary: `Saved draft "${subject}" for ${to.join(', ')}`,
      };
    },
  };
}
