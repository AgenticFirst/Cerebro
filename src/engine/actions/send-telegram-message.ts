/**
 * send_telegram_message action — sends a templated message via the user's
 * configured Telegram bot. Allowlist-only (gated inside TelegramBridge).
 *
 * `chat_id` and `message` are rendered with Mustache against `wiredInputs`,
 * so a routine triggered by a Telegram message can reply to the same chat
 * via `{{trigger.chat_id}}` (when wired from the synthetic __trigger__ node).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { TelegramChannel } from './telegram-channel';

interface SendTelegramParams {
  chat_id: string;
  message: string;
  parse_mode?: 'HTML' | 'MarkdownV2' | 'none';
}

export function createSendTelegramAction(deps: { getChannel: () => TelegramChannel | null }): ActionDefinition {
  return {
    type: 'send_telegram_message',
    name: 'Send Telegram Message',
    description: 'Send a message via the Telegram Bot. Allowlist-enforced.',

    chatExposable: true,
    chatGroup: 'telegram',
    chatLabel: { en: 'Send Telegram message', es: 'Enviar mensaje de Telegram' },
    chatDescription: {
      en: 'Send a Telegram message to a numeric chat id from your Telegram allowlist.',
      es: 'Envía un mensaje de Telegram a un chat_id numérico que esté en tu lista de Telegram.',
    },
    chatExamples: [
      {
        en: "Send a Telegram to chat 123456789 saying I'll be 10 minutes late.",
        es: 'Envía un Telegram al chat 123456789 diciendo que llegaré 10 minutos tarde.',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#telegram',

    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Numeric Telegram chat id to send to. Templated — use {{...}} to insert values from upstream steps.',
        },
        message: {
          type: 'string',
          description: 'Message body. Templated the same way as chat_id.',
        },
        parse_mode: {
          type: 'string',
          enum: ['HTML', 'MarkdownV2', 'none'],
          description: 'How Telegram should parse the message. Defaults to none (plain text).',
        },
      },
      required: ['chat_id', 'message'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_id: { type: ['number', 'null'] },
        chat_id: { type: 'string' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'chat_id'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      // Read the channel lazily so registry construction order doesn't matter —
      // the engine sets it via setTelegramChannel() during main.ts wiring.
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Send Telegram Message: Telegram bridge is not enabled. Connect Telegram in Integrations first.',
        );
      }

      const params = input.params as unknown as SendTelegramParams;
      const vars = input.wiredInputs ?? {};

      const chatId = renderTemplate(params.chat_id ?? '', vars).trim();
      const message = renderTemplate(params.message ?? '', vars);

      if (!chatId) {
        throw new Error('Send Telegram Message: chat_id is empty.');
      }
      if (!message.trim()) {
        throw new Error('Send Telegram Message: message is empty.');
      }
      if (!channel.isAllowlisted(chatId)) {
        throw new Error(`Send Telegram Message: chat_id ${chatId} is not in the Telegram allowlist.`);
      }

      const { messageId, error } = await channel.sendActionMessage(chatId, message, params.parse_mode);

      if (error) {
        // Surface a friendlier error in the step output but also throw so the
        // step is marked failed (and on_error policy decides what's next).
        input.context.log(`Telegram send failed for ${chatId}: ${error}`);
        return {
          data: { sent: false, message_id: messageId, chat_id: chatId, error },
          summary: `Telegram send failed: ${error}`,
        };
      }

      input.context.log(`Sent Telegram message to ${chatId} (message_id=${messageId})`);
      return {
        data: { sent: true, message_id: messageId, chat_id: chatId, error: null },
        summary: `Sent Telegram message to ${chatId}`,
      };
    },
  };
}
