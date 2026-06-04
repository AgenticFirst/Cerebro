/**
 * Shared HubSpot owner (user) helpers.
 *
 * HubSpot tickets reference a user via the numeric `hubspot_owner_id`, but the
 * chat agent only ever knows a person by name or email. These helpers resolve a
 * free-text "owner" query (name / email / raw id) to that id, and resolve ids
 * back to display names for the read actions.
 *
 * Built on `callHubSpotApi`, so they inherit the same auth + error handling as
 * every other HubSpot call. The owner list is small and stable, so it's cached
 * per token with the same 5-minute TTL the holder uses for pipelines.
 */

import { callHubSpotApi } from './api';

export interface HubSpotOwner {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface ResolveOwnerResult {
  /** The resolved HubSpot owner id, or null when nothing matched. */
  ownerId: string | null;
  matchedBy: 'id' | 'email' | 'fullName' | 'name' | null;
  /** True when the query matched more than one owner and we refused to guess. */
  ambiguous: boolean;
  /** Human-readable failure (no match / ambiguous / API error). null on success. */
  error: string | null;
}

const OWNERS_CACHE_TTL_MS = 5 * 60 * 1_000;
const ownersCache = new Map<string, { owners: HubSpotOwner[]; at: number }>();

/** Exposed for tests so a stale cache doesn't leak between cases. */
export function clearOwnersCache(): void {
  ownersCache.clear();
}

function fullName(o: HubSpotOwner): string {
  return [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
}

/** Display label for an owner: "First Last", falling back to email, then id. */
export function ownerLabel(o: HubSpotOwner): string {
  return fullName(o) || o.email || o.id;
}

interface OwnersListResult {
  owners: HubSpotOwner[];
  error: string | null;
}

/**
 * List all active owners, following pagination. Cached per token. Returns a
 * non-null `error` only when the API call itself failed (e.g. the token lacks
 * `crm.objects.owners.read`); callers degrade gracefully rather than throwing.
 */
async function listOwners(token: string, signal?: AbortSignal): Promise<OwnersListResult> {
  const cached = ownersCache.get(token);
  if (cached && Date.now() - cached.at < OWNERS_CACHE_TTL_MS) {
    return { owners: cached.owners, error: null };
  }

  const owners: HubSpotOwner[] = [];
  let after: string | null = null;
  // Bound the pagination loop; HubSpot portals rarely exceed a few hundred users.
  for (let page = 0; page < 50; page++) {
    const path = `/crm/v3/owners?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const res = await callHubSpotApi<{
      results?: Array<{ id?: string; email?: string; firstName?: string; lastName?: string }>;
      paging?: { next?: { after?: string } };
    }>(token, path, { signal });
    if (!res.ok) {
      return { owners: [], error: res.error ?? 'Failed to list HubSpot owners' };
    }
    for (const r of res.data?.results ?? []) {
      if (typeof r.id !== 'string') continue;
      owners.push({
        id: r.id,
        email: r.email ?? null,
        firstName: r.firstName ?? null,
        lastName: r.lastName ?? null,
      });
    }
    after = res.data?.paging?.next?.after ?? null;
    if (!after) break;
  }

  ownersCache.set(token, { owners, at: Date.now() });
  return { owners, error: null };
}

/**
 * Resolve an owner query (name, email, or a raw numeric id) to a HubSpot owner
 * id. Match ladder, most specific first:
 *   1. pure-numeric → treat as an id and confirm it exists
 *   2. exact email (case-insensitive)
 *   3. exact full name "First Last" (case-insensitive)
 *   4. exact first OR last name (case-insensitive)
 * A query that matches multiple owners returns `ambiguous: true` with the
 * candidate emails in `error` so the agent can re-ask with the email. Never
 * throws — a failed lookup comes back as `{ ownerId: null, error }`.
 */
export async function resolveOwner(
  token: string,
  query: string,
  signal?: AbortSignal,
  log?: (msg: string) => void,
): Promise<ResolveOwnerResult> {
  const q = (query ?? '').trim();
  if (!q) return { ownerId: null, matchedBy: null, ambiguous: false, error: null };

  const { owners, error } = await listOwners(token, signal);
  if (error) {
    log?.(`HubSpot owner lookup failed for "${q}": ${error}`);
    return { ownerId: null, matchedBy: null, ambiguous: false, error };
  }

  // 1. Raw numeric id — accept it if it's a real owner.
  if (/^\d+$/.test(q)) {
    const byId = owners.find((o) => o.id === q);
    if (byId) return { ownerId: byId.id, matchedBy: 'id', ambiguous: false, error: null };
    return {
      ownerId: null,
      matchedBy: null,
      ambiguous: false,
      error: `No HubSpot user has id "${q}"`,
    };
  }

  const lower = q.toLowerCase();

  // 2. Exact email.
  const byEmail = owners.filter((o) => (o.email ?? '').toLowerCase() === lower);
  if (byEmail.length === 1)
    return { ownerId: byEmail[0].id, matchedBy: 'email', ambiguous: false, error: null };

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

  // 3. Exact full name.
  const byFull = owners.filter((o) => norm(fullName(o)) === norm(q));
  if (byFull.length === 1)
    return { ownerId: byFull[0].id, matchedBy: 'fullName', ambiguous: false, error: null };
  if (byFull.length > 1) return ambiguousResult(q, byFull);

  // 4. Exact first or last name.
  const byPart = owners.filter(
    (o) =>
      (o.firstName ?? '').toLowerCase() === lower || (o.lastName ?? '').toLowerCase() === lower,
  );
  if (byPart.length === 1)
    return { ownerId: byPart[0].id, matchedBy: 'name', ambiguous: false, error: null };
  if (byPart.length > 1) return ambiguousResult(q, byPart);

  return {
    ownerId: null,
    matchedBy: null,
    ambiguous: false,
    error: `No HubSpot user matches "${q}"`,
  };
}

function ambiguousResult(query: string, candidates: HubSpotOwner[]): ResolveOwnerResult {
  const emails = candidates.map((o) => o.email ?? ownerLabel(o)).filter(Boolean);
  return {
    ownerId: null,
    matchedBy: null,
    ambiguous: true,
    error: `"${query}" matches multiple HubSpot users (${emails.join(', ')}) — use the exact email`,
  };
}

/**
 * Resolve owner ids → display names for the read actions. Best-effort: unknown
 * ids (or a failed lookup) are simply absent from the returned map.
 */
export async function ownerDisplayNames(
  token: string,
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = new Set(ids.filter(Boolean));
  if (wanted.size === 0) return out;
  const { owners, error } = await listOwners(token, signal);
  if (error) return out;
  for (const o of owners) {
    if (wanted.has(o.id)) out.set(o.id, ownerLabel(o));
  }
  return out;
}
