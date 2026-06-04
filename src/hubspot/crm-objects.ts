/**
 * Generic CRM-object helpers for HubSpot's uniform object API.
 *
 * Contacts, companies, and deals all share the same v3 shape:
 *   POST   /crm/v3/objects/{type}            create
 *   GET    /crm/v3/objects/{type}/{id}       read
 *   PATCH  /crm/v3/objects/{type}/{id}       update
 *   DELETE /crm/v3/objects/{type}/{id}       archive
 *   POST   /crm/v3/objects/{type}/search     list / search
 *
 * Rather than spawn a dozen near-identical helpers, this module drives every
 * object type from one table (`CRM_OBJECT_PROPS`) and one set of functions,
 * built on `callHubSpotApi` so they inherit the same auth + error handling
 * every other HubSpot call uses. Contacts keep their idempotent upsert from
 * `contacts.ts` — `createCrmObject` delegates there so we don't regress the
 * email/phone dedup behavior the rest of the app relies on.
 */

import { callHubSpotApi } from './api';
import { upsertContact } from './contacts';

export type CrmObjectType = 'contacts' | 'companies' | 'deals';

export interface CrmObjectRecord {
  id: string;
  properties: Record<string, string>;
}

interface CrmObjectSpec {
  /** Properties fetched/returned by list + get. */
  searchable: string[];
  /** Properties accepted on create/update. Unknown keys are dropped. */
  writable: string[];
  /** Returns an error message when required fields are missing, else null. */
  required: (props: Record<string, string>) => string | null;
  /** Human label for summaries, e.g. `Acme (acme.com)`. */
  label: (props: Record<string, string>) => string;
  /** Object id used in app.hubspot.com record deep-links. */
  urlObjectId: string;
}

export const CRM_OBJECT_TYPES: CrmObjectType[] = ['contacts', 'companies', 'deals'];

export const CRM_OBJECT_PROPS: Record<CrmObjectType, CrmObjectSpec> = {
  contacts: {
    searchable: ['email', 'firstname', 'lastname', 'phone', 'company', 'lifecyclestage'],
    writable: [
      'email',
      'firstname',
      'lastname',
      'phone',
      'company',
      'lifecyclestage',
      'jobtitle',
      'website',
    ],
    required: (p) => (p.email || p.phone ? null : 'A contact needs at least an email or phone.'),
    label: (p) => {
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
      return name || p.email || p.phone || 'contact';
    },
    urlObjectId: '0-1',
  },
  companies: {
    searchable: ['name', 'domain', 'industry', 'city', 'country', 'phone'],
    writable: ['name', 'domain', 'industry', 'city', 'country', 'phone', 'description', 'website'],
    required: (p) => (p.name || p.domain ? null : 'A company needs at least a name or domain.'),
    label: (p) => {
      const parts = [p.name, p.domain].filter(Boolean);
      if (parts.length === 2) return `${p.name} (${p.domain})`;
      return parts[0] || 'company';
    },
    urlObjectId: '0-2',
  },
  deals: {
    searchable: ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'dealtype'],
    writable: [
      'dealname',
      'amount',
      'dealstage',
      'pipeline',
      'closedate',
      'dealtype',
      'description',
    ],
    required: (p) => (p.dealname ? null : 'A deal needs a dealname.'),
    label: (p) => {
      if (p.dealname && p.amount) return `${p.dealname} (${p.amount})`;
      return p.dealname || 'deal';
    },
    urlObjectId: '0-3',
  },
};

export function isCrmObjectType(value: string): value is CrmObjectType {
  return (CRM_OBJECT_TYPES as string[]).includes(value);
}

/**
 * Keep only properties the type allows to be written. Returns the filtered
 * map plus the list of dropped keys so callers can warn the user that a field
 * they passed was ignored (rather than silently swallowing typos).
 */
export function filterWritableProps(
  type: CrmObjectType,
  props: Record<string, string>,
): { properties: Record<string, string>; dropped: string[] } {
  const allowed = new Set(CRM_OBJECT_PROPS[type].writable);
  const properties: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === '') continue;
    if (allowed.has(key)) properties[key] = String(value);
    else dropped.push(key);
  }
  return { properties, dropped };
}

/** Deep-link to a single record in the HubSpot UI, or null without a portal id. */
export function crmObjectUrl(
  portalId: string | null,
  type: CrmObjectType,
  id: string,
): string | null {
  if (!portalId) return null;
  return `https://app.hubspot.com/contacts/${portalId}/record/${CRM_OBJECT_PROPS[type].urlObjectId}/${id}`;
}

export interface ListCrmObjectsResult {
  results: CrmObjectRecord[];
  total: number;
  error: string | null;
}

/**
 * List/search objects of a type. With no filters and no query this returns the
 * most recently created records (sorted desc). Returns a clean empty list on a
 * no-match search and a non-null error only when the request itself failed.
 */
