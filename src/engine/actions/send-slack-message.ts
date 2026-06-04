/**
 * send_slack_message action — sends a templated message to a Slack channel
 * via the user's configured Slack app. Allowlist-enforced inside the bridge.
 *
 * `channel`, `text`, and optional `thread_ts` are rendered with Mustache
 * against `wiredInputs`, so a routine triggered by a Slack message can
 * reply to the same thread via `{{__trigger__.channel}}` /
 * `{{__trigger__.thread_ts}}`.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { SlackChannel } from './slack-channel';

interface SendSlackParams {
  channel: string;
  text: string;
  thread_ts?: string;
}

export function createSendSlackMessageAction(deps: {
  getChannel: () => SlackChannel | null;
}): ActionDefinition {
  return {
    type: 'send_slack_message',
    name: 'Send Slack Message',
    description:
      'Send a message to a Slack channel or DM (in-thread when thread_ts is set). Allowlist-enforced.',

    chatExposable: true,
    chatGroup: 'slack',
    chatLabel: { en: 'Send Slack message', es: 'Enviar mensaje de Slack' },
    chatDescription: {
      en: 'Send a Slack message to a channel id or DM channel id from your Slack allowlist.',
      es: 'Envía un mensaje de Slack a un id de canal o DM que esté en tu lista de Slack.',
    },
    chatExamples: [
      {
        en: 'Post in #general on Slack saying standup at 10am.',
        es: 'Publica en #general en Slack diciendo que el daily es a las 10am.',
      },
      {
        en: 'DM @Pablo on Slack: are you free for a 5-min chat?',
        es: 'Mándale un DM a @Pablo por Slack: ¿tienes 5 minutos para hablar?',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#slack',

    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description:
            'Slack channel id (C…/G…) or DM channel id (D…). Templated — use {{...}} from upstream steps.',
        },
        text: {
          type: 'string',
          description: 'Message body. Templated the same way as channel.',
        },
        thread_ts: {
          type: 'string',
          description: 'Optional thread root ts. When set, the message lands as a thread reply.',
        },
      },
      required: ['channel', 'text'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        message_ts: { type: ['string', 'null'] },
        channel: { type: 'string' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'channel'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Send Slack Message: Slack bridge is not enabled. Connect Slack in Integrations first.',
        );
      }

      const params = input.params as unknown as SendSlackParams;
      const vars = input.wiredInputs ?? {};

      const channelId = renderTemplate(params.channel ?? '', vars).trim();
      const text = renderTemplate(params.text ?? '', vars);
      const threadTs = params.thread_ts ? renderTemplate(params.thread_ts, vars).trim() : undefined;

      if (!channelId) throw new Error('Send Slack Message: channel is empty.');
      if (!text.trim()) throw new Error('Send Slack Message: text is empty.');
      if (!channel.isAllowlisted(channelId)) {
        throw new Error(`Send Slack Message: channel ${channelId} is not in the Slack allowlist.`);
      }

      const { messageTs, error } = await channel.sendActionMessage(channelId, text, threadTs);

      if (error) {
        input.context.log(`Slack send failed for ${channelId}: ${error}`);
        return {
          data: { sent: false, message_ts: messageTs, channel: channelId, error },
          summary: `Slack send failed: ${error}`,
        };
      }

      input.context.log(`Sent Slack message to ${channelId} (ts=${messageTs})`);
      return {
        data: { sent: true, message_ts: messageTs, channel: channelId, error: null },
        summary: `Sent Slack message to ${channelId}`,
      };
    },
  };
}
