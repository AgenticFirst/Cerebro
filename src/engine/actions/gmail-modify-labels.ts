/**
 * gmail_modify_labels — archive, mark read/unread, star, or apply labels to
 * messages. Mutates mailbox state (recoverable, nothing external), so it sits
 * behind the approval gate by default; users who triage via chat typically add
 * an auto-approval rule for it.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { GmailChannel } from './gmail-channel';

interface ModifyParams {
  message_ids: string;
  add_labels?: string;
  remove_labels?: string;
}

function splitIds(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createGmailModifyLabelsAction(deps: {
  getChannel: () => GmailChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_modify_labels',
    name: 'Gmail: Modify Labels',
    description:
      'Add/remove labels on messages — archive (remove INBOX), mark read (remove UNREAD), star, custom labels.',

    chatExposable: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Archive / label emails', es: 'Archivar / etiquetar correos' },
    chatDescription: {
      en: 'Archive messages, mark them read/unread, or apply Gmail labels (label ids from gmail_list_labels).',
      es: 'Archiva mensajes, márcalos como leídos/no leídos o aplica etiquetas de Gmail (ids desde gmail_list_labels).',
    },
    chatExamples: [
      { en: 'Archive all those newsletter emails', es: 'Archiva todos esos correos de boletines' },
      { en: 'Mark that thread as read', es: 'Marca ese hilo como leído' },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      return ch?.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#gmail',

    inputSchema: {
      type: 'object',
      properties: {
        message_ids: {
          type: 'string',
          description: 'Gmail message id(s), comma-separated. Templated.',
        },
        add_labels: {
          type: 'string',
          description: 'Label ids to add, comma-separated (e.g. STARRED, Label_12).',
        },
        remove_labels: {
          type: 'string',
          description:
            'Label ids to remove, comma-separated (INBOX = archive, UNREAD = mark read).',
        },
      },
      required: ['message_ids'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        modified: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['modified'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) throw new Error('Gmail: Modify Labels — no Gmail account connected.');
      const params = input.params as unknown as ModifyParams;
      const vars = input.wiredInputs ?? {};

      const ids = splitIds(renderTemplate(params.message_ids ?? '', vars));
      const add = params.add_labels ? splitIds(renderTemplate(params.add_labels, vars)) : [];
      const remove = params.remove_labels
        ? splitIds(renderTemplate(params.remove_labels, vars))
        : [];
      if (!ids.length) throw new Error('Gmail: Modify Labels — message_ids is empty.');
      if (!add.length && !remove.length) {
        throw new Error('Gmail: Modify Labels — nothing to change (no labels given).');
      }

      const result = await channel.modifyLabels(ids, add, remove);
      if (!result.ok) {
        return {
          data: { modified: 0, error: result.error ?? null },
          summary: `Label change failed: ${result.error}`,
        };
      }
      const verbs: string[] = [];
      if (remove.includes('INBOX')) verbs.push('archived');
      if (remove.includes('UNREAD')) verbs.push('marked read');
      if (add.includes('UNREAD')) verbs.push('marked unread');
      if (add.includes('STARRED')) verbs.push('starred');
      const what = verbs.length ? verbs.join(' + ') : 'relabeled';
      return {
        data: { modified: ids.length, error: null },
        summary: `${what} ${ids.length} message${ids.length === 1 ? '' : 's'}`,
      };
    },
  };
}
