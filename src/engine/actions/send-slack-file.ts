/**
 * send_slack_file action — uploads a file to a Slack channel via
 * `files.uploadV2`. Allowlist-enforced inside the bridge. Requires approval
 * automatically (chat-actions gate every outbound action).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { resolveMediaInput } from './utils/media-resolver';
import type { SlackChannel } from './slack-channel';

interface SendSlackFileParams {
  channel: string;
  file_item_id?: string;
  file_path?: string;
  comment?: string;
  file_name?: string;
  thread_ts?: string;
}

export function createSendSlackFileAction(deps: { getChannel: () => SlackChannel | null }): ActionDefinition {
  return {
    type: 'send_slack_file',
    name: 'Send Slack File',
    description: 'Upload a file to a Slack channel or DM via files.uploadV2.',

    chatExposable: true,
    chatGroup: 'slack',
    chatLabel: { en: 'Send Slack file', es: 'Enviar archivo a Slack' },
    chatDescription: {
      en: 'Upload a file from disk into a Slack channel or DM from your allowlist.',
      es: 'Sube un archivo del disco a un canal o DM de Slack desde tu lista.',
    },
    chatExamples: [
      {
        en: 'Share the report.pdf in #reports on Slack.',
        es: 'Comparte el archivo report.pdf en #reportes en Slack.',
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
        channel: { type: 'string', description: 'Slack channel id (C…/G…) or DM channel id (D…).' },
        file_item_id: { type: 'string', description: 'Preferred: id of a registered FileItem on disk.' },
        file_path: {
          type: 'string',
          description: 'Escape hatch: absolute path to a file on disk Cerebro just created.',
        },
        comment: { type: 'string', description: 'Optional comment posted with the file.' },
        file_name: { type: 'string', description: 'Optional override for the displayed filename.' },
        thread_ts: { type: 'string', description: 'Optional thread root ts.' },
      },
      required: ['channel'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        sent: { type: 'boolean' },
        file_id: { type: ['string', 'null'] },
        channel: { type: 'string' },
        error: { type: ['string', 'null'] },
      },
      required: ['sent', 'channel'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'Send Slack File: Slack bridge is not enabled. Connect Slack in Integrations first.',
        );
      }

      const params = input.params as unknown as SendSlackFileParams;
      const vars = input.wiredInputs ?? {};
      const channelId = renderTemplate(params.channel ?? '', vars).trim();
      const comment = params.comment ? renderTemplate(params.comment, vars) : undefined;
      const threadTs = params.thread_ts ? renderTemplate(params.thread_ts, vars).trim() : undefined;

      if (!channelId) throw new Error('Send Slack File: channel is empty.');
      if (!channel.isAllowlisted(channelId)) {
        throw new Error(`Send Slack File: channel ${channelId} is not in the Slack allowlist.`);
      }

      const fileItemId = params.file_item_id
        ? renderTemplate(params.file_item_id, vars).trim() || undefined
        : undefined;
      const filePath = params.file_path
        ? renderTemplate(params.file_path, vars).trim() || undefined
        : undefined;

      let resolved;
      try {
        resolved = await resolveMediaInput(input.context.backendPort, fileItemId, filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Send Slack File: ${msg}`);
      }

      const fileName = params.file_name
        ? renderTemplate(params.file_name, vars)
        : resolved.fileName;

      const { fileId, error } = await channel.sendFileActionMessage(channelId, resolved.absPath, {
        comment, fileName, threadTs,
      });

      if (error) {
        input.context.log(`Slack file upload failed for ${channelId}: ${error}`);
        return {
          data: { sent: false, file_id: fileId, channel: channelId, error },
          summary: `Slack file upload failed: ${error}`,
        };
      }

      input.context.log(`Uploaded Slack file to ${channelId} (file_id=${fileId})`);
      return {
        data: { sent: true, file_id: fileId, channel: channelId, error: null },
        summary: `Uploaded file to ${channelId}`,
      };
    },
  };
}
