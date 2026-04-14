/**
 * channel action — sends a message through a configured messaging channel
 * (currently: telegram). Routines use this as a DAG step.
 *
 * The TelegramBridge is provided via a process-wide setter so that the
 * action's registration-time factory doesn't need to know about bridge
 * lifecycle. If no bridge is registered, the action returns a "skipped"
 * result rather than throwing — routines shouldn't fail just because
 * the user hasn't connected a channel yet.
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
  sent: number;
  skipped: number;
  errors: string[];
  messageId?: string;
}

// ── Proactive-send contract (implemented by TelegramBridge) ─────

export interface ProactiveSender {
  sendProactive(
    recipients: string[],
    text: string,
  ): Promise<{ sent: number; skipped: number; errors: string[] }>;
}

// Process-wide registry — populated from main.ts after the bridge starts.
const senders = new Map<string, ProactiveSender>();

export function registerChannelSender(channel: string, sender: ProactiveSender): void {
  senders.set(channel, sender);
}

export function unregisterChannelSender(channel: string): void {
  senders.delete(channel);
}

// ── Action definition ───────────────────────────────────────────

export const channelAction: ActionDefinition = {
  type: 'channel',
  name: 'Channel',
  description: 'Sends messages via messaging channels (Telegram, and others as they are added).',

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
      sent: { type: 'number' },
      skipped: { type: 'number' },
      errors: { type: 'array', items: { type: 'string' } },
    },
    required: ['delivered', 'sent', 'skipped', 'errors'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ChannelParams;
    const channel = String(params.channel ?? '').toLowerCase();
    const operation = String(params.operation ?? 'send').toLowerCase();

    if (operation !== 'send') {
      return {
        data: {
          delivered: false,
          sent: 0,
          skipped: 0,
          errors: [`operation "${operation}" not supported — only "send"`],
        },
        summary: `Unsupported channel operation: ${operation}`,
      };
    }

    const recipients = Array.isArray(params.recipients)
      ? params.recipients.filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];

    if (recipients.length === 0) {
      return {
        data: { delivered: false, sent: 0, skipped: 0, errors: ['no recipients provided'] },
        summary: 'No recipients provided.',
      };
    }

    const sender = senders.get(channel);
    if (!sender) {
      return {
        data: {
          delivered: false,
          sent: 0,
          skipped: recipients.length,
          errors: [`channel "${channel}" is not connected — configure it in Integrations`],
        },
        summary: `Channel "${channel}" not connected.`,
      };
    }

    const message = String(params.message ?? '');
    const result = await sender.sendProactive(recipients, message);

    return {
      data: {
        delivered: result.sent > 0,
        sent: result.sent,
        skipped: result.skipped,
        errors: result.errors,
      },
      summary: `Sent ${result.sent}/${recipients.length} via ${channel}${result.errors.length ? ` (${result.errors.length} errors)` : ''}.`,
    };
  },
};
