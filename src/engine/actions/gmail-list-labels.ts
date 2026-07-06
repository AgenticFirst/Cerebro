/**
 * gmail_list_labels — list system + user labels (ids needed by
 * gmail_modify_labels). Read-only: skips the approval gate.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import type { GmailChannel } from './gmail-channel';

export function createGmailListLabelsAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_list_labels',
    name: 'Gmail: List Labels',
    description: 'List Gmail labels (system + user) with their ids.',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'List Gmail labels', es: 'Listar etiquetas de Gmail' },
    chatDescription: {
      en: 'See the labels/folders in your Gmail account (needed before labeling or archiving).',
      es: 'Ver las etiquetas/carpetas de tu cuenta de Gmail (necesario antes de etiquetar o archivar).',
    },
    chatExamples: [{ en: 'What labels do I have in Gmail?', es: '¿Qué etiquetas tengo en Gmail?' }],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      return ch?.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#gmail',

    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      properties: { count: { type: 'number' }, labels: { type: 'array' } },
      required: ['labels'],
    },

    execute: async (_input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: List Labels — no Gmail account connected.');
      const labels = await channel.listLabels();
      return {
        data: { count: labels.length, labels },
        summary: `Listed ${labels.length} Gmail label${labels.length === 1 ? '' : 's'}`,
      };
    },
  };
}
