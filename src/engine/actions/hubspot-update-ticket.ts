/**
 * hubspot_update_ticket action — edit the property values of an existing
 * HubSpot ticket.
 *
 * Uses HubSpot's CRM v3 API (PATCH /crm/v3/objects/tickets/{id}) with a
 * Private App access token. Only the fields the caller actually sets are sent,
 * so an edit never blows away properties it didn't touch. Named convenience
 * fields (subject, content, priority, pipeline, stage, owner_id) map to their
 * HubSpot internal names; a free-form `properties` map lets the agent set any
 * other ticket property, including custom ones, and overrides the named fields.
 *
 * Like hubspot_create_ticket this is a mutation — runChatAction gates it on
 * approval automatically, so there is no requiresApproval flag here.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import { callHubSpotApi } from '../../hubspot/api';
import { buildTicketExtras } from '../../hubspot/ticket-fields';

interface UpdateTicketParams {
  ticket_id?: string;
  subject?: string;
  content?: string;
  priority?: string;
  pipeline?: string;
  stage?: string;
  /** Owner by name, email, or raw id. Preferred over owner_id. */
  owner?: string;
  /** Legacy raw owner id. Honored when `owner` is empty. */
  owner_id?: string;
  /** Follow-up user by name, email, or raw id. */
  follow_up_user?: string;
  /** Due date as YYYY-MM-DD or ISO. */
  due_date?: string;
  source_type?: string;
  properties?: Record<string, unknown>;
}

