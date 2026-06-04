/**
 * list_slack_channels action — read-only enumeration of public + private
 * channels the bot is in. Useful when drafting routines ("post to which
 * channel?") and when the chat agent needs to discover channel IDs.
 *
 * No approval gate — it just reads metadata.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import type { SlackChannel } from './slack-channel';

export function createListSlackChannelsAction(deps: {
  getChannel: () => SlackChannel | null;
}): ActionDefinition {
  return {
    type: 'list_slack_channels',
    name: 'List Slack Channels',
    description: 'Return the list of Slack channels the bot is a member of.',

    chatExposable: true,
    chatGroup: 'slack',
    chatLabel: { en: 'List Slack channels', es: 'Listar canales de Slack' },
    chatDescription: {
      en: 'Read the public/private channels the Slack bot can see — used to pick a destination.',
      es: 'Lee los canales públicos/privados que el bot de Slack puede ver — útil para elegir destino.',
    },
    chatExamples: [
      {
        en: 'Which Slack channels can Cerebro post to?',
        es: '¿En qué canales de Slack puede publicar Cerebro?',
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
      properties: {},
      additionalProperties: false,
    },

    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        channels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              is_private: { type: 'boolean' },
            },
            required: ['id', 'name', 'is_private'],
          },
        },
        error: { type: ['string', 'null'] },
      },
      required: ['ok'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'List Slack Channels: Slack bridge is not enabled. Connect Slack in Integrations first.',
        );
      }
      const res = await channel.listChannels();
      if (!res.ok) {
        input.context.log(`Slack list channels failed: ${res.error}`);
        return {
          data: { ok: false, channels: [], error: res.error ?? 'unknown error' },
          summary: `Slack list failed: ${res.error ?? 'unknown error'}`,
        };
      }
      return {
        data: { ok: true, channels: res.channels ?? [], error: null },
        summary: `Found ${(res.channels ?? []).length} Slack channels.`,
      };
    },
  };
}
