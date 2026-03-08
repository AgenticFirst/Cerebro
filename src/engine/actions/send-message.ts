/**
 * send_message action — posts a message to a Cerebro conversation.
 *
 * Replaces the V0 channel.ts stub.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { backendFetch } from './utils/backend-fetch';

interface SendMessageParams {
  message: string;
  target?: string;
}

export const sendMessageAction: ActionDefinition = {
  type: 'send_message',
  name: 'Send Message',
  description: 'Posts a message to a Cerebro conversation.',

  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      target: { type: 'string', description: 'Conversation ID or "cerebro_chat"' },
    },
    required: ['message'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      sent: { type: 'boolean' },
      message_id: { type: 'string' },
    },
    required: ['sent'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as SendMessageParams;
    const { context } = input;

    if (!params.message) {
      throw new Error('Send message requires a message');
    }

    let conversationId = params.target;

    // If no specific target or target is "cerebro_chat", use/create a routine notifications conversation
    if (!conversationId || conversationId === 'cerebro_chat') {
      // List conversations to find or create a routine notification conversation
      const conversations = await backendFetch<Array<{ id: string; title: string }>>(
        context.backendPort,
        'GET',
        '/conversations',
        null,
        context.signal,
      );

      const existing = conversations.find((c) => c.title === 'Routine Notifications');
      if (existing) {
        conversationId = existing.id;
      } else {
        const created = await backendFetch<{ id: string }>(
          context.backendPort,
          'POST',
          '/conversations',
          { title: 'Routine Notifications' },
          context.signal,
        );
        conversationId = created.id;
      }
    }

    // Post the message (use role: 'system' to distinguish from real AI responses)
    const result = await backendFetch<{ id: string }>(
      context.backendPort,
      'POST',
      `/conversations/${conversationId}/messages`,
      {
        role: 'system',
        content: params.message,
        metadata: JSON.stringify({ source: 'routine', runId: context.runId }),
      },
      context.signal,
    );

    const logPreview = params.message.length > 50 ? params.message.slice(0, 50) + '...' : params.message;
    context.log(`Sent message: ${logPreview}`);

    const summaryPreview = params.message.length > 40 ? params.message.slice(0, 40) + '...' : params.message;
    return {
      data: {
        sent: true,
        message_id: result.id,
      },
      summary: `Message sent: ${summaryPreview}`,
    };
  },
};