const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function createHubSpotUpdateTicketAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_update_ticket',
    name: 'HubSpot: Update Ticket',
    description:
      "Edit an existing HubSpot ticket's property values. Pass the ticket id plus the fields to change — subject, content, priority, pipeline, stage, owner, or any custom property via the properties map. Only the fields provided are updated.",

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Update HubSpot ticket', es: 'Actualizar ticket de HubSpot' },
    chatDescription: {
      en: "Edit an existing HubSpot ticket's property values by id. Set any of subject, content, priority, pipeline, stage, owner, or arbitrary custom properties. Only the fields you provide are changed; everything else is left untouched.",
      es: 'Edita los valores de las propiedades de un ticket de HubSpot por id. Cambia el asunto, contenido, prioridad, pipeline, etapa, propietario o cualquier propiedad personalizada. Solo se modifican los campos que indiques; el resto se mantiene igual.',
    },
    chatExamples: [
      {
        en: 'Change HubSpot ticket 12345 priority to High.',
        es: 'Cambia la prioridad del ticket 12345 de HubSpot a alta.',
      },
      {
        en: 'Move HubSpot ticket 12345 to the Waiting stage.',
        es: 'Mueve el ticket 12345 de HubSpot a la etapa En espera.',
      },
      {
        en: 'Update the subject of HubSpot ticket 12345 to "Refund processed".',
        es: 'Actualiza el asunto del ticket 12345 de HubSpot a «Reembolso procesado».',
      },
      {
        en: 'Reassign HubSpot ticket 12345 to juan@empresa.com and set the due date to 2026-06-10.',
        es: 'Reasigna el ticket 12345 de HubSpot a juan@empresa.com y pon la fecha de vencimiento al 2026-06-10.',
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
        ticket_id: { type: 'string', description: 'HubSpot ticket id to update. Templated.' },
        subject: { type: 'string', description: 'New ticket subject. Templated.' },
        content: { type: 'string', description: 'New ticket body / description. Templated.' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'New priority.' },
        pipeline: { type: 'string', description: 'Move the ticket to this pipeline id.' },
        stage: {
          type: 'string',
          description: 'Move the ticket to this stage id within its pipeline.',
        },
        owner: {
          type: 'string',
          description:
            'Reassign the ticket to a HubSpot user by name, email, or owner id. The name/email is resolved to the owner id. Templated.',
        },
        owner_id: {
          type: 'string',
          description:
            'Legacy: reassign by raw HubSpot owner id. Prefer `owner` (accepts name/email). Honored only when `owner` is empty.',
        },
        follow_up_user: {
          type: 'string',
          description:
            'Set the follow-up user (usuario de seguimiento) by name, email, or owner id. Requires the follow-up property configured in the HubSpot integration settings. Templated.',
        },
        due_date: {
          type: 'string',
          description:
            'Set the due date (fecha de vencimiento) as YYYY-MM-DD or ISO. Requires the due-date property configured in the HubSpot integration settings. Templated.',
        },
        source_type: { type: 'string', description: 'New source type.' },
        properties: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Free-form map of HubSpot internal property name → value for any other (including custom) ticket property. Merged on top of the named fields, so it overrides them on conflict.',
        },
      },
      required: ['ticket_id'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        updated: { type: 'boolean' },
        ticket_id: { type: ['string', 'null'] },
        updated_fields: { type: 'array', items: { type: 'string' } },
        ticket_url: { type: ['string', 'null'] },
        owner_resolved: {
          type: ['string', 'null'],
          description: 'Owner id written, when an owner was resolved.',
        },
        follow_up_resolved: {
          type: ['string', 'null'],
          description: 'Follow-up owner id written, when one was resolved.',
        },
        due_date_set: {
          type: ['string', 'null'],
          description: 'Normalized due-date value written, when set.',
        },
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Non-fatal issues, e.g. an owner name that could not be resolved or an unconfigured property.',
        },
        error: { type: ['string', 'null'] },
      },
      required: ['updated'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const channel = deps.getChannel();
      if (!channel) {
        throw new Error(
          'HubSpot: Update Ticket — HubSpot is not configured. Connect HubSpot in Integrations first.',
        );
      }
      const token = channel.getAccessToken();
      if (!token) {
        throw new Error('HubSpot: Update Ticket — no access token configured.');
      }

      const params = input.params as unknown as UpdateTicketParams;
      const vars = input.wiredInputs ?? {};

      const ticketId = renderTemplate(params.ticket_id ?? '', vars).trim();
      if (!ticketId) {
        throw new Error('HubSpot: Update Ticket — ticket_id is required.');
      }

      // Build the properties patch. Map named convenience fields to HubSpot
      // internal names, including only the ones the caller actually set so we
      // never overwrite a property the user didn't mention.
      const properties: Record<string, string> = {};

      const subject = renderTemplate(params.subject ?? '', vars).trim();
      if (subject) properties.subject = subject;

      const content = renderTemplate(params.content ?? '', vars).trim();
      if (content) properties.content = content;

      const priorityRaw = renderTemplate(params.priority ?? '', vars)
        .trim()
        .toUpperCase();
      if (priorityRaw && VALID_PRIORITIES.has(priorityRaw))
        properties.hs_ticket_priority = priorityRaw;

      const pipeline = renderTemplate(params.pipeline ?? '', vars).trim();
      if (pipeline) properties.hs_pipeline = pipeline;

      const stage = renderTemplate(params.stage ?? '', vars).trim();
      if (stage) properties.hs_pipeline_stage = stage;

      const sourceType = renderTemplate(params.source_type ?? '', vars).trim();
      if (sourceType) properties.source_type = sourceType;

      // Resolve owner-by-name/email, follow-up user, and due date. Best-effort:
      // an unresolved name or unconfigured custom property is reported in
      // `warnings` rather than thrown, so the rest of the edit still applies.
      const extras = await buildTicketExtras({
        channel,
        token,
        signal: input.context.signal,
        log: (m) => input.context.log(m),
        owner: renderTemplate(params.owner ?? '', vars).trim(),
        ownerId: renderTemplate(params.owner_id ?? '', vars).trim(),
        followUpUser: renderTemplate(params.follow_up_user ?? '', vars).trim(),
        dueDate: renderTemplate(params.due_date ?? '', vars).trim(),
      });
      Object.assign(properties, extras.props);
      const warnings = [...extras.warnings];

      // Merge the free-form properties map last so custom props (and explicit
      // overrides) win over the named fields. Values are rendered as templates
      // and stringified to match HubSpot's flat string-map property shape.
      if (params.properties && typeof params.properties === 'object') {
        for (const [key, raw] of Object.entries(params.properties)) {
          if (raw === null || raw === undefined) continue;
          const value = typeof raw === 'string' ? renderTemplate(raw, vars) : String(raw);
          properties[key] = value;
        }
      }

      const portal = channel.getPortalId();
      const ticketUrl = portal
        ? `https://app.hubspot.com/contacts/${portal}/ticket/${ticketId}`
        : null;
      const resolved = {
        owner_resolved: extras.ownerResolved,
        follow_up_resolved: extras.followUpResolved,
        due_date_set: extras.dueDateSet,
        warnings,
      };

      if (Object.keys(properties).length === 0) {
        for (const w of warnings) input.context.log(`HubSpot update_ticket: ${w}`);
        const note = warnings.length ? ` (${warnings.join('; ')})` : '';
        return {
          data: {
            updated: false,
            ticket_id: ticketId,
            updated_fields: [],
            ticket_url: null,
            ...resolved,
            error: 'no properties to update',
          },
          summary: `HubSpot update_ticket: no properties to update for ticket ${ticketId}${note}`,
        };
      }

      const res = await callHubSpotApi<Record<string, unknown>>(
        token,
        `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`,
        { method: 'PATCH', body: { properties }, signal: input.context.signal },
      );

      if (!res.ok) {
        if (res.status === 404) {
          input.context.log(`HubSpot update_ticket: ticket ${ticketId} not found`);
          return {
            data: {
              updated: false,
              ticket_id: ticketId,
              updated_fields: [],
              ticket_url: ticketUrl,
              ...resolved,
              error: 'ticket not found',
            },
            summary: `HubSpot ticket ${ticketId} not found`,
          };
        }
        input.context.log(`HubSpot update_ticket ${res.status}: ${res.error}`);
        return {
          data: {
            updated: false,
            ticket_id: ticketId,
            updated_fields: [],
            ticket_url: ticketUrl,
            ...resolved,
            error: res.error,
          },
          summary: `HubSpot update_ticket failed: ${res.error}`,
        };
      }

      const updatedFields = Object.keys(properties);
      input.context.log(`HubSpot ticket updated: ${ticketId} (${updatedFields.join(', ')})`);
      for (const w of warnings) input.context.log(`HubSpot update_ticket: ${w}`);
      const note = warnings.length ? ` — ${warnings.join('; ')}` : '';
      return {
        data: {
          updated: true,
          ticket_id: res.data && typeof res.data.id === 'string' ? res.data.id : ticketId,
          updated_fields: updatedFields,
          ticket_url: ticketUrl,
          ...resolved,
          error: null,
        },
        summary: `Updated HubSpot ticket ${ticketId}: ${updatedFields.join(', ')}${note}`,
      };
    },
  };
}
