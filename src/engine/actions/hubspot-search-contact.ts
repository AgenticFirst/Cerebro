/**
 * hubspot_search_contact action — read-only contact lookup by email (or phone).
 *
 * Resolves a contact's id and basic identity so the agent can confirm who a
 * ticket would be attached to, or feed the id into another action. Unlike
 * `hubspot_upsert_contact`, this never creates or mutates anything.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import { findContact } from '../../hubspot/contacts';

interface SearchContactParams {
  email?: string;
  phone?: string;
}

export function createHubSpotSearchContactAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_search_contact',
    name: 'HubSpot: Search Contact',
    description:
      'Find a HubSpot contact by email or phone. Read-only. Returns contact_id and identity.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Find HubSpot contact', es: 'Buscar contacto de HubSpot' },
    chatDescription: {
      en: 'Look up a HubSpot contact by email or phone without changing anything. Returns the contact id and name if found.',
      es: 'Busca un contacto de HubSpot por correo o teléfono sin modificar nada. Devuelve el id y el nombre del contacto si existe.',
    },
    chatExamples: [
      {
        en: 'Is maria@example.com a contact in HubSpot?',
        es: '¿Está maria@example.com como contacto en HubSpot?',
      },
      {
        en: 'Find the HubSpot contact for juan@example.com.',
        es: 'Busca el contacto de HubSpot de juan@example.com.',
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
        email: { type: 'string', description: 'Contact email. Preferred lookup key. Templated.' },
        phone: {
          type: 'string',
          description: 'Contact phone. Used when email is missing. Templated.',
        },
      },
    },

    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        contact_id: { type: ['string', 'null'] },
        email: { type: ['string', 'null'] },
        firstname: { type: ['string', 'null'] },
        lastname: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['found'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error('HubSpot: Search Contact — HubSpot is not configured.');
      }
      const token = channel.getAccessToken();
      if (!token) {
        throw new Error('HubSpot: Search Contact — no access token configured.');
      }

      const params = input.params as unknown as SearchContactParams;
      const vars = input.wiredInputs ?? {};

      const email = renderTemplate(params.email ?? '', vars).trim();
      const phone = renderTemplate(params.phone ?? '', vars).trim();

      if (!email && !phone) {
        throw new Error('HubSpot: Search Contact — at least one of email or phone is required.');
      }

      const property = email ? 'email' : 'phone';
      const value = email || phone;
      const { contact, error } = await findContact(token, property, value, input.context.signal);

      if (error) {
        input.context.log(`HubSpot contact search failed: ${error}`);
        return {
          data: {
            found: false,
            contact_id: null,
            email: null,
            firstname: null,
            lastname: null,
            error,
          },
          summary: `HubSpot search_contact failed: ${error}`,
        };
      }
      if (!contact) {
        input.context.log(`HubSpot contact not found for ${property}=${value}`);
        return {
          data: {
            found: false,
            contact_id: null,
            email: null,
            firstname: null,
            lastname: null,
            error: null,
          },
          summary: `No HubSpot contact found for ${value}`,
        };
      }
      input.context.log(`HubSpot contact found: ${contact.id}`);
      return {
        data: {
          found: true,
          contact_id: contact.id,
          email: contact.properties.email ?? null,
          firstname: contact.properties.firstname ?? null,
          lastname: contact.properties.lastname ?? null,
          error: null,
        },
        summary: `Found HubSpot contact ${contact.id}`,
      };
    },
  };
}
