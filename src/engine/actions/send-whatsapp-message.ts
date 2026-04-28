/**
 * send_whatsapp_message action — sends a templated text message via the
 * user's paired WhatsApp account (Baileys / WhatsApp Web). Allowlist-only
 * (gated inside WhatsAppBridge).
 *
 * `phone_number` and `message` are rendered with Mustache against
 * `wiredInputs`, so a routine triggered by a WhatsApp message can reply to
 * the same number via `{{__trigger__.phone_number}}`.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { WhatsAppChannel } from './whatsapp-channel';

interface SendWhatsAppParams {
  phone_number: string;
  message: string;
}

export function createSendWhatsAppAction(deps: {
  getChannel: () => WhatsAppChannel | null;
}): ActionDefinition {
  return {
    type: 'send_whatsapp_message',
    name: 'Send WhatsApp Message',
    description: 'Send a message via the paired WhatsApp account. Allowlist-enforced.',

    chatExposable: true,
    chatGroup: 'whatsapp',
    chatLabel: { en: 'Send WhatsApp message', es: 'Enviar mensaje de WhatsApp' },
    chatDescription: {
      en: 'Send a WhatsApp message to a phone number from your WhatsApp allowlist.',
      es: 'Envía un mensaje de WhatsApp a un número que esté en tu lista de WhatsApp.',
    },
    chatExamples: [
      {
        en: 'Send a WhatsApp to +14155552671 saying the package arrived.',
        es: 'Envía un WhatsApp a +14155552671 diciéndole que el paquete llegó.',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#whatsapp',

    inputSchema: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'Customer phone number in E.164 format (e.g. +14155552671) or full Baileys JID. Templated — use {{...}} to insert values from upstream steps.',
        },
        message: {
          type: 'string',
          description: 'Message body. Templated the same way as phone_number.',
        },
      },
      required: ['phone_number', 'message'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_id: { type: ['string', 'null'] },
        phone_number: { type: 'string' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'phone_number'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Send WhatsApp Message: WhatsApp bridge is not enabled. Connect WhatsApp in Integrations first.',
        );
      }

      const params = input.params as unknown as SendWhatsAppParams;
      const vars = input.wiredInputs ?? {};

      const phone = renderTemplate(params.phone_number ?? '', vars).trim();
      const message = renderTemplate(params.message ?? '', vars);

      if (!phone) {
        throw new Error('Send WhatsApp Message: phone_number is empty.');
      }
      if (!message.trim()) {
        throw new Error('Send WhatsApp Message: message is empty.');
      }
      if (!channel.isAllowlisted(phone)) {
        throw new Error(`Send WhatsApp Message: ${phone} is not in the WhatsApp allowlist.`);
      }

      const { messageId, error } = await channel.sendActionMessage(phone, message);

      if (error) {
        input.context.log(`WhatsApp send failed for ${phone}: ${error}`);
        return {
          data: { sent: false, message_id: messageId, phone_number: phone, error },
          summary: `WhatsApp send failed: ${error}`,
        };
      }

      input.context.log(`Sent WhatsApp message to ${phone} (message_id=${messageId})`);
      return {
        data: { sent: true, message_id: messageId, phone_number: phone, error: null },
        summary: `Sent WhatsApp message to ${phone}`,
      };
    },
  };
}
