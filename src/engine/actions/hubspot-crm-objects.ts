/**
 * Generic HubSpot CRM-object actions: list / create / update / delete for
 * contacts, companies, and deals, driven by an `object_type` param.
 *
 * HubSpot's object API is uniform across these three types, so one set of
 * parameterized actions covers them instead of a dozen near-identical files.
 * The bridge helpers in `src/hubspot/crm-objects.ts` own the property
 * allowlists, required-field rules, and the contacts→upsert delegation.
 *
 * Common fields are exposed as named optional params so the chat agent has
 * concrete, documented properties to fill (and approval summaries read
 * cleanly); `properties` is an escape hatch for anything exotic. Named fields
 * win over the escape hatch on conflict.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import {
  CRM_OBJECT_PROPS,
  CRM_OBJECT_TYPES,
  crmObjectUrl,
  createCrmObject,
  deleteCrmObject,
  isCrmObjectType,
  listCrmObjects,
  updateCrmObject,
  type CrmObjectType,
} from '../../hubspot/crm-objects';
import { resolveObjectAssociations, type ObjectAssociations } from '../../hubspot/associations';

/** Named property params surfaced in the input schemas (superset across types). */
const NAMED_FIELDS = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'company',
  'lifecyclestage',
  'name',
  'domain',
  'industry',
  'dealname',
  'amount',
  'dealstage',
  'pipeline',
] as const;

/** Schema fragment shared by create + update for the named property fields. */
const NAMED_FIELD_SCHEMA: Record<string, { type: string; description: string }> = {
  // contacts
  email: { type: 'string', description: 'Contact email. Templated.' },
  firstname: { type: 'string', description: 'Contact first name. Templated.' },
  lastname: { type: 'string', description: 'Contact last name. Templated.' },
  phone: { type: 'string', description: 'Contact phone. Templated.' },
  company: { type: 'string', description: 'Contact company name (free text). Templated.' },
  lifecyclestage: { type: 'string', description: 'Contact lifecycle stage. Templated.' },
  // companies
  name: { type: 'string', description: 'Company name. Templated.' },
  domain: { type: 'string', description: 'Company domain, e.g. acme.com. Templated.' },
  industry: { type: 'string', description: 'Company industry. Templated.' },
  // deals
  dealname: {
    type: 'string',
    description: 'Deal name. Required when object_type is deals. Templated.',
  },
  amount: { type: 'string', description: 'Deal amount (number as string). Templated.' },
  dealstage: { type: 'string', description: 'Deal stage id. Templated.' },
  pipeline: { type: 'string', description: 'Deal pipeline id. Templated.' },
};

const OBJECT_TYPE_SCHEMA = {
  type: 'string',
  enum: CRM_OBJECT_TYPES,
  description:
    'Which HubSpot object: "contacts" (people), "companies" (empresas), or "deals" (negocios). Templated.',
};

/** Render every named field + the escape-hatch `properties` into one map. */
function gatherProps(
  params: Record<string, unknown>,
  vars: Record<string, unknown>,
): Record<string, string> {
  const props: Record<string, string> = {};
  const escape = params.properties;
  if (escape && typeof escape === 'object') {
    for (const [key, value] of Object.entries(escape as Record<string, unknown>)) {
      if (value !== undefined && value !== null && value !== '') props[key] = String(value);
    }
  }
  for (const field of NAMED_FIELDS) {
    const raw = params[field];
    if (raw === undefined || raw === null) continue;
    const rendered = renderTemplate(String(raw), vars).trim();
    if (rendered) props[field] = rendered;
  }
  return props;
}

function requireChannel(
  deps: { getChannel: () => HubSpotChannel | null },
  actionName: string,
): { channel: HubSpotChannel; token: string } {
  const channel = deps.getChannel();
  if (!channel) {
    throw new Error(
      `${actionName} — HubSpot is not configured. Connect HubSpot in Integrations first.`,
    );
  }
  const token = channel.getAccessToken();
  if (!token) {
    throw new Error(`${actionName} — no access token configured.`);
  }
  return { channel, token };
}

function resolveObjectType(
  params: Record<string, unknown>,
  vars: Record<string, unknown>,
  actionName: string,
): CrmObjectType {
  const raw = renderTemplate(String(params.object_type ?? ''), vars)
    .trim()
    .toLowerCase();
  if (!isCrmObjectType(raw)) {
    throw new Error(
      `${actionName} — object_type must be one of ${CRM_OBJECT_TYPES.join(', ')} (got "${raw}").`,
    );
  }
  return raw;
}

