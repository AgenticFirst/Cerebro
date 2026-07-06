/**
 * gmail_log_to_hubspot — log an email conversation onto a HubSpot contact's
 * timeline as a Note engagement (the connected-inbox pattern: outreach sent
 * via Gmail becomes visible to the whole team in the CRM).
 *
 * Needs BOTH channels connected. The contact is resolved by email; a missing
 * `crm.objects.notes` scope on the Private App is surfaced as a fix-it
 * warning rather than a dead end (mirrors the companies_scope_missing UX).
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import { callHubSpotApi } from '../../hubspot/api';
import type { GmailChannel } from './gmail-channel';
import type { HubSpotChannel } from './hubspot-channel';

interface LogParams {
  thread_id: string;
  contact_email?: string;
}

/** note ↔ contact association type id (HubSpot-defined). */
const NOTE_TO_CONTACT = 202;

export function createGmailLogToHubSpotAction(deps: {
  getChannel: () => GmailChannel | null;
  getHubSpot: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'gmail_log_to_hubspot',
    name: 'Gmail: Log to HubSpot',
    description: "Log an email thread as a note on the matching HubSpot contact's timeline.",

    chatExposable: true,
    chatGroup: 'gmail',
    chatLabel: { en: 'Log email to HubSpot', es: 'Registrar correo en HubSpot' },
    chatDescription: {
      en: 'Copy an email conversation onto the HubSpot contact record so your team sees the outreach.',
      es: 'Copia una conversación de correo a la ficha del contacto en HubSpot para que tu equipo vea el seguimiento.',
    },
    chatExamples: [
      {
        en: 'Log that email thread with Alice to HubSpot',
        es: 'Registra ese hilo de correo con Alice en HubSpot',
      },
    ],
    availabilityCheck: () => {
      const gmail = deps.getChannel();
      const hubspot = deps.getHubSpot();
      if (!gmail?.isConnected()) return 'not_connected';
      return hubspot?.getAccessToken() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread id to log. Templated.' },
        contact_email: {
          type: 'string',
          description: 'HubSpot contact email. Defaults to the external counterpart on the thread.',
        },
      },
      required: ['thread_id'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        logged: { type: 'boolean' },
        contact_id: { type: ['string', 'null'] },
        note_id: { type: ['string', 'null'] },
        warnings: { type: 'array' },
      },
      required: ['logged'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const gmail = deps.getChannel();
      const hubspot = deps.getHubSpot();
      if (!gmail) throw new Error('Gmail: Log to HubSpot — no Gmail account connected.');
      const token = hubspot?.getAccessToken();
      if (!token) throw new Error('Gmail: Log to HubSpot — HubSpot is not connected.');

      const params = input.params as unknown as LogParams;
      const vars = input.wiredInputs ?? {};
      const threadId = renderTemplate(params.thread_id ?? '', vars).trim();
      if (!threadId) throw new Error('Gmail: Log to HubSpot — thread_id is required.');

      const thread = await gmail.getThread(threadId);
      if (!thread.messages.length) {
        throw new Error('Gmail: Log to HubSpot — thread has no messages.');
      }

      // Counterpart = explicit param, else the first non-outbound sender.
      const explicit = params.contact_email
        ? renderTemplate(params.contact_email, vars).trim()
        : '';
      const inbound = thread.messages.find((m) => !m.labelIds.includes('SENT'));
      const rawFrom = inbound?.from ?? thread.messages[0].from;
      const email = explicit || (rawFrom.match(/<([^>]+)>/)?.[1] ?? rawFrom).trim();
      if (!email) throw new Error('Gmail: Log to HubSpot — could not determine the contact email.');

      // Resolve the HubSpot contact by email.
      const search = await callHubSpotApi<{ results?: Array<{ id: string }> }>(
        token,
        '/crm/v3/objects/contacts/search',
        {
          method: 'POST',
          body: {
            filterGroups: [
              {
                filters: [{ propertyName: 'email', operator: 'EQ', value: email.toLowerCase() }],
              },
            ],
            limit: 1,
          },
        },
      );
      if (!search.ok) {
        throw new Error(`Gmail: Log to HubSpot — contact lookup failed: ${search.error}`);
      }
      const contactId = search.data?.results?.[0]?.id;
      if (!contactId) {
        return {
          data: {
            logged: false,
            contact_id: null,
            note_id: null,
            warnings: [`No HubSpot contact found for ${email} — create the contact first.`],
          },
          summary: `No HubSpot contact for ${email}`,
        };
      }

      // Compose the note body from the thread (capped).
      const lines = thread.messages.slice(-6).map((m) => {
        const who = m.labelIds.includes('SENT') ? 'Me' : m.from;
        return `<b>${who}</b> (${m.receivedAt}):<br>${(m.bodyText || m.snippet).slice(0, 1_000).replace(/\n/g, '<br>')}`;
      });
      const noteBody = `<b>Email — ${thread.subject}</b><br><br>${lines.join('<br><br>')}`;

      const note = await callHubSpotApi<{ id?: string }>(token, '/crm/v3/objects/notes', {
        method: 'POST',
        body: {
          properties: { hs_note_body: noteBody, hs_timestamp: new Date().toISOString() },
          associations: [
            {
              to: { id: contactId },
              types: [
                { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT },
              ],
            },
          ],
        },
      });
      if (!note.ok) {
        const scopeHint = /scope|403|MISSING_SCOPES/i.test(note.error ?? '')
          ? 'The HubSpot Private App likely lacks the crm.objects.notes read+write scope — add it under Settings → Integrations → Private Apps (the token does not change).'
          : null;
        return {
          data: {
            logged: false,
            contact_id: contactId,
            note_id: null,
            warnings: [note.error ?? 'Note creation failed', ...(scopeHint ? [scopeHint] : [])],
          },
          summary: `Failed to log email to HubSpot: ${note.error}`,
        };
      }

      input.context.log(`Logged Gmail thread ${threadId} to HubSpot contact ${contactId}`);
      return {
        data: { logged: true, contact_id: contactId, note_id: note.data?.id ?? null, warnings: [] },
        summary: `Logged "${thread.subject}" to HubSpot contact ${email}`,
      };
    },
  };
}
