/**
 * send_notification action — shows a desktop notification via Electron.
 *
 * Fire-and-forget: returns immediately after showing the notification.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';

interface NotificationParams {
  title: string;
  body: string;
  urgency?: 'normal' | 'critical';
}

export const sendNotificationAction: ActionDefinition = {
  type: 'send_notification',
  name: 'Send Notification',
  description: 'Shows a desktop notification.',

  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      urgency: { type: 'string', enum: ['normal', 'critical'] },
    },
    required: ['title', 'body'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      sent: { type: 'boolean' },
    },
    required: ['sent'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as NotificationParams;

    if (!params.title) {
      throw new Error('Notification requires a title');
    }

    // Use Electron's Notification API (available in main process)
    const { Notification } = await import('electron');

    if (!Notification.isSupported()) {
      input.context.log('Desktop notifications are not supported on this platform');
      return {
        data: { sent: false },
        summary: 'Notifications not supported',
      };
    }

    const notification = new Notification({
      title: params.title,
      body: params.body ?? '',
      urgency: params.urgency ?? 'normal',
    });

    notification.show();
    input.context.log(`Notification shown: ${params.title}`);

    return {
      data: { sent: true },
      summary: `Notification: ${params.title}`,
    };
  },
};