export async function listCrmObjects(
  token: string,
  type: CrmObjectType,
  opts: {
    query?: string;
    filters?: Array<{ propertyName: string; operator: string; value: string }>;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ListCrmObjectsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const filters = opts.filters ?? [];
  const body: Record<string, unknown> = {
    filterGroups: filters.length ? [{ filters }] : [],
    properties: CRM_OBJECT_PROPS[type].searchable,
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    limit,
  };
  if (opts.query) body.query = opts.query;

  const res = await callHubSpotApi<{
    results?: Array<{ id?: string; properties?: Record<string, string> }>;
    total?: number;
  }>(token, `/crm/v3/objects/${type}/search`, { method: 'POST', body, signal: opts.signal });
  if (!res.ok) return { results: [], total: 0, error: res.error };
  const results = (res.data?.results ?? [])
    .filter(
      (r): r is { id: string; properties?: Record<string, string> } => typeof r.id === 'string',
    )
    .map((r) => ({ id: r.id, properties: r.properties ?? {} }));
  return { results, total: res.data?.total ?? results.length, error: null };
}

export interface GetCrmObjectResult {
  record: CrmObjectRecord | null;
  error: string | null;
}

/** Fetch a single object by id with its allowed properties. */
export async function getCrmObject(
  token: string,
  type: CrmObjectType,
  id: string,
  signal?: AbortSignal,
): Promise<GetCrmObjectResult> {
  const properties = CRM_OBJECT_PROPS[type].searchable.join(',');
  const res = await callHubSpotApi<{ id?: string; properties?: Record<string, string> }>(
    token,
    `/crm/v3/objects/${type}/${encodeURIComponent(id)}?properties=${encodeURIComponent(properties)}`,
    { method: 'GET', signal },
  );
  if (!res.ok) return { record: null, error: res.error };
  if (!res.data || typeof res.data.id !== 'string') return { record: null, error: null };
  return { record: { id: res.data.id, properties: res.data.properties ?? {} }, error: null };
}

export interface MutateCrmObjectResult {
  id: string | null;
  /** Resolved properties as written, used to build a readable summary. */
  properties: Record<string, string>;
  error: string | null;
}

/**
 * Create an object. Contacts delegate to the idempotent `upsertContact` so the
 * email/phone dedup the rest of the app expects is preserved; companies and
 * deals are plain creates. Enforces per-type required fields and drops unknown
 * properties.
 */
export async function createCrmObject(
  token: string,
  type: CrmObjectType,
  rawProps: Record<string, string>,
  signal?: AbortSignal,
  log?: (msg: string) => void,
): Promise<MutateCrmObjectResult> {
  const { properties, dropped } = filterWritableProps(type, rawProps);
  if (dropped.length)
    log?.(`HubSpot ${type} create: ignoring unsupported fields: ${dropped.join(', ')}`);

  const missing = CRM_OBJECT_PROPS[type].required(properties);
  if (missing) return { id: null, properties, error: missing };

  if (type === 'contacts') {
    const result = await upsertContact(
      token,
      {
        email: properties.email,
        phone: properties.phone,
        firstname: properties.firstname,
        lastname: properties.lastname,
        lifecyclestage: properties.lifecyclestage,
      },
      signal,
      log,
    );
    return { id: result.contactId, properties, error: result.error };
  }

  const res = await callHubSpotApi<{ id?: string }>(token, `/crm/v3/objects/${type}`, {
    method: 'POST',
    body: { properties },
    signal,
  });
  if (!res.ok) {
    log?.(`HubSpot ${type} create ${res.status}: ${res.error}`);
    return { id: null, properties, error: res.error };
  }
  const id = res.data && typeof res.data.id === 'string' ? res.data.id : null;
  return { id, properties, error: null };
}

/** Update (PATCH) an existing object's properties. Drops unknown fields. */
export async function updateCrmObject(
  token: string,
  type: CrmObjectType,
  id: string,
  rawProps: Record<string, string>,
  signal?: AbortSignal,
  log?: (msg: string) => void,
): Promise<MutateCrmObjectResult> {
  const { properties, dropped } = filterWritableProps(type, rawProps);
  if (dropped.length)
    log?.(`HubSpot ${type} update: ignoring unsupported fields: ${dropped.join(', ')}`);
  if (Object.keys(properties).length === 0) {
    return { id, properties, error: 'No updatable fields were provided.' };
  }

  const res = await callHubSpotApi<{ id?: string }>(
    token,
    `/crm/v3/objects/${type}/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: { properties },
      signal,
    },
  );
  if (!res.ok) {
    log?.(`HubSpot ${type} update ${res.status}: ${res.error}`);
    return { id: null, properties, error: res.error };
  }
  return { id, properties, error: null };
}

export interface DeleteCrmObjectResult {
  ok: boolean;
  error: string | null;
}

/**
 * Archive an object. HubSpot's DELETE archives the record (recoverable in the
 * HubSpot UI) rather than hard-deleting it.
 */
export async function deleteCrmObject(
  token: string,
  type: CrmObjectType,
  id: string,
  signal?: AbortSignal,
  log?: (msg: string) => void,
): Promise<DeleteCrmObjectResult> {
  const res = await callHubSpotApi(token, `/crm/v3/objects/${type}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
  if (!res.ok) {
    log?.(`HubSpot ${type} delete ${res.status}: ${res.error}`);
    return { ok: false, error: res.error };
  }
  return { ok: true, error: null };
}
