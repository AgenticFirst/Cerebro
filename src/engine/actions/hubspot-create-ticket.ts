/**
 * hubspot_create_ticket action — opens a new ticket in HubSpot Service Hub.
 *
 * Uses HubSpot's CRM v3 API with a Private App access token. Subject and
 * content are rendered with Mustache against wiredInputs, so the template
 * routine can feed them from upstream `extract` / `ask_ai` steps.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import { callHubSpotApi } from '../../hubspot/api';

interface CreateTicketParams {
  subject: string;
  content: string;
  pipeline?: string;
  stage?: string;
  priority?: string;
  source_type?: string;
  contact_id?: string;
  owner_id?: string;
}

const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function createHubSpotCreateTicketAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_create_ticket',
    name: 'HubSpot: Create Ticket',
    description: 'Create a support ticket in HubSpot Service Hub.',

    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Ticket subject. Templated.' },
        content: { type: 'string', description: 'Ticket body / description. Templated.' },
        pipeline: { type: 'string', description: 'Ticket pipeline id. Falls back to the default configured in Integrations.' },
        stage: { type: 'string', description: 'Ticket stage id within the pipeline. Falls back to the default configured in Integrations.' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        source_type: { type: 'string' },
        contact_id: { type: 'string', description: 'Associate the ticket to an existing contact id.' },
        owner_id: { type: 'string' },
      },
      required: ['subject'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: ['string', 'null'] },
        ticket_url: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error('HubSpot: Create Ticket — HubSpot is not configured. Connect HubSpot in Integrations first.');
      }
      const token = channel.getAccessToken();
      if (!token) {
        throw new Error('HubSpot: Create Ticket — no access token configured.');
      }

      const params = input.params as unknown as CreateTicketParams;
      const vars = input.wiredInputs ?? {};

      const subject = renderTemplate(params.subject ?? '', vars).trim();
      const content = renderTemplate(params.content ?? '', vars).trim();
      const pipeline = renderTemplate(params.pipeline ?? '', vars).trim() || channel.getDefaultPipeline() || '';
      const stage = renderTemplate(params.stage ?? '', vars).trim() || channel.getDefaultStage() || '';
      const priorityRaw = renderTemplate(params.priority ?? '', vars).trim().toUpperCase();
      const priority = priorityRaw && VALID_PRIORITIES.has(priorityRaw) ? priorityRaw : null;
      const sourceType = renderTemplate(params.source_type ?? '', vars).trim();
      const contactId = renderTemplate(params.contact_id ?? '', vars).trim();
      const ownerId = renderTemplate(params.owner_id ?? '', vars).trim();

      if (!subject) {
        throw new Error('HubSpot: Create Ticket — subject is empty.');
      }
      if (!pipeline || !stage) {
        throw new Error('HubSpot: Create Ticket — pipeline and stage are required. Set defaults in the HubSpot integration panel.');
      }

      // HubSpot CRM v3: POST /crm/v3/objects/tickets
      // Properties are a flat map of internal names. hs_pipeline_stage is the
      // canonical stage field; subject / content are the user-visible ones.
      const properties: Record<string, string> = {
        subject,
        hs_pipeline: pipeline,
        hs_pipeline_stage: stage,
      };
      if (content) properties.content = content;
      if (priority) properties.hs_ticket_priority = priority;
      if (sourceType) properties.source_type = sourceType;
      if (ownerId) properties.hubspot_owner_id = ownerId;

      const body: Record<string, unknown> = { properties };
      if (contactId) {
        body.associations = [
          {
            to: { id: contactId },
            // 16 = ticket_to_contact default association
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
          },
        ];
      }

      const res = await callHubSpotApi<Record<string, unknown>>(token, '/crm/v3/objects/tickets', {
        method: 'POST',
        body,
        signal: input.context.signal,
      });
      if (!res.ok) {
        input.context.log(`HubSpot create_ticket ${res.status}: ${res.error}`);
        return {
          data: { ticket_id: null, ticket_url: null, created: false, error: res.error },
          summary: `HubSpot create_ticket failed: ${res.error}`,
        };
      }
      const ticketId = res.data && typeof res.data.id === 'string' ? res.data.id : null;
      const portal = channel.getPortalId();
      const ticketUrl = ticketId && portal
        ? `https://app.hubspot.com/contacts/${portal}/ticket/${ticketId}`
        : null;

      input.context.log(`HubSpot ticket created: ${ticketId}`);
      return {
        data: { ticket_id: ticketId, ticket_url: ticketUrl, created: true, error: null },
        summary: `Created HubSpot ticket ${ticketId ?? '(unknown id)'}`,
      };
    },
  };
}
