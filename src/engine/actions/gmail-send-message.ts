/**
 * gmail_send_message — send an email (new or as a threaded reply) from the
 * connected Gmail account. Write action: approval-gated by default; the
 * summary always states recipients + subject so approvals are informed.
 *
 * Attachments accept a `file_item_id` (preferred) or absolute `file_path`,
 * resolved through the shared media-resolver like the Telegram/WhatsApp media
 * sends.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { resolveMediaInput } from './utils/media-resolver';
import { splitAddresses } from '../../gmail/helpers';
import type { GmailChannel } from './gmail-channel';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // Gmail's hard cap per message.

interface SendParams {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  reply_to_thread_id?: string;
  template_id?: string;
  variables?: Record<string, string>;
  send_at?: string;
  file_item_id?: string;
  file_path?: string;
}

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function createGmailSendMessageAction(deps: {
  getChannel: () => GmailChannel | null;
  backendPort: () => number | null;
}): ActionDefinition {
  return {
    type: 'gmail_send_message',
    name: 'Gmail: Send Email',
    description: 'Send an email (or a threaded reply) from the connected Gmail account.',

    chatExposable: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Send an email', es: 'Enviar un correo' },
    chatDescription: {
      en: 'Send an email to any address from your connected Gmail. Pauses for your approval first.',
      es: 'Envía un correo a cualquier dirección desde tu Gmail conectado. Se pausa para tu aprobación primero.',
    },
    chatExamples: [
      {
        en: 'Send an email to alice@acme.com about the demo tomorrow',
        es: 'Envía un correo a alice@acme.com sobre la demo de mañana',
      },
      {
        en: 'Reply to that thread saying we accept',
        es: 'Responde a ese hilo diciendo que aceptamos',
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
        to: {
          type: 'string',
          description: 'Recipient address(es), comma-separated. Templated.',
        },
        cc: { type: 'string', description: 'Cc address(es), comma-separated. Optional.' },
        bcc: { type: 'string', description: 'Bcc address(es), comma-separated. Optional.' },
        subject: { type: 'string', description: 'Subject line. Templated.' },
        body: { type: 'string', description: 'Plain-text body. Templated.' },
        reply_to_thread_id: {
          type: 'string',
          description:
            'Gmail thread id to reply into. When set, threading headers and the Re: subject are handled automatically.',
        },
        template_id: {
          type: 'string',
          description:
            'Send from a saved email template instead of subject/body. Tokens like {{first_name}} are filled from `variables`.',
        },
        variables: {
          type: 'object',
          description: 'Values for the template tokens, e.g. {"first_name": "Alice"}.',
        },
        send_at: {
          type: 'string',
          description:
            'Schedule the send for this ISO 8601 instant instead of sending now (send-later).',
        },
        file_item_id: {
          type: 'string',
          description: 'Attachment: id of a Cerebro file item (preferred over file_path).',
        },
        file_path: { type: 'string', description: 'Attachment: absolute path fallback.' },
      },
      required: ['to'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        scheduled: { type: 'boolean' },
        scheduled_id: { type: ['string', 'null'] },
        message_id: { type: ['string', 'null'] },
        thread_id: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['sent'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Gmail: Send Email — no Gmail account connected. Connect Gmail in Integrations first.',
        );
      }
      const params = input.params as unknown as SendParams;
      const vars = input.wiredInputs ?? {};

      const to = splitAddresses(renderTemplate(params.to ?? '', vars));
      const cc = params.cc ? splitAddresses(renderTemplate(params.cc, vars)) : undefined;
      const bcc = params.bcc ? splitAddresses(renderTemplate(params.bcc, vars)) : undefined;
      let subject = renderTemplate(params.subject ?? '', vars).trim();
      let body = renderTemplate(params.body ?? '', vars);
      const replyTo = params.reply_to_thread_id
        ? renderTemplate(params.reply_to_thread_id, vars).trim()
        : undefined;

      if (params.template_id) {
        const resolved = await channel.resolveTemplate(
          renderTemplate(params.template_id, vars).trim(),
          params.variables ?? {},
        );
        if (!resolved.ok) throw new Error(`Gmail: Send Email — ${resolved.error}`);
        subject = subject || (resolved.subject ?? '');
        body = resolved.text ?? '';
      }

      if (!to.length) throw new Error('Gmail: Send Email — "to" is empty.');
      if (!subject && !replyTo) throw new Error('Gmail: Send Email — subject is empty.');
      if (!body.trim()) throw new Error('Gmail: Send Email — body is empty.');

      // Send-later: queue instead of sending. Approval already happened at
      // this step's gate, so the future send runs unattended.
      if (params.send_at) {
        const sendAt = new Date(renderTemplate(params.send_at, vars).trim());
        if (Number.isNaN(sendAt.getTime())) {
          throw new Error('Gmail: Send Email — send_at is not a valid ISO 8601 datetime.');
        }
        const scheduled = await channel.scheduleSend({
          to,
          cc,
          bcc,
          subject,
          text: body,
          replyToThreadId: replyTo || undefined,
          sendAtISO: sendAt.toISOString(),
        });
        if (!scheduled.ok) {
          throw new Error(`Gmail: Send Email — scheduling failed: ${scheduled.error}`);
        }
        return {
          data: { sent: false, scheduled: true, scheduled_id: scheduled.scheduledId, error: null },
          summary: `Scheduled "${subject}" to ${to.join(', ')} for ${sendAt.toLocaleString()}`,
        };
      }

      let attachments: Array<{ filename: string; mimeType: string; contentBase64: string }> = [];
      if (params.file_item_id || params.file_path) {
        const port = deps.backendPort();
        if (!port) throw new Error('Gmail: Send Email — backend not ready for attachments.');
        const fileItemId = params.file_item_id
          ? renderTemplate(params.file_item_id, vars).trim()
          : undefined;
        const filePath = params.file_path
          ? renderTemplate(params.file_path, vars).trim()
          : undefined;
        const resolved = await resolveMediaInput(
          port,
          fileItemId || undefined,
          filePath || undefined,
        );
        if (resolved.sizeBytes > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `Gmail: Send Email — attachment is ${(resolved.sizeBytes / 1024 / 1024).toFixed(1)} MB; Gmail's limit is 25 MB.`,
          );
        }
        const content = await fs.readFile(resolved.absPath);
        const ext = path.extname(resolved.fileName).toLowerCase();
        attachments = [
          {
            filename: resolved.fileName,
            mimeType: resolved.mime ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
            contentBase64: content.toString('base64'),
          },
        ];
      }

      const result = await channel.sendMessage({
        to,
        cc,
        bcc,
        subject,
        text: body,
        replyToThreadId: replyTo || undefined,
        attachments: attachments.length ? attachments : undefined,
      });

      if (!result.ok) {
        input.context.log(`Gmail send failed: ${result.error}`);
        return {
          data: { sent: false, message_id: null, thread_id: null, error: result.error ?? null },
          summary: `Email send failed: ${result.error}`,
        };
      }

      const recipients = to.join(', ');
      input.context.log(`Sent email to ${recipients} (message_id=${result.messageId})`);
      return {
        data: {
          sent: true,
          message_id: result.messageId ?? null,
          thread_id: result.threadId ?? null,
          error: null,
        },
        summary: replyTo
          ? `Replied in thread to ${recipients}`
          : `Sent "${subject}" to ${recipients}${attachments.length ? ' with attachment' : ''}`,
      };
    },
  };
}
