/**
 * HubSpot Lists ("segments") actions: list / create / rename / delete the
 * lists themselves, plus add/remove records to a static list.
 *
 * Lists live on a separate API from CRM objects, so they get their own
 * actions and bridge helpers (`src/hubspot/lists.ts`). Only MANUAL (static)
 * lists accept manual membership changes — `hubspot_list_membership` surfaces
 * HubSpot's error when used on a dynamic list.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { renderTemplate } from './utils/template';
import type { HubSpotChannel } from './hubspot-channel';
import {
  createList,
  deleteList,
  listLists,
  renameList,
  updateMemberships,
  type ListProcessingType,
} from '../../hubspot/lists';

function requireToken(
  deps: { getChannel: () => HubSpotChannel | null },
  actionName: string,
): string {
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
  return token;
}

function availability(deps: {
  getChannel: () => HubSpotChannel | null;
}): 'available' | 'not_connected' {
  const ch = deps.getChannel();
  if (!ch) return 'not_connected';
  return ch.isConnected() ? 'available' : 'not_connected';
}

/** Accept either an array of ids or a comma/space-separated string. */
function parseRecordIds(raw: unknown, vars: Record<string, unknown>): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  const rendered = renderTemplate(String(raw ?? ''), vars);
  return rendered
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── hubspot_list_lists ────────────────────────────────────────────────

export function createHubSpotListListsAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_list_lists',
    name: 'HubSpot: List Lists',
    description:
      'List or search HubSpot lists (segments). Read-only. Returns each list id, name, type, and size.',

    chatExposable: true,
    readOnly: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'List HubSpot lists', es: 'Listar listas de HubSpot' },
    chatDescription: {
      en: 'List or search your HubSpot lists (segments) without changing anything. Returns each list id, name, type and size.',
      es: 'Lista o busca tus listas (segmentos) de HubSpot sin modificar nada. Devuelve el id, nombre, tipo y tamaño de cada lista.',
    },
    chatExamples: [
      { en: 'List my HubSpot lists.', es: 'Lista mis listas de HubSpot.' },
      {
        en: 'Show my HubSpot segments named VIP.',
        es: 'Muéstrame mis segmentos de HubSpot llamados VIP.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text search across list names. Optional. Templated.',
        },
        limit: { type: 'number', description: 'Max lists to return. Default 50, capped at 100.' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        lists: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              list_id: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
              processing_type: { type: ['string', 'null'] },
              size: { type: ['number', 'null'] },
            },
          },
        },
        count: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['lists', 'count'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const token = requireToken(deps, 'HubSpot: List Lists');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const query = renderTemplate(String(params.query ?? ''), vars).trim();
      const rawLimit =
        typeof params.limit === 'string' ? parseInt(params.limit, 10) : (params.limit as number);
      const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;

      const res = await listLists(token, {
        query: query || undefined,
        limit,
        signal: input.context.signal,
      });
      if (res.error) {
        input.context.log(`HubSpot list_lists failed: ${res.error}`);
        return {
          data: { lists: [], count: 0, error: res.error },
          summary: `HubSpot list lists failed: ${res.error}`,
        };
      }
      const lists = res.lists.map((l) => ({
        list_id: l.listId,
        name: l.name,
        processing_type: l.processingType,
        size: l.size,
      }));
      input.context.log(`HubSpot list_lists: found ${lists.length}`);
      return {
        data: { lists, count: lists.length, error: null },
        summary: `Found ${lists.length} HubSpot list(s)`,
      };
    },
  };
}

// ── hubspot_create_list ───────────────────────────────────────────────

