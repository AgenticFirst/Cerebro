/**
 * hubspot_get_ticket action — read-only fetch of a single HubSpot ticket by id,
 * resolved together with its associated contacts and companies.
 *
 * This is the action that answers "which company is this ticket from?". In
 * HubSpot the company is usually not linked to the ticket directly — it hangs
 * off the ticket's associated contact — so `companies[]` carries a `source`
 * ('ticket' vs 'contact') and `via_contact_id` so the reply can say "Acme, via
 * the contact". Unlike `hubspot_create_ticket`, this never mutates anything.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import { callHubSpotApi } from '../../hubspot/api';
import {
  resolveTicketAssociations,
  toContactOutputs,
  toCompanyOutputs,
} from '../../hubspot/associations';
import { ownerDisplayNames } from '../../hubspot/owners';
import { formatHubSpotDate } from '../../hubspot/ticket-fields';

interface GetTicketParams {
  ticket_id?: string;
}

interface TicketObject {
  id: string;
  properties?: Record<string, string>;
}

export function createHubSpotGetTicketAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_get_ticket',
    name: 'HubSpot: Get Ticket',
    description:
      'Fetch one HubSpot ticket by id, including its associated contacts and companies (the company is resolved through the contact when the ticket has no direct company link). Read-only.',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Get HubSpot ticket', es: 'Obtener ticket de HubSpot' },
    chatDescription: {
      en: 'Fetch a single HubSpot ticket by id together with its associated contacts and companies. The company is resolved through the associated contact when the ticket has no direct company link. Read-only.',
      es: 'Obtiene un ticket de HubSpot por id junto con sus contactos y empresas asociadas. La empresa se resuelve a través del contacto asociado cuando el ticket no tiene empresa vinculada directamente. Solo lectura.',
    },
    chatExamples: [
      {
        en: 'Which company is HubSpot ticket 12345 from?',
        es: '¿De qué empresa es el ticket 12345 de HubSpot?',
      },
      {
        en: 'Show me the contact on HubSpot ticket 12345.',
        es: 'Muéstrame el contacto del ticket 12345 de HubSpot.',
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
        ticket_id: { type: 'string', description: 'HubSpot ticket id. Templated.' },
      },
      required: ['ticket_id'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        ticket_id: { type: ['string', 'null'] },
        subject: { type: ['string', 'null'] },
        content: { type: ['string', 'null'] },
        pipeline: { type: ['string', 'null'] },
        pipeline_label: { type: ['string', 'null'] },
        stage: { type: ['string', 'null'] },
        stage_label: { type: ['string', 'null'] },
        priority: { type: ['string', 'null'] },
        created_at: { type: ['string', 'null'] },
        updated_at: { type: ['string', 'null'] },
        owner_id: { type: ['string', 'null'] },
        owner_name: {
          type: ['string', 'null'],
          description: 'Display name of the ticket owner, resolved from owner_id.',
        },
        follow_up_user: {
          type: ['string', 'null'],
          description: 'Follow-up user id, when a follow-up property is configured.',
        },
        follow_up_name: {
          type: ['string', 'null'],
          description: 'Display name of the follow-up user.',
        },
        due_date: {
          type: ['string', 'null'],
          description: 'Due date as YYYY-MM-DD, when a due-date property is configured.',
        },
        ticket_url: { type: ['string', 'null'] },
        contacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              contact_id: { type: ['string', 'null'] },
              email: { type: ['string', 'null'] },
              firstname: { type: ['string', 'null'] },
              lastname: { type: ['string', 'null'] },
            },
          },
        },
        companies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              company_id: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
              domain: { type: ['string', 'null'] },
              source: { type: ['string', 'null'] },
              via_contact_id: { type: ['string', 'null'] },
            },
          },
        },
        companies_scope_missing: {
          type: 'boolean',
          description:
            'True when companies could not be read because the HubSpot token lacks crm.objects.companies.read. Contacts still resolve; tell the user to grant the scope.',
        },
        error: { type: ['string', 'null'] },
      },
      required: ['found'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'HubSpot: Get Ticket — HubSpot is not configured. Connect HubSpot in Integrations first.',
        );
      }
      const token = channel.getAccessToken();
      if (!token) {
        throw new Error('HubSpot: Get Ticket — no access token configured.');
      }

      const params = input.params as unknown as GetTicketParams;
      const vars = input.wiredInputs ?? {};
      const ticketId = renderTemplate(params.ticket_id ?? '', vars).trim();
      if (!ticketId) {
        throw new Error('HubSpot: Get Ticket — ticket_id is required.');
      }

      // Pull the configured custom follow-up / due-date properties too, when set.
      const followUpProp = (channel.getFollowUpProperty() ?? '').trim();
      const dueDateProp = (channel.getDueDateProperty() ?? '').trim();
      const propList = [
        'subject',
        'content',
        'hs_pipeline',
        'hs_pipeline_stage',
        'hs_ticket_priority',
        'createdate',
        'hs_lastmodifieddate',
        'hubspot_owner_id',
        ...(followUpProp ? [followUpProp] : []),
        ...(dueDateProp ? [dueDateProp] : []),
      ];
      const res = await callHubSpotApi<TicketObject>(
        token,
        `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}?properties=${encodeURIComponent(propList.join(','))}`,
        { method: 'GET', signal: input.context.signal },
      );

      const emptyAssoc = { contacts: [], companies: [], companies_scope_missing: false };
      if (!res.ok) {
        if (res.status === 404) {
          input.context.log(`HubSpot get_ticket: ticket ${ticketId} not found`);
          return {
            data: { found: false, ticket_id: ticketId, ...emptyAssoc, error: null },
            summary: `HubSpot ticket ${ticketId} not found`,
          };
        }
        input.context.log(`HubSpot get_ticket ${res.status}: ${res.error}`);
        return {
          data: { found: false, ticket_id: ticketId, ...emptyAssoc, error: res.error },
          summary: `HubSpot get_ticket failed: ${res.error}`,
        };
      }

      const ticketProps = res.data?.properties ?? {};
      const pipelineId = ticketProps.hs_pipeline ?? null;
      const stageId = ticketProps.hs_pipeline_stage ?? null;

      // Resolve pipeline/stage ids → human labels. Best-effort, and only worth
      // the call when the ticket actually has a pipeline/stage to label.
      const pipelineLabels = new Map<string, string>();
      const stageLabels = new Map<string, string>();
      if (pipelineId || stageId) {
        try {
          const pl = await channel.listPipelines();
          if (pl.ok && pl.pipelines) {
            for (const p of pl.pipelines) {
              pipelineLabels.set(p.id, p.label);
              for (const s of p.stages) stageLabels.set(s.id, s.label);
            }
          }
        } catch (err) {
          input.context.log(
            `HubSpot get_ticket: pipeline label lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Resolve associated contacts + companies (ticket → contact → company).
      const assoc = await resolveTicketAssociations(token, [ticketId], input.context.signal);
      const resolved = assoc.byTicket.get(ticketId) ?? { contacts: [], companies: [] };
      const contacts = toContactOutputs(resolved.contacts);
      const companies = toCompanyOutputs(resolved.companies);

      let scopeNote = '';
      if (assoc.companiesScopeMissing) {
        scopeNote =
          ' (companies not returned — grant crm.objects.companies.read on the HubSpot Private App)';
        input.context.log(
          'HubSpot get_ticket: companies unavailable — token lacks crm.objects.companies.read',
        );
      } else if (assoc.error) {
        input.context.log(`HubSpot get_ticket: association lookup failed: ${assoc.error}`);
      }

      // Resolve owner + follow-up user ids to display names. Best-effort.
      const ownerId = ticketProps.hubspot_owner_id ?? null;
      const followUpId = followUpProp ? (ticketProps[followUpProp] ?? null) : null;
      let ownerName: string | null = null;
      let followUpName: string | null = null;
      const idsToResolve = [ownerId, followUpId].filter((v): v is string => Boolean(v));
      if (idsToResolve.length > 0) {
        try {
          const names = await ownerDisplayNames(token, idsToResolve, input.context.signal);
          if (ownerId) ownerName = names.get(ownerId) ?? null;
          if (followUpId) followUpName = names.get(followUpId) ?? null;
        } catch (err) {
          input.context.log(
            `HubSpot get_ticket: owner name lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const dueDate = dueDateProp ? formatHubSpotDate(ticketProps[dueDateProp]) : null;

      const portal = channel.getPortalId();
      const company = companies[0];
      const companySummary = company
        ? `, company: ${company.name ?? company.id}${company.source === 'contact' ? ' (via contact)' : ''}`
        : '';

      input.context.log(
        `HubSpot get_ticket: ${ticketId} → ${contacts.length} contact(s), ${companies.length} company(ies)`,
      );
      return {
        data: {
          found: true,
          ticket_id: res.data?.id ?? ticketId,
          subject: ticketProps.subject ?? null,
          content: ticketProps.content ?? null,
          pipeline: pipelineId,
          pipeline_label: pipelineId ? (pipelineLabels.get(pipelineId) ?? null) : null,
          stage: stageId,
          stage_label: stageId ? (stageLabels.get(stageId) ?? null) : null,
          priority: ticketProps.hs_ticket_priority ?? null,
          created_at: ticketProps.createdate ?? null,
          updated_at: ticketProps.hs_lastmodifieddate ?? null,
          owner_id: ownerId,
          owner_name: ownerName,
          follow_up_user: followUpId,
          follow_up_name: followUpName,
          due_date: dueDate,
          ticket_url: portal
            ? `https://app.hubspot.com/contacts/${portal}/ticket/${ticketId}`
            : null,
          contacts,
          companies,
          companies_scope_missing: assoc.companiesScopeMissing,
          error: null,
        },
        summary: `HubSpot ticket ${ticketId}${companySummary}${scopeNote}`,
      };
    },
  };
}