function availability(deps: {
  getChannel: () => HubSpotChannel | null;
}): 'available' | 'not_connected' {
  const ch = deps.getChannel();
  if (!ch) return 'not_connected';
  return ch.isConnected() ? 'available' : 'not_connected';
}

// ── hubspot_list_objects ──────────────────────────────────────────────

export function createHubSpotListObjectsAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_list_objects',
    name: 'HubSpot: List Objects',
    description:
      'List or search HubSpot contacts, companies, or deals. Read-only. Filter by free text or specific fields (email, domain, name, dealstage, pipeline).',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'List HubSpot records', es: 'Listar registros de HubSpot' },
    chatDescription: {
      en: 'List or search HubSpot contacts, companies (empresas), or deals (negocios) without changing anything. Returns matching records with their key fields and a link.',
      es: 'Lista o busca contactos, empresas o negocios de HubSpot sin modificar nada. Devuelve los registros con sus campos principales y un enlace.',
    },
    chatExamples: [
      { en: 'List my HubSpot companies.', es: 'Lista mis empresas de HubSpot.' },
      {
        en: 'Show the HubSpot deals in the sales pipeline.',
        es: 'Muéstrame los negocios de HubSpot del pipeline de ventas.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        object_type: OBJECT_TYPE_SCHEMA,
        query: {
          type: 'string',
          description: 'Free-text search across the object. Optional. Templated.',
        },
        email: {
          type: 'string',
          description: 'Filter contacts by exact email. Optional. Templated.',
        },
        domain: {
          type: 'string',
          description: 'Filter companies by exact domain. Optional. Templated.',
        },
        name: {
          type: 'string',
          description: 'Filter companies by exact name. Optional. Templated.',
        },
        dealstage: {
          type: 'string',
          description: 'Filter deals by stage id. Optional. Templated.',
        },
        pipeline: {
          type: 'string',
          description: 'Filter deals by pipeline id. Optional. Templated.',
        },
        limit: { type: 'number', description: 'Max records to return. Default 50, capped at 100.' },
        include_associations: {
          type: 'boolean',
          description:
            "When true, attach each record's associated contacts, companies, deals, and tickets. Default false. Adds a few batched lookups over the result page.",
        },
      },
      required: ['object_type'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        object_type: { type: ['string', 'null'] },
        objects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: ['string', 'null'] },
              label: { type: ['string', 'null'] },
              properties: { type: 'object' },
              url: { type: ['string', 'null'] },
              associations: {
                type: 'object',
                description:
                  'Only present when include_associations was true. The associated records by type (the object_type itself is omitted).',
                properties: {
                  contacts: { type: 'array', items: { type: 'object' } },
                  companies: { type: 'array', items: { type: 'object' } },
                  deals: { type: 'array', items: { type: 'object' } },
                  tickets: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
        count: { type: 'number' },
        associations_error: {
          type: ['string', 'null'],
          description:
            'Non-null when include_associations was requested but the lookup failed — associations are unknown, NOT empty. Relay the error instead of claiming the records have no associations.',
        },
        scope_missing_types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Object types whose associations could not be read because the HubSpot token lacks the read scope for them. Tell the user to grant the scope.',
        },
        error: { type: ['string', 'null'] },
      },
      required: ['objects', 'count'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { channel, token } = requireChannel(deps, 'HubSpot: List Objects');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const type = resolveObjectType(params, vars, 'HubSpot: List Objects');

      const query = renderTemplate(String(params.query ?? ''), vars).trim();
      const rawLimit =
        typeof params.limit === 'string' ? parseInt(params.limit, 10) : (params.limit as number);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;

      // Build EQ filters from any field the type recognizes as searchable.
      const filters: Array<{ propertyName: string; operator: string; value: string }> = [];
      for (const field of ['email', 'domain', 'name', 'dealstage', 'pipeline'] as const) {
        const value = renderTemplate(String(params[field] ?? ''), vars).trim();
        if (value && CRM_OBJECT_PROPS[type].searchable.includes(field)) {
          filters.push({ propertyName: field, operator: 'EQ', value });
        }
      }

      const res = await listCrmObjects(token, type, {
        query: query || undefined,
        filters,
        limit,
        signal: input.context.signal,
      });
      if (res.error) {
        input.context.log(`HubSpot list_objects (${type}) failed: ${res.error}`);
        return {
          data: { object_type: type, objects: [], count: 0, error: res.error },
          summary: `HubSpot list ${type} failed: ${res.error}`,
        };
      }

      const portal = channel.getPortalId();
      const objects: Array<{
        id: string;
        label: string;
        properties: Record<string, string>;
        url: string | null;
        associations?: ObjectAssociations;
      }> = res.results.map((r) => ({
        id: r.id,
        label: CRM_OBJECT_PROPS[type].label(r.properties),
        properties: r.properties,
        url: crmObjectUrl(portal, type, r.id),
      }));

      // Opt-in association enrichment. Best-effort — a failure keeps the
      // records and surfaces associations_error rather than failing the list.
      const includeAssociations =
        params.include_associations === true ||
        String(params.include_associations ?? '').toLowerCase() === 'true';
      let associationsError: string | null = null;
      let scopeMissingTypes: string[] = [];
      if (includeAssociations && objects.length > 0) {
        const assoc = await resolveObjectAssociations(
          token,
          type,
          objects.map((o) => o.id),
          input.context.signal,
        );
        associationsError = assoc.error;
        scopeMissingTypes = assoc.scopeMissingTypes;
        if (assoc.error) {
          input.context.log(
            `HubSpot list_objects (${type}): association lookup failed: ${assoc.error}`,
          );
        }
        if (assoc.scopeMissingTypes.length > 0) {
          input.context.log(
            `HubSpot list_objects (${type}): associations unavailable for ${assoc.scopeMissingTypes.join(', ')} — token lacks the read scope`,
          );
        }
        for (const obj of objects) {
          obj.associations = assoc.byObject.get(obj.id) ?? {};
        }
      }

      input.context.log(`HubSpot list_objects (${type}): found ${objects.length}`);
      const assocNote = associationsError
        ? ` (association lookup failed: ${associationsError})`
        : scopeMissingTypes.length > 0
          ? ` (associations not returned for ${scopeMissingTypes.join(', ')} — missing read scope)`
          : '';
      return {
        data: {
          object_type: type,
          objects,
          count: objects.length,
          ...(includeAssociations
            ? { associations_error: associationsError, scope_missing_types: scopeMissingTypes }
            : {}),
          error: null,
        },
        summary: `Found ${objects.length} HubSpot ${type}${assocNote}`,
      };
    },
  };
}