export function createHubSpotCreateListAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_create_list',
    name: 'HubSpot: Create List',
    description:
      'Create a HubSpot list (segment). Defaults to a MANUAL (static) contacts list you can add records to; pass processing_type DYNAMIC for a filter-based one.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Create HubSpot list', es: 'Crear lista de HubSpot' },
    chatDescription: {
      en: 'Create a HubSpot list (segment). Defaults to a static contacts list you can add records to.',
      es: 'Crea una lista (segmento) de HubSpot. Por defecto es una lista estática de contactos a la que puedes añadir registros.',
    },
    chatExamples: [
      {
        en: 'Create a HubSpot list called VIP customers.',
        es: 'Crea una lista de HubSpot llamada Clientes VIP.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the new list. Templated.' },
        processing_type: {
          type: 'string',
          enum: ['MANUAL', 'DYNAMIC'],
          description:
            'MANUAL (static, default — accepts manual membership) or DYNAMIC (filter-based, managed by HubSpot).',
        },
      },
      required: ['name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        list_id: { type: ['string', 'null'] },
        created: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['created'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const token = requireToken(deps, 'HubSpot: Create List');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const name = renderTemplate(String(params.name ?? ''), vars).trim();
      if (!name) throw new Error('HubSpot: Create List — name is required.');
      const processingType = (
        String(params.processing_type ?? '').toUpperCase() === 'DYNAMIC' ? 'DYNAMIC' : 'MANUAL'
      ) as ListProcessingType;

      const res = await createList(token, { name, processingType }, input.context.signal);
      if (res.error || !res.listId) {
        input.context.log(`HubSpot create_list failed: ${res.error}`);
        return {
          data: { list_id: res.listId, created: false, error: res.error },
          summary: `HubSpot create list failed: ${res.error ?? 'no id returned'}`,
        };
      }
      return {
        data: { list_id: res.listId, created: true, error: null },
        summary: `Created HubSpot list "${name}"`,
      };
    },
  };
}

// ── hubspot_update_list ───────────────────────────────────────────────

export function createHubSpotUpdateListAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_update_list',
    name: 'HubSpot: Update List',
    description: 'Rename an existing HubSpot list (segment) by id.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Rename HubSpot list', es: 'Renombrar lista de HubSpot' },
    chatDescription: {
      en: 'Rename an existing HubSpot list (segment) by its id.',
      es: 'Renombra una lista (segmento) existente de HubSpot por su id.',
    },
    chatExamples: [
      {
        en: 'Rename HubSpot list 42 to Top accounts.',
        es: 'Renombra la lista 42 de HubSpot a Cuentas top.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Id of the list to rename. Templated.' },
        name: { type: 'string', description: 'New name for the list. Templated.' },
      },
      required: ['list_id', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        list_id: { type: ['string', 'null'] },
        updated: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['updated'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const token = requireToken(deps, 'HubSpot: Update List');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const listId = renderTemplate(String(params.list_id ?? ''), vars).trim();
      const name = renderTemplate(String(params.name ?? ''), vars).trim();
      if (!listId) throw new Error('HubSpot: Update List — list_id is required.');
      if (!name) throw new Error('HubSpot: Update List — name is required.');

      const res = await renameList(token, listId, name, input.context.signal);
      if (!res.ok) {
        input.context.log(`HubSpot update_list failed: ${res.error}`);
        return {
          data: { list_id: listId, updated: false, error: res.error },
          summary: `HubSpot rename list failed: ${res.error}`,
        };
      }
      return {
        data: { list_id: listId, updated: true, error: null },
        summary: `Renamed HubSpot list ${listId} to "${name}"`,
      };
    },
  };
}

// ── hubspot_delete_list ───────────────────────────────────────────────

export function createHubSpotDeleteListAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_delete_list',
    name: 'HubSpot: Delete List',
    description:
      'Archive (delete) a HubSpot list (segment) by id. The list is archived (recoverable in HubSpot); the records on it are not deleted. Approval-gated.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: { en: 'Delete HubSpot list', es: 'Eliminar lista de HubSpot' },
    chatDescription: {
      en: 'Archive (delete) a HubSpot list (segment) by its id. The records on the list are not deleted.',
      es: 'Archiva (elimina) una lista (segmento) de HubSpot por su id. Los registros de la lista no se eliminan.',
    },
    chatExamples: [{ en: 'Delete HubSpot list 42.', es: 'Elimina la lista 42 de HubSpot.' }],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Id of the list to archive. Templated.' },
      },
      required: ['list_id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        list_id: { type: ['string', 'null'] },
        deleted: { type: 'boolean' },
        error: { type: ['string', 'null'] },
      },
      required: ['deleted'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const token = requireToken(deps, 'HubSpot: Delete List');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const listId = renderTemplate(String(params.list_id ?? ''), vars).trim();
      if (!listId) throw new Error('HubSpot: Delete List — list_id is required.');

      const res = await deleteList(token, listId, input.context.signal);
      if (!res.ok) {
        input.context.log(`HubSpot delete_list failed: ${res.error}`);
        return {
          data: { list_id: listId, deleted: false, error: res.error },
          summary: `HubSpot delete list failed: ${res.error}`,
        };
      }
      return {
        data: { list_id: listId, deleted: true, error: null },
        summary: `Archived HubSpot list ${listId}`,
      };
    },
  };
}

