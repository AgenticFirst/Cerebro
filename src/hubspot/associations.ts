/**
 * Shared HubSpot association resolver.
 *
 * The search / get-ticket actions need to answer "which contact and which
 * company is this ticket from?" — and in HubSpot the *company* usually isn't
 * linked to the ticket directly: it hangs off the ticket's associated
 * **contact**. This module resolves `ticket → contact → company` for one or
 * many tickets in a bounded number of calls, so neither action re-derives the
 * multi-hop logic.
 *
 * Approach: v4 batch association reads (which return only ids) followed by v3
 * batch object reads (which fill in the email / name / company-name
 * properties). Every `inputs` array is chunked at 100 (HubSpot's batch limit),
 * so enriching a 100-ticket page stays at a handful of round trips rather than
 * one-call-per-ticket.
 *
 * Built on `callHubSpotApi`, so it inherits the same auth + error-message
 * handling every other HubSpot call uses.
 */

import { callHubSpotApi } from './api';
import type { CrmObjectType } from './crm-objects';

/** Max ids HubSpot accepts in a single batch read/association call. */
const BATCH_LIMIT = 100;

export interface AssociatedContact {
  id: string;
  email: string | null;
  firstname: string | null;
  lastname: string | null;
}

export interface AssociatedCompany {
  id: string;
  name: string | null;
  domain: string | null;
  /** `ticket` = linked to the ticket directly; `contact` = derived via the ticket's contact. */
  source: 'ticket' | 'contact';
  /** The contact the company was reached through, when `source === 'contact'`. */
  via_contact_id: string | null;
}

export interface TicketAssociations {
  contacts: AssociatedContact[];
  companies: AssociatedCompany[];
}

/** The flat per-contact shape both ticket actions expose in their output. */
export interface ContactOutput {
  contact_id: string;
  email: string | null;
  firstname: string | null;
  lastname: string | null;
}

/** The flat per-company shape both ticket actions expose in their output. */
export interface CompanyOutput {
  company_id: string;
  name: string | null;
  domain: string | null;
  source: 'ticket' | 'contact';
  via_contact_id: string | null;
}

/** Project resolved contacts into the output shape (renames `id` → `contact_id`). */
export function toContactOutputs(contacts: AssociatedContact[]): ContactOutput[] {
  return contacts.map((c) => ({
    contact_id: c.id,
    email: c.email,
    firstname: c.firstname,
    lastname: c.lastname,
  }));
}

/** Project resolved companies into the output shape (renames `id` → `company_id`). */
export function toCompanyOutputs(companies: AssociatedCompany[]): CompanyOutput[] {
  return companies.map((c) => ({
    company_id: c.id,
    name: c.name,
    domain: c.domain,
    source: c.source,
    via_contact_id: c.via_contact_id,
  }));
}

