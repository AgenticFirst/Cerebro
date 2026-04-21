/**
 * send_notification action — shows a desktop notification via Electron.
 *
 * Fire-and-forget: returns immediately after calling `Notification.show()`.
 *
 * `title` and `body` are rendered with Mustache against `wiredInputs`, so
 * placeholders like `{{previous_output}}` resolve to values piped in from
 * upstream step outputs — consistent with the Ask AI action.
 */

import Mustache from 'mustache';
import type { ActionDefinition, ActionInput, ActionOutput } from './types';

interface NotificationParams {
  title: string;
  body?: string;
  urgency?: 'normal' | 'critical';
}

function renderTemplate(source: string, vars: Record<string, unknown>): string {
  if (!source) return '';
  // Prompts / notification bodies are plain text, not HTML — disable escaping.
  return Mustache.render(source, vars, undefined, { escape: (v) => String(v) });
}

export const sendNotificationAction: ActionDefinition = {
  type: 'send_notification',
  name: 'Send Notification',
  description: 'Shows a desktop notification.',

  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short headline shown at the top of the notification. Use {{variable}} to insert values from upstream steps.',
      },
      body: {
        type: 'string',
        description: 'Longer message body. Templated the same way as title.',
      },
      urgency: {
        type: 'string',
        enum: ['normal', 'critical'],
        description: 'Normal = standard banner; critical = sticky / alert-style on supported OSes.',
      },
    },
    required: ['title'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      sent: { type: 'boolean' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['sent'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as NotificationParams;
    const vars = input.wiredInputs ?? {};

    const title = renderTemplate(params.title ?? '', vars).trim();
    const body = renderTemplate(params.body ?? '', vars);

    if (!title) {
      throw new Error('Send Notification: title is empty. Enter a headline or wire one in from an upstream step.');
    }

    const { Notification } = await import('electron');

    if (!Notification.isSupported()) {
      input.context.log('Desktop notifications are not supported on this platform');
      return {
        data: { sent: false, title, body },
        summary: 'Notifications not supported on this platform',
      };
    }

    const notification = new Notification({
      title,
      body,
      urgency: params.urgency ?? 'normal',
    });

    notification.show();
    input.context.log(`Notification shown: ${title}`);

    return {
      data: { sent: true, title, body },
      summary: `Notification: ${title}`,
    };
  },
};
