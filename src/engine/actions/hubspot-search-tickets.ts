/**
 * hubspot_search_tickets action — read-only ticket search over HubSpot's
 * CRM v3 search API.
 *
 * Lets the chat agent answer "list the tickets created today" and similar
 * queries. Filters on createdate (epoch-ms), optionally pipeline/stage, plus
 * a free-text `query`. Pipeline and stage ids are resolved to human labels
 * via the channel's cached pipeline list so the reply reads "Waiting on us"
 * instead of "1024857". Unlike `hubspot_create_ticket`, this never mutates
 * anything.
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

interface SearchTicketsParams {
  created_after?: string;
  created_before?: string;
  query?: string;
  pipeline?: string;
  stage?: string;
  limit?: number | string;
  include_associations?: boolean | string;
}

interface TicketResult {
  id: string;
  properties: Record<string, string>;
}

/** Parse an ISO date/datetime string to epoch-ms, or null if unparseable. */
function toEpochMs(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function createHubSpotSearchTicketsAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_search_tickets',
    name: 'HubSpot: Search Tickets',
    description:
      'Search HubSpot tickets by creation date, pipeline, stage, or free text. Read-only. Returns a list of tickets.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'List HubSpot tickets', es: 'Listar tickets de HubSpot' },
    chatDescription: {
      en: 'Search HubSpot tickets by creation date, pipeline, stage, or free text without changing anything. Returns the matching tickets with subject, stage, priority and a link.',
      es: 'Busca tickets de HubSpot por fecha de creación, pipeline, etapa o texto libre sin modificar nada. Devuelve los tickets con asunto, etapa, prioridad y un enlace.',
    },
    chatExamples: [
      {
        en: 'List the HubSpot tickets created today.',
        es: 'Lista los tickets de HubSpot creados hoy.',
      },
      {
        en: 'Show me the open HubSpot tickets.',
        es: 'Muéstrame los tickets de HubSpot abiertos.',
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
        created_after: {
          type: 'string',
          description:
            'ISO date or datetime (UTC). Lower bound on the ticket creation date, inclusive. For "created today" pass the start of today (e.g. 2026-05-28). Templated.',
        },
        created_before: {
          type: 'string',
          description:
            'ISO date or datetime (UTC). Upper bound on the ticket creation date, inclusive. For "created today" pass the start of tomorrow. Templated.',
        },
        query: {
          type: 'string',
          description: 'Free-text search across ticket subject and content. Optional. Templated.',
        },
        pipeline: { type: 'string', description: 'Filter to a ticket pipeline id. Optional.' },
        stage: { type: 'string', description: 'Filter to a pipeline stage id. Optional.' },
        limit: { type: 'number', description: 'Max tickets to return. Default 50, capped at 100.' },
        include_associations: {
          type: 'boolean',
          description:
            "When true, attach each ticket's associated contacts[] and companies[] (the company is resolved through the contact when the ticket has no direct company link). Default false. Adds one batched lookup over the result page.",
        },
      },
    },

    outputSchema: {
      type: 'object',
      properties: {
        tickets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
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
              owner_name: { type: ['string', 'null'] },
              follow_up_user: { type: ['string', 'null'] },
              follow_up_name: { type: ['string', 'null'] },
              due_date: { type: ['string', 'null'] },
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
            },
          },
        },
        count: { type: 'number' },
        companies_scope_missing: {
          type: 'boolean',
          description:
            'True when include_associations was requested but companies could not be read because the HubSpot token lacks crm.objects.companies.read. Tell the user to grant the scope.',
        },
        error: { type: ['string', 'null'] },
      },
      required: ['tickets', 'count'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'HubSpot: Search Tickets — HubSpot is not configured. Connect HubSpot in Integrations first.',
        );
      }
      const token = channel.getAccessToken();
      if (!token) {
        throw new Error('HubSpot: Search Tickets — no access token configured.');
      }

      const params = input.params as unknown as SearchTicketsParams;
      const vars = input.wiredInputs ?? {};

      const createdAfter = renderTemplate(params.created_after ?? '', vars).trim();
      const createdBefore = renderTemplate(params.created_before ?? '', vars).trim();
      const query = renderTemplate(params.query ?? '', vars).trim();
      const pipeline = renderTemplate(params.pipeline ?? '', vars).trim();
      const stage = renderTemplate(params.stage ?? '', vars).trim();

      const rawLimit = typeof params.limit === 'string' ? parseInt(params.limit, 10) : params.limit;
      const limit = Math.min(
        Math.max(Number.isFinite(rawLimit as number) ? (rawLimit as number) : 50, 1),
        100,
      );

      const afterMs = createdAfter ? toEpochMs(createdAfter) : null;
      const beforeMs = createdBefore ? toEpochMs(createdBefore) : null;
      if (createdAfter && afterMs === null) {
        input.context.log(
          `HubSpot search_tickets: ignoring unparseable created_after "${createdAfter}"`,
        );
      }
      if (createdBefore && beforeMs === null) {
        input.context.log(
          `HubSpot search_tickets: ignoring unparseable created_before "${createdBefore}"`,
        );
      }

      const filters: Array<{ propertyName: string; operator: string; value: string }> = [];
      if (afterMs !== null)
        filters.push({ propertyName: 'createdate', operator: 'GTE', value: String(afterMs) });
      if (beforeMs !== null)
        filters.push({ propertyName: 'createdate', operator: 'LTE', value: String(beforeMs) });
      if (pipeline) filters.push({ propertyName: 'hs_pipeline', operator: 'EQ', value: pipeline });
      if (stage) filters.push({ propertyName: 'hs_pipeline_stage', operator: 'EQ', value: stage });

      // Pull the configured custom follow-up / due-date properties too, when set.
      const followUpProp = (channel.getFollowUpProperty() ?? '').trim();
      const dueDateProp = (channel.getDueDateProperty() ?? '').trim();
      const body: Record<string, unknown> = {
        filterGroups: filters.length ? [{ filters }] : [],
        properties: [
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
        ],
        sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
        limit,
      };
      if (query) body.query = query;

      const res = await callHubSpotApi<{ results?: TicketResult[]; total?: number }>(
        token,
        '/crm/v3/objects/tickets/search',
        { method: 'POST', body, signal: input.context.signal },
      );

      if (!res.ok) {
        input.context.log(`HubSpot search_tickets ${res.status}: ${res.error}`);
        return {
          data: { tickets: [], count: 0, error: res.error },
          summary: `HubSpot search_tickets failed: ${res.error}`,
        };
      }

      // Resolve pipeline/stage ids → human labels. Best-effort: if the lookup
      // fails we still return the tickets, just with null labels.
      const pipelineLabels = new Map<string, string>();
      const stageLabels = new Map<string, string>();
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
          `HubSpot search_tickets: pipeline label lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const portal = channel.getPortalId();
      const results = res.data?.results ?? [];
      const tickets = results.map((t) => {
        const props = t.properties ?? {};
        const pipelineId = props.hs_pipeline ?? null;
        const stageId = props.hs_pipeline_stage ?? null;
        return {
          ticket_id: t.id,
          subject: props.subject ?? null,
          content: props.content ?? null,
          pipeline: pipelineId,
          pipeline_label: pipelineId ? (pipelineLabels.get(pipelineId) ?? null) : null,
          stage: stageId,
          stage_label: stageId ? (stageLabels.get(stageId) ?? null) : null,
          priority: props.hs_ticket_priority ?? null,
          created_at: props.createdate ?? null,
          updated_at: props.hs_lastmodifieddate ?? null,
          owner_id: props.hubspot_owner_id ?? null,
          owner_name: null as string | null,
          follow_up_user: followUpProp ? (props[followUpProp] ?? null) : null,
          follow_up_name: null as string | null,
          due_date: dueDateProp ? formatHubSpotDate(props[dueDateProp]) : null,
          ticket_url: portal ? `https://app.hubspot.com/contacts/${portal}/ticket/${t.id}` : null,
          contacts: [] as Array<{
            contact_id: string;
            email: string | null;
            firstname: string | null;
            lastname: string | null;
          }>,
          companies: [] as Array<{
            company_id: string;
            name: string | null;
            domain: string | null;
            source: 'ticket' | 'contact';
            via_contact_id: string | null;
          }>,
        };
      });

      // Resolve owner + follow-up user ids → display names in one batched call.
      // Best-effort: a failed lookup just leaves the names null.
      const ownerIds = new Set<string>();
      for (const t of tickets) {
        if (t.owner_id) ownerIds.add(t.owner_id);
        if (t.follow_up_user) ownerIds.add(t.follow_up_user);
      }
      if (ownerIds.size > 0) {
        try {
          const names = await ownerDisplayNames(token, [...ownerIds], input.context.signal);
          for (const t of tickets) {
            if (t.owner_id) t.owner_name = names.get(t.owner_id) ?? null;
            if (t.follow_up_user) t.follow_up_name = names.get(t.follow_up_user) ?? null;
          }
        } catch (err) {
          input.context.log(
            `HubSpot search_tickets: owner name lookup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Opt-in association enrichment. Best-effort — like the pipeline-label
      // lookup above, a failure here keeps the tickets and just leaves the
      // arrays empty rather than failing the whole search.
      const includeAssociations =
        params.include_associations === true ||
        String(params.include_associations ?? '').toLowerCase() === 'true';
      let companiesScopeMissing = false;
      if (includeAssociations && tickets.length > 0) {
        const assoc = await resolveTicketAssociations(
          token,
          tickets.map((t) => t.ticket_id),
          input.context.signal,
        );
        if (assoc.error) {
          input.context.log(`HubSpot search_tickets: association lookup failed: ${assoc.error}`);
        }
        companiesScopeMissing = assoc.companiesScopeMissing;
        if (assoc.companiesScopeMissing) {
          input.context.log(
            'HubSpot search_tickets: companies unavailable — token lacks crm.objects.companies.read',
          );
        }
        for (const ticket of tickets) {
          const resolved = assoc.byTicket.get(ticket.ticket_id);
          if (!resolved) continue;
          ticket.contacts = toContactOutputs(resolved.contacts);
          ticket.companies = toCompanyOutputs(resolved.companies);
        }
      }

      input.context.log(`HubSpot search_tickets: found ${tickets.length} ticket(s)`);
      const scopeNote = companiesScopeMissing
        ? ' (companies not returned — grant crm.objects.companies.read on the HubSpot Private App)'
        : '';
      return {
        data: {
          tickets,
          count: tickets.length,
          companies_scope_missing: companiesScopeMissing,
          error: null,
        },
        summary: `Found ${tickets.length} HubSpot ticket(s)${scopeNote}`,
      };
    },
  };
}