export interface ResolveAssociationsResult {
  /** ticketId → its resolved contacts + companies. Tickets with no associations get empty arrays. */
  byTicket: Map<string, TicketAssociations>;
  /** Non-null only when the contacts path failed hard (propagated to the caller). */
  error: string | null;
  /**
   * True when a companies call returned 403 — i.e. the token lacks
   * `crm.objects.companies.read`. Contacts still resolve; callers should warn
   * rather than fail.
   */
  companiesScopeMissing: boolean;
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(arr: T[], size = BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface BatchAssociationsResult {
  /** fromId → list of associated toIds. */
  map: Map<string, string[]>;
  ok: boolean;
  status: number;
  error: string | null;
}

/**
 * Read associations from one object type to another in bulk via the v4 batch
 * endpoint. Returns a map of fromId → toIds. v4 returns associated ids as
 * `to[].toObjectId` (numbers or strings), which we normalize to strings.
 */
async function batchReadAssociations(
  token: string,
  fromType: string,
  toType: string,
  ids: string[],
  signal?: AbortSignal,
): Promise<BatchAssociationsResult> {
  const map = new Map<string, string[]>();
  for (const ch of chunk(ids)) {
    const res = await callHubSpotApi<{
      results?: Array<{
        from?: { id?: string | number };
        to?: Array<{ toObjectId?: string | number }>;
      }>;
    }>(token, `/crm/v4/associations/${fromType}/${toType}/batch/read`, {
      method: 'POST',
      body: { inputs: ch.map((id) => ({ id })) },
      signal,
    });
    if (!res.ok) {
      return { map, ok: false, status: res.status, error: res.error };
    }
    for (const r of res.data?.results ?? []) {
      const fromId = r.from?.id != null ? String(r.from.id) : null;
      if (!fromId) continue;
      const toIds = (r.to ?? [])
        .map((t) => (t.toObjectId != null ? String(t.toObjectId) : null))
        .filter((x): x is string => x !== null);
      const existing = map.get(fromId) ?? [];
      map.set(fromId, existing.concat(toIds));
    }
  }
  return { map, ok: true, status: 200, error: null };
}

interface BatchObject {
  id: string;
  properties: Record<string, string>;
}

interface BatchObjectsResult {
  map: Map<string, BatchObject>;
  ok: boolean;
  status: number;
  error: string | null;
}

/** Batch-read the given properties for a set of object ids via the v3 batch endpoint. */
async function batchReadObjects(
  token: string,
  objectType: string,
  ids: string[],
  properties: string[],
  signal?: AbortSignal,
): Promise<BatchObjectsResult> {
  const map = new Map<string, BatchObject>();
  for (const ch of chunk(ids)) {
    const res = await callHubSpotApi<{
      results?: Array<{ id?: string; properties?: Record<string, string> }>;
    }>(token, `/crm/v3/objects/${objectType}/batch/read`, {
      method: 'POST',
      body: { properties, inputs: ch.map((id) => ({ id })) },
      signal,
    });
    if (!res.ok) {
      return { map, ok: false, status: res.status, error: res.error };
    }
    for (const r of res.data?.results ?? []) {
      if (typeof r.id === 'string') {
        map.set(r.id, { id: r.id, properties: r.properties ?? {} });
      }
    }
  }
  return { map, ok: true, status: 200, error: null };
}

/** Unique, defined values from a list. */
function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Resolve each ticket's associated contacts and companies, including the
 * company derived from the ticket's contact when there's no direct
 * ticket→company link.
 *
 * Degrades gracefully: a missing `crm.objects.companies.read` scope (403 on a
 * companies call) yields `companiesScopeMissing: true` with contacts still
 * populated, rather than failing the whole resolve. A hard failure of the
 * contacts path is surfaced via `error`.
 */
export async function resolveTicketAssociations(
  token: string,
  ticketIds: string[],
  signal?: AbortSignal,
): Promise<ResolveAssociationsResult> {
  const byTicket = new Map<string, TicketAssociations>();
  const ids = uniq(ticketIds.filter(Boolean));
  if (ids.length === 0) {
    return { byTicket, error: null, companiesScopeMissing: false };
  }
  // Seed every requested ticket so callers always get an entry.
  for (const id of ids) byTicket.set(id, { contacts: [], companies: [] });

  let companiesScopeMissing = false;

  // 1. ticket → contacts (hard requirement — failure propagates, and short-
  // circuits before we spend a companies call).
  const ticketContacts = await batchReadAssociations(token, 'tickets', 'contacts', ids, signal);
  if (!ticketContacts.ok) {
    return { byTicket, error: ticketContacts.error, companiesScopeMissing: false };
  }

  // 2. ticket → companies (direct). A 403 here just means no companies scope.
  const ticketCompanies = await batchReadAssociations(token, 'tickets', 'companies', ids, signal);
  if (!ticketCompanies.ok && ticketCompanies.status === 403) {
    companiesScopeMissing = true;
  }

  const allContactIds = uniq(Array.from(ticketContacts.map.values()).flat());

  // 3 + 4: once contact ids are known, contact → companies (the fallback path
  // for "company comes from the contact") and the contact properties are also
  // independent — resolve them in parallel.
  let contactCompanies = new Map<string, string[]>();
  let contactProps = new Map<string, BatchObject>();
  if (allContactIds.length > 0) {
    const [cc, cp] = await Promise.all([
      batchReadAssociations(token, 'contacts', 'companies', allContactIds, signal),
      batchReadObjects(
        token,
        'contacts',
        allContactIds,
        ['email', 'firstname', 'lastname'],
        signal,
      ),
    ]);
    if (cc.ok) {
      contactCompanies = cc.map;
    } else if (cc.status === 403) {
      companiesScopeMissing = true;
    }
    if (cp.ok) contactProps = cp.map;
  }

  // 5. company properties — union of direct + contact-derived ids.
  const allCompanyIds = uniq([
    ...Array.from(ticketCompanies.map.values()).flat(),
    ...Array.from(contactCompanies.values()).flat(),
  ]);
  let companyProps = new Map<string, BatchObject>();
  if (allCompanyIds.length > 0) {
    const cp = await batchReadObjects(
      token,
      'companies',
      allCompanyIds,
      ['name', 'domain'],
      signal,
    );
    if (cp.ok) {
      companyProps = cp.map;
    } else if (cp.status === 403) {
      companiesScopeMissing = true;
    }
  }

  // Assemble per-ticket views.
  for (const ticketId of ids) {
    const contactIds = ticketContacts.map.get(ticketId) ?? [];
    const contacts: AssociatedContact[] = contactIds.map((cid) => {
      const props = contactProps.get(cid)?.properties ?? {};
      return {
        id: cid,
        email: props.email ?? null,
        firstname: props.firstname ?? null,
        lastname: props.lastname ?? null,
      };
    });

    // Direct ticket → company first; fall back to contact-derived companies.
    const companies: AssociatedCompany[] = [];
    const seen = new Set<string>();
    const directIds = ticketCompanies.map.get(ticketId) ?? [];
    for (const compId of directIds) {
      if (seen.has(compId)) continue;
      seen.add(compId);
      const props = companyProps.get(compId)?.properties ?? {};
      companies.push({
        id: compId,
        name: props.name ?? null,
        domain: props.domain ?? null,
        source: 'ticket',
        via_contact_id: null,
      });
    }
    if (companies.length === 0) {
      for (const cid of contactIds) {
        for (const compId of contactCompanies.get(cid) ?? []) {
          if (seen.has(compId)) continue;
          seen.add(compId);
          const props = companyProps.get(compId)?.properties ?? {};
          companies.push({
            id: compId,
            name: props.name ?? null,
            domain: props.domain ?? null,
            source: 'contact',
            via_contact_id: cid,
          });
        }
      }
    }

    byTicket.set(ticketId, { contacts, companies });
  }

  return { byTicket, error: null, companiesScopeMissing };
}

/** Everything a CRM record can be associated with, in chat-output shape. */
export interface ObjectAssociations {
  contacts?: ContactOutput[];
  companies?: Array<{ company_id: string; name: string | null; domain: string | null }>;
  deals?: Array<{ deal_id: string; dealname: string | null; amount: string | null }>;
  tickets?: Array<{ ticket_id: string; subject: string | null }>;
}

export interface ResolveObjectAssociationsResult {
  /** objectId → its associations. Every requested id gets an entry; only the target types for the given `fromType` are present. */
  byObject: Map<string, ObjectAssociations>;
  /** First non-403 failure message, if any target type failed hard. Remaining types still resolve. */
  error: string | null;
  /** Target types whose read returned 403 — the token lacks the read scope for them. */
  scopeMissingTypes: string[];
}

type AssocTargetType = CrmObjectType | 'tickets';

/** Display properties fetched per associated object type. */
const TARGET_PROPS: Record<AssocTargetType, string[]> = {
  contacts: ['email', 'firstname', 'lastname'],
  companies: ['name', 'domain'],
  deals: ['dealname', 'amount'],
  tickets: ['subject'],
};

/**
 * Resolve a generic CRM record's associations to the other core object types
 * (contacts, companies, deals, tickets). Unlike `resolveTicketAssociations`
 * there is no multi-hop derivation — every association is a direct link.
 *
 * Best-effort per target type: a 403 marks the type in `scopeMissingTypes`, any
 * other failure records `error`; both leave the remaining types resolving.
 */
export async function resolveObjectAssociations(
  token: string,
  fromType: CrmObjectType,
  objectIds: string[],
  signal?: AbortSignal,
): Promise<ResolveObjectAssociationsResult> {
  const byObject = new Map<string, ObjectAssociations>();
  const scopeMissingTypes: string[] = [];
  let error: string | null = null;

  const toTypes = (Object.keys(TARGET_PROPS) as AssocTargetType[]).filter((t) => t !== fromType);
  const ids = uniq(objectIds.filter(Boolean));
  const empty = (): ObjectAssociations => {
    const out: ObjectAssociations = {};
    for (const t of toTypes) out[t] = [];
    return out;
  };
  // Seed every requested object so callers always get an entry.
  for (const id of ids) byObject.set(id, empty());
  if (ids.length === 0) {
    return { byObject, error, scopeMissingTypes };
  }

  const assocByType = new Map<AssocTargetType, Map<string, string[]>>();
  await Promise.all(
    toTypes.map(async (toType) => {
      const res = await batchReadAssociations(token, fromType, toType, ids, signal);
      if (res.ok) {
        assocByType.set(toType, res.map);
      } else if (res.status === 403) {
        scopeMissingTypes.push(toType);
      } else {
        error = error ?? res.error;
      }
    }),
  );

  // Fetch display properties for every associated id, one batch per type.
  const propsByType = new Map<AssocTargetType, Map<string, BatchObject>>();
  await Promise.all(
    Array.from(assocByType.entries()).map(async ([toType, map]) => {
      const targetIds = uniq(Array.from(map.values()).flat());
      if (targetIds.length === 0) return;
      const res = await batchReadObjects(token, toType, targetIds, TARGET_PROPS[toType], signal);
      if (res.ok) {
        propsByType.set(toType, res.map);
      } else if (res.status === 403) {
        scopeMissingTypes.push(toType);
      } else {
        error = error ?? res.error;
      }
    }),
  );

  for (const id of ids) {
    const assoc = byObject.get(id)!;
    for (const toType of toTypes) {
      const targetIds = assocByType.get(toType)?.get(id) ?? [];
      const props = (tid: string) => propsByType.get(toType)?.get(tid)?.properties ?? {};
      if (toType === 'contacts') {
        assoc.contacts = targetIds.map((tid) => ({
          contact_id: tid,
          email: props(tid).email ?? null,
          firstname: props(tid).firstname ?? null,
          lastname: props(tid).lastname ?? null,
        }));
      } else if (toType === 'companies') {
        assoc.companies = targetIds.map((tid) => ({
          company_id: tid,
          name: props(tid).name ?? null,
          domain: props(tid).domain ?? null,
        }));
      } else if (toType === 'deals') {
        assoc.deals = targetIds.map((tid) => ({
          deal_id: tid,
          dealname: props(tid).dealname ?? null,
          amount: props(tid).amount ?? null,
        }));
      } else {
        assoc.tickets = targetIds.map((tid) => ({
          ticket_id: tid,
          subject: props(tid).subject ?? null,
        }));
      }
    }
  }

  return { byObject, error, scopeMissingTypes };
}