// ── hubspot_create_object ─────────────────────────────────────────────

export function createHubSpotCreateObjectAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_create_object',
    name: 'HubSpot: Create Object',
    description:
      'Create a HubSpot contact, company, or deal. For contacts this is idempotent (matches an existing one by email/phone). Required: deals need dealname; companies need name or domain; contacts need email or phone.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Add HubSpot record', es: 'Crear registro de HubSpot' },
    chatDescription: {
      en: 'Create a HubSpot company (empresa) or deal (negocio) — or a contact (matched by email/phone if it already exists). Returns the record id and a link.',
      es: 'Crea una empresa o un negocio en HubSpot — o un contacto (que se asocia por correo/teléfono si ya existe). Devuelve el id del registro y un enlace.',
    },
    chatExamples: [
      {
        en: 'Add the company Acme (acme.com) to HubSpot.',
        es: 'Agrega la empresa Acme (acme.com) a HubSpot.',
      },
      {
        en: 'Create a HubSpot deal called Q3 Renewal for 5000.',
        es: 'Crea un negocio de HubSpot llamado Renovación Q3 por 5000.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        object_type: OBJECT_TYPE_SCHEMA,
        ...NAMED_FIELD_SCHEMA,
        properties: {
          type: 'object',
          description:
            'Escape hatch: extra HubSpot internal property names → values for fields not listed above.',
        },
      },
      required: ['object_type'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        object_type: { type: ['string', 'null'] },
        id: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        url: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { channel, token } = requireChannel(deps, 'HubSpot: Create Object');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const type = resolveObjectType(params, vars, 'HubSpot: Create Object');

      const props = gatherProps(params, vars);
      const result = await createCrmObject(token, type, props, input.context.signal, (m) =>
        input.context.log(m),
      );
      if (result.error || !result.id) {
        return {
          data: {
            object_type: type,
            id: result.id,
            created: false,
            url: null,
            error: result.error,
          },
          summary: `HubSpot create ${type} failed: ${result.error ?? 'no id returned'}`,
        };
      }
      const label = CRM_OBJECT_PROPS[type].label(result.properties);
      return {
        data: {
          object_type: type,
          id: result.id,
          created: true,
          url: crmObjectUrl(channel.getPortalId(), type, result.id),
          error: null,
        },
        summary: `Created HubSpot ${type.replace(/s$/, '')} "${label}"`,
      };
    },
  };
}

