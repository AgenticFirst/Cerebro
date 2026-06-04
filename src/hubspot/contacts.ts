/**
 * Shared HubSpot contact helpers.
 *
 * The search / upsert logic used to live inline inside the
 * `hubspot_upsert_contact` action. It's lifted here so every path that needs
 * to resolve a contact — the upsert action, the standalone search action, and
 * `hubspot_create_ticket` associating by email — shares one source of truth.
 *
 * Built on `callHubSpotApi`, so it inherits the same auth + error-message
 * handling every other HubSpot call uses.
 */

import { callHubSpotApi } from './api';

export interface HubSpotContact {
  id: string;
  properties: Record<string, string>;
}

export interface FindContactResult {
  /** The matched contact, or null when the search ran cleanly but found nothing. */
  contact: HubSpotContact | null;
  /** Human-readable error when the search call itself failed; null on success. */
  error: string | null;
}

export interface UpsertContactFields {
  email?: string;
  phone?: string;
  firstname?: string;
  lastname?: string;
  lifecyclestage?: string;
}

export interface UpsertContactResult {
  contactId: string | null;
  created: boolean;
  /** Which property the existing contact was matched on ('email' | 'phone'), or null. */
  matchedBy: string | null;
  error: string | null;
}

const SEARCH_PROPERTIES = ['email', 'firstname', 'lastname', 'phone'];

/**
 * Find a single contact by an exact property match (defaults to email).
 * Read-only. Returns `{ contact: null, error: null }` for a clean miss so
 * callers can branch on "found vs. not found" without try/catch, and surfaces
 * a non-null `error` only when the search request itself failed.
 */
export async function findContact(
  token: string,
  property: string,
  value: string,
  signal?: AbortSignal,
): Promise<FindContactResult> {
  const res = await callHubSpotApi<{
    results?: Array<{ id?: string; properties?: Record<string, string> }>;
  }>(token, '/crm/v3/objects/contacts/search', {
    method: 'POST',
    body: {
      filterGroups: [{ filters: [{ propertyName: property, operator: 'EQ', value }] }],
      properties: SEARCH_PROPERTIES,
      limit: 1,
    },
    signal,
  });
  if (!res.ok) {
    return { contact: null, error: res.error };
  }
  const hit = res.data?.results && res.data.results.length > 0 ? res.data.results[0] : null;
  if (!hit || typeof hit.id !== 'string') {
    return { contact: null, error: null };
  }
  return { contact: { id: hit.id, properties: hit.properties ?? {} }, error: null };
}

/** Convenience wrapper for the common email lookup. */
export function findContactByEmail(
  token: string,
  email: string,
  signal?: AbortSignal,
): Promise<FindContactResult> {
  return findContact(token, 'email', email, signal);
}

/**
 * Idempotent create-or-update. Searches by email (preferred) or phone, PATCHes
 * the matching contact with any new non-key fields, or creates a fresh one.
 * Mirrors the behavior that previously lived in the upsert action verbatim.
 *
 * `log` is optional so non-routine callers (e.g. create_ticket associating by
 * email) can still surface the same diagnostics.
 */
export async function upsertContact(
  token: string,
  fields: UpsertContactFields,
  signal?: AbortSignal,
  log?: (msg: string) => void,
): Promise<UpsertContactResult> {
  const email = (fields.email ?? '').trim();
  const phone = (fields.phone ?? '').trim();
  const firstname = (fields.firstname ?? '').trim();
  const lastname = (fields.lastname ?? '').trim();
  const lifecyclestage = (fields.lifecyclestage ?? '').trim();

  if (!email && !phone) {
    return {
      contactId: null,
      created: false,
      matchedBy: null,
      error: 'email or phone is required',
    };
  }

  const searchProperty = email ? 'email' : 'phone';
  const searchValue = email || phone;
  const search = await findContact(token, searchProperty, searchValue, signal);
  if (search.error) {
    log?.(`HubSpot contact search failed (continuing to create): ${search.error}`);
  }
  const matchedId = search.contact?.id ?? null;

  // Only include fields the caller actually set, so an upsert doesn't blow
  // away existing data with empty strings.
  const properties: Record<string, string> = {};
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;
  if (lifecyclestage) properties.lifecyclestage = lifecyclestage;

  if (matchedId) {
    // PATCH only if we have new properties to write beyond the lookup key.
    const patchProps = { ...properties };
    if (email) delete patchProps.email;
    if (phone) delete patchProps.phone;
    if (Object.keys(patchProps).length > 0) {
      const patchRes = await callHubSpotApi(token, `/crm/v3/objects/contacts/${matchedId}`, {
        method: 'PATCH',
        body: { properties: patchProps },
        signal,
      });
      if (!patchRes.ok) {
        log?.(`HubSpot contact PATCH error (non-fatal): ${patchRes.error}`);
      }
    }
    log?.(`HubSpot contact matched: ${matchedId}`);
    return { contactId: matchedId, created: false, matchedBy: searchProperty, error: null };
  }

  const createRes = await callHubSpotApi<Record<string, unknown>>(
    token,
    '/crm/v3/objects/contacts',
    {
      method: 'POST',
      body: { properties },
      signal,
    },
  );
  if (!createRes.ok) {
    log?.(`HubSpot contact create ${createRes.status}: ${createRes.error}`);
    return { contactId: null, created: false, matchedBy: null, error: createRes.error };
  }
  const newId = createRes.data && typeof createRes.data.id === 'string' ? createRes.data.id : null;
  log?.(`HubSpot contact created: ${newId}`);
  return { contactId: newId, created: true, matchedBy: null, error: null };
}