// ── hubspot_list_membership ───────────────────────────────────────────

export function createHubSpotListMembershipAction(deps: {
  getChannel: () => HubSpotChannel | null;
}): ActionDefinition {
  return {
    type: 'hubspot_list_membership',
    name: 'HubSpot: List Membership',
    description:
      'Add or remove records (e.g. contact ids) to/from a MANUAL (static) HubSpot list. Dynamic lists are managed by HubSpot and reject manual changes.',

    chatExposable: true,
    chatGroup: 'hubspot',
    chatLabel: {
      en: 'Add/remove HubSpot list members',
      es: 'Añadir/quitar miembros de lista de HubSpot',
    },
    chatDescription: {
      en: 'Add or remove records (contact ids) to/from a static HubSpot list. Only static lists accept manual membership changes.',
      es: 'Añade o quita registros (ids de contactos) de una lista estática de HubSpot. Solo las listas estáticas aceptan cambios manuales.',
    },
    chatExamples: [
      {
        en: 'Add contact 789 to the VIP HubSpot list 42.',
        es: 'Añade el contacto 789 a la lista VIP 42 de HubSpot.',
      },
      {
        en: 'Remove contact 789 from HubSpot list 42.',
        es: 'Quita el contacto 789 de la lista 42 de HubSpot.',
      },
    ],
    availabilityCheck: () => availability(deps),
    setupHref: 'integrations#hubspot',

    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'Id of the static list to modify. Templated.' },
        mode: {
          type: 'string',
          enum: ['add', 'remove'],
          description: 'Whether to add or remove the records.',
        },
        record_ids: {
          type: 'string',
          description:
            'Record ids (e.g. contact ids) to add/remove. Accepts an array or a comma-separated string. Templated.',
        },
      },
      required: ['list_id', 'mode', 'record_ids'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        list_id: { type: ['string', 'null'] },
        mode: { type: ['string', 'null'] },
        updated: { type: 'number' },
        error: { type: ['string', 'null'] },
      },
      required: ['updated'],
    },

    execute: async (input: ActionInput): Promise<ActionOutput> => {
      const token = requireToken(deps, 'HubSpot: List Membership');
      const params = input.params as Record<string, unknown>;
      const vars = input.wiredInputs ?? {};
      const listId = renderTemplate(String(params.list_id ?? ''), vars).trim();
      if (!listId) throw new Error('HubSpot: List Membership — list_id is required.');
      const mode = String(params.mode ?? '').toLowerCase() === 'remove' ? 'remove' : 'add';
      const recordIds = parseRecordIds(params.record_ids, vars);
      if (recordIds.length === 0)
        throw new Error('HubSpot: List Membership — at least one record id is required.');

      const res = await updateMemberships(token, listId, mode, recordIds, input.context.signal);
      if (res.error) {
        input.context.log(`HubSpot list_membership (${mode}) failed: ${res.error}`);
        return {
          data: { list_id: listId, mode, updated: 0, error: res.error },
          summary: `HubSpot list membership failed: ${res.error}`,
        };
      }
      const verb = mode === 'add' ? 'Added' : 'Removed';
      return {
        data: { list_id: listId, mode, updated: res.updated, error: null },
        summary: `${verb} ${res.updated} record(s) ${mode === 'add' ? 'to' : 'from'} HubSpot list ${listId}`,
      };
    },
  };
}