// ── hubspot_update_object ─────────────────────────────────────────────

export function createHubSpotUpdateObjectAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_update_object',
    name: 'HubSpot: Update Object',
    description: 'Update fields on an existing HubSpot contact, company, or deal by id.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Edit HubSpot record', es: 'Editar registro de HubSpot' },
    chatDescription: {
      en: 'Update fields on an existing HubSpot contact, company (empresa), or deal (negocio) by its id. Returns the record id and a link.',
      es: 'Actualiza campos de un contacto, empresa o negocio existente de HubSpot por su id. Devuelve el id del registro y un enlace.',
    },
    chatExamples: [
      {
        en: 'Update HubSpot deal 12345, set the amount to 8000.',
        es: 'Actualiza el negocio de HubSpot 12345, cambia el monto a 8000.',
      },
      {
        en: 'Change company 678 industry to Software.',
        es: 'Cambia la industria de la empresa 678 a Software.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        object_type: OBJECT_TYPE_SCHEMA,
        object_id: { type: 'string', description: 'Id of the record to update. Templated.' },
        ...NAMED_FIELD_SCHEMA,
        properties: {
          type: 'object',
          description:
            'Escape hatch: extra HubSpot internal property names → values for fields not listed above.',
        },
      },
      required: ['object_type', 'object_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        object_type: { type: ['string', 'null'] },
        id: { type: ['string', 'null'] },
        updated: { type: 'boolean' },
        url: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
      },
      required: ['updated'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { channel, token } = requireChannel(deps, 'HubSpot: Update Object');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const type = resolveObjectType(params, vars, 'HubSpot: Update Object');
      const id = renderTemplate(String(params.object_id ?? ''), vars).trim();
      if (!id) throw new Error('HubSpot: Update Object — object_id is required.');

      const props = gatherProps(params, vars);
      const result = await updateCrmObject(token, type, id, props, input.context.signal, (m) =>
        input.context.log(m),
      );
      if (result.error || !result.id) {
        return {
          data: {
            object_type: type,
            id: result.id,
            updated: false,
            url: null,
            error: result.error,
          },
          summary: `HubSpot update ${type} failed: ${result.error ?? 'unknown error'}`,
        };
      }
      return {
        data: {
          object_type: type,
          id: result.id,
          updated: true,
          url: crmObjectUrl(channel.getPortalId(), type, result.id),
          error: null,
        },
        summary: `Updated HubSpot ${type.replace(/s$/, '')} ${result.id}`,
      };
    },
  };
}

// ── hubspot_delete_object ─────────────────────────────────────────────

export function createHubSpotDeleteObjectAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_delete_object',
    name: 'HubSpot: Delete Object',
    description:
      'Archive (delete) a HubSpot contact, company, or deal by id. The record is archived in HubSpot and recoverable there. Approval-gated like all external actions.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Delete HubSpot record', es: 'Eliminar registro de HubSpot' },
    chatDescription: {
      en: 'Archive (delete) a HubSpot contact, company (empresa), or deal (negocio) by its id. The record is recoverable in HubSpot.',
      es: 'Archiva (elimina) un contacto, empresa o negocio de HubSpot por su id. El registro se puede recuperar en HubSpot.',
    },
    chatExamples: [
      { en: 'Delete HubSpot company 678.', es: 'Elimina la empresa 678 de HubSpot.' },
      { en: 'Remove deal 12345 from HubSpot.', es: 'Elimina el negocio 12345 de HubSpot.' },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        object_type: OBJECT_TYPE_SCHEMA,
        object_id: { type: 'string', description: 'Id of the record to archive. Templated.' },
      },
      required: ['object_type', 'object_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        object_type: { type: ['string', 'null'] },
        id: { type: ['string', 'null'] },
        deleted: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['deleted'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const { token } = requireChannel(deps, 'HubSpot: Delete Object');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const type = resolveObjectType(params, vars, 'HubSpot: Delete Object');
      const id = renderTemplate(String(params.object_id ?? ''), vars).trim();
      if (!id) throw new Error('HubSpot: Delete Object — object_id is required.');

      const result = await deleteCrmObject(token, type, id, input.context.signal, (m) =>
        input.context.log(m),
      );
      if (!result.ok) {
        return {
          data: { object_type: type, id, deleted: false, error: result.error },
          summary: `HubSpot delete ${type} failed: ${result.error}`,
        };
      }
      return {
        data: { object_type: type, id, deleted: true, error: null },
        summary: `Archived HubSpot ${type.replace(/s$/, '')} ${id}`,
      };
    },
  };
}
