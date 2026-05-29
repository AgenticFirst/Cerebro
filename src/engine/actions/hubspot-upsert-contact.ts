/**
 * hubspot_upsert_contact action — idempotent contact creation in HubSpot.
 *
 * Searches by email (preferred) or phone, updates the matching contact if
 * found, creates a new one otherwise. Returns the contact id so downstream
 * `hubspot_create_ticket` can associate the ticket.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import { upsertContact } from '../../hubspot/contacts';

interface UpsertContactParams {
  email?: string;
  phone?: string;
  firstname?: string;
  lastname?: string;
  lifecyclestage?: string;
}

export function createHubSpotUpsertContactAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_upsert_contact',
    name: 'HubSpot: Upsert Contact',
    description: 'Find a HubSpot contact by email or phone, create if missing. Returns contact_id.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Add or update HubSpot contact', es: 'Crear o actualizar contacto de HubSpot' },
    chatDescription: {
      en: 'Find a HubSpot contact by email or phone, update them if they exist or create them otherwise.',
      es: 'Busca un contacto de HubSpot por correo o teléfono; lo actualiza si existe, lo crea si no.',
    },
    chatExamples: [
      {
        en: 'Add Maria Lopez (maria@example.com) to HubSpot.',
        es: 'Agrega a María López (maria@example.com) a HubSpot.',
      },
    ],
    availabilityCheck: () => {
      const ch = deps.getChannel();
      if (!ch) return 'not_connected';
      return ch.isConnected() ? 'available' : 'not_connected';
    },
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Customer email. Preferred key for lookup. Templated.' },
        phone: { type: 'string', description: 'Customer phone. Used when email is missing. Templated.' },
        firstname: { type: 'string' },
        lastname: { type: 'string' },
        lifecyclestage: { type: 'string' },
      },
    },

    outputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        matched_by: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['contact_id'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error('HubSpot: Upsert Contact — HubSpot is not configured.');
      }
      const token = channel.getAccessToken();
      if (!token) {
        throw new Error('HubSpot: Upsert Contact — no access token configured.');
      }

      const params = input.params as unknown as UpsertContactParams;
      const vars = input.wiredInputs ?? {};

      const email = renderTemplate(params.email ?? '', vars).trim();
      const phone = renderTemplate(params.phone ?? '', vars).trim();
      const firstname = renderTemplate(params.firstname ?? '', vars).trim();
      const lastname = renderTemplate(params.lastname ?? '', vars).trim();
      const lifecyclestage = renderTemplate(params.lifecyclestage ?? '', vars).trim();

      if (!email && !phone) {
        throw new Error('HubSpot: Upsert Contact — at least one of email or phone is required.');
      }

      const result = await upsertContact(
        token,
        { email, phone, firstname, lastname, lifecyclestage },
        input.context.signal,
        (msg) => input.context.log(msg),
      );

      if (!result.contactId && result.error) {
        return {
          data: { contact_id: null, created: false, matched_by: null, error: result.error },
          summary: `HubSpot upsert_contact failed: ${result.error}`,
        };
      }
      if (result.matchedBy) {
        return {
          data: { contact_id: result.contactId, created: false, matched_by: result.matchedBy, error: null },
          summary: `Matched HubSpot contact ${result.contactId}`,
        };
      }
      return {
        data: { contact_id: result.contactId, created: true, matched_by: null, error: null },
        summary: `Created HubSpot contact ${result.contactId ?? '(unknown id)'}`,
      };
    },
  };
}
