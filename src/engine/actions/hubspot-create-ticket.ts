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
import { upsertContact } from '../../hubspot/contacts';
import { buildTicketExtras } from '../../hubspot/ticket-fields';

interface CreateTicketParams {
  subject: string;
  content: string;
  pipeline?: string;
  stage?: string;
  priority?: string;
  source_type?: string;
  contact_id?: string;
  contact_email?: string;
  /** Owner by name, email, or raw id. Preferred over owner_id. */
  owner?: string;
  /** Legacy raw owner id. Honored when `owner` is empty. */
  owner_id?: string;
  /** Follow-up user by name, email, or raw id. */
  follow_up_user?: string;
  /** Due date as YYYY-MM-DD or ISO. */
  due_date?: string;
  /** Escape hatch: HubSpot internal property name → value for any other field. */
  properties?: Record<string, unknown>;
}

const VALID_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function createHubSpotCreateTicketAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_create_ticket',
    name: 'HubSpot: Create Ticket',
    description: 'Create a support ticket in HubSpot Service Hub.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Create HubSpot ticket', es: 'Crear ticket de HubSpot' },
    chatDescription: {
      en: 'Open a new support ticket in HubSpot Service Hub. Requires subject; content is optional but recommended.',
      es: 'Abre un nuevo ticket de soporte en HubSpot Service Hub. El asunto es obligatorio; el contenido es opcional pero recomendado.',
    },
    chatExamples: [
      {
        en: "Create a HubSpot ticket: customer X can't log in.",
        es: 'Crea un ticket de HubSpot: el cliente X no puede iniciar sesión.',
      },
      {
        en: 'Open a HubSpot ticket about the failed payment for order 1234.',
        es: 'Abre un ticket de HubSpot sobre el pago fallido del pedido 1234.',
      },
      {
        en: 'Create a HubSpot ticket about the refund and assign it to María with a due date of 2026-06-10.',
        es: 'Crea un ticket de HubSpot sobre el reembolso y asígnalo a María con fecha de vencimiento 2026-06-10.',
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
        subject: { type: 'string', description: 'Ticket subject. Templated.' },
        content: { type: 'string', description: 'Ticket body / description. Templated.' },
        pipeline: { type: 'string', description: 'Ticket pipeline id. Falls back to the default configured in Integrations.' },
        stage: { type: 'string', description: 'Ticket stage id within the pipeline. Falls back to the default configured in Integrations.' },
        priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        source_type: { type: 'string' },
        contact_id: { type: 'string', description: 'Associate the ticket to an existing contact id. Takes precedence over contact_email.' },
        contact_email: { type: 'string', description: 'Associate the ticket to a contact by email. The contact is looked up and created if missing. Templated.' },
        owner: { type: 'string', description: 'Assign the ticket to a HubSpot user by name, email, or owner id. The name/email is resolved to the owner id. Templated.' },
        owner_id: { type: 'string', description: 'Legacy: assign by raw HubSpot owner id. Prefer `owner` (accepts name/email). Honored only when `owner` is empty.' },
        follow_up_user: { type: 'string', description: 'Follow-up user (usuario de seguimiento) by name, email, or owner id. Requires the follow-up property configured in the HubSpot integration settings. Templated.' },
        due_date: { type: 'string', description: 'Due date (fecha de vencimiento) as YYYY-MM-DD or ISO. Requires the due-date property configured in the HubSpot integration settings. Templated.' },
        properties: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Escape hatch: HubSpot internal property name → value for any other (including custom) ticket property. Merged last, so it overrides the named fields on conflict.',
        },
      },
      required: ['subject'],
    },

    outputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: ['string', 'null'] },
        ticket_url: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        contact_id: { type: ['string', 'null'] },
        contact_associated: { type: 'boolean' },
        owner_resolved: { type: ['string', 'null'], description: 'Owner id written, when an owner was resolved.' },
        follow_up_resolved: { type: ['string', 'null'], description: 'Follow-up owner id written, when one was resolved.' },
        due_date_set: { type: ['string', 'null'], description: 'Normalized due-date value written, when set.' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal issues, e.g. an owner name that could not be resolved or an unconfigured property.' },
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
      const explicitContactId = renderTemplate(params.contact_id ?? '', vars).trim();
      const contactEmail = renderTemplate(params.contact_email ?? '', vars).trim();

      if (!subject) {
        throw new Error('HubSpot: Create Ticket — subject is empty.');
      }
      if (!pipeline || !stage) {
        throw new Error('HubSpot: Create Ticket — pipeline and stage are required. Set defaults in the HubSpot integration panel.');
      }

      // Resolve the contact to associate. An explicit contact_id wins; otherwise
      // look up (and create-if-missing) by email so the agent can attach a
      // contact in a single action instead of chaining two approval-gated calls.
      // Association is best-effort: if resolution fails we still open the
      // ticket and report contact_associated:false rather than aborting.
      let contactId = explicitContactId;
      if (!contactId && contactEmail) {
        const resolved = await upsertContact(
          token,
          { email: contactEmail },
          input.context.signal,
          (msg) => input.context.log(msg),
        );
        if (resolved.contactId) {
          contactId = resolved.contactId;
        } else {
          input.context.log(`HubSpot create_ticket: could not resolve contact for ${contactEmail}: ${resolved.error ?? 'unknown'}`);
        }
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

      // Resolve owner-by-name/email, follow-up user, and due date into the
      // property map. Each is best-effort: an unresolved name or unconfigured
      // custom property is reported in `warnings`, not thrown.
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

      // Free-form escape hatch, merged last so explicit custom props win.
      if (params.properties && typeof params.properties === 'object') {
        for (const [key, raw] of Object.entries(params.properties)) {
          if (!key || raw === null || raw === undefined) continue;
          properties[key] = typeof raw === 'string' ? renderTemplate(raw, vars) : String(raw);
        }
      }

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
          data: {
            ticket_id: null,
            ticket_url: null,
            created: false,
            contact_id: null,
            contact_associated: false,
            owner_resolved: null,
            follow_up_resolved: null,
            due_date_set: null,
            warnings,
            error: res.error,
          },
          summary: `HubSpot create_ticket failed: ${res.error}`,
        };
      }
      const ticketId = res.data && typeof res.data.id === 'string' ? res.data.id : null;
      const portal = channel.getPortalId();
      const ticketUrl = ticketId && portal
        ? `https://app.hubspot.com/contacts/${portal}/ticket/${ticketId}`
        : null;
      const contactAssociated = Boolean(contactId);

      input.context.log(`HubSpot ticket created: ${ticketId}${contactAssociated ? ` (contact ${contactId})` : ''}`);
      for (const w of warnings) input.context.log(`HubSpot create_ticket: ${w}`);
      const baseSummary = contactAssociated
        ? `Created HubSpot ticket ${ticketId ?? '(unknown id)'} associated with contact ${contactId}`
        : `Created HubSpot ticket ${ticketId ?? '(unknown id)'}`;
      const summary = warnings.length ? `${baseSummary} — ${warnings.join('; ')}` : baseSummary;
      return {
        data: {
          ticket_id: ticketId,
          ticket_url: ticketUrl,
          created: true,
          contact_id: contactId || null,
          contact_associated: contactAssociated,
          owner_resolved: extras.ownerResolved,
          follow_up_resolved: extras.followUpResolved,
          due_date_set: extras.dueDateSet,
          warnings,
          error: null,
        },
        summary,
      };
    },
  };
}
