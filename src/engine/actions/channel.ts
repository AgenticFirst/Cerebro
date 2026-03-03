/**
 * channel action — interface for messaging channel integrations.
 *
 * V0 stub: Returns an error indicating the channel is not yet available.
 * Implementation deferred to roadmap Section 10.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';

// ── Types ───────────────────────────────────────────────────────

export interface ChannelParams {
  channel: string;
  operation: 'send' | 'receive';
  recipients?: string[];
  message: string;
}

export interface ChannelOutput {
  delivered: boolean;
  messageId?: string;
}

// ── Action definition ───────────────────────────────────────────

export const channelAction: ActionDefinition = {
  type: 'channel',
  name: 'Channel',
  description: 'Sends and receives messages via messaging channels (Telegram, WhatsApp, Email, etc.).',

  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel identifier (e.g. "telegram")' },
      operation: { type: 'string', enum: ['send', 'receive'], description: 'Send or receive' },
      recipients: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recipient identifiers',
      },
      message: { type: 'string', description: 'Message content' },
    },
    required: ['channel', 'operation', 'message'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      delivered: { type: 'boolean' },
      messageId: { type: 'string' },
    },
    required: ['delivered'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ChannelParams;
    throw new Error(`Channel '${params.channel}' is not yet available. Channel support is coming in a future update.`);
  },
};
