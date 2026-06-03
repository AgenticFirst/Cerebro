/**
 * HubSpot ticket-property listing.
 *
 * "Follow-up user" and "due date" are custom ticket properties whose internal
 * names differ per portal, so the Integrations settings UI lets the user pick
 * them from a dropdown instead of typing an internal name. This helper backs
 * that dropdown by listing the portal's ticket properties. Cached per token
 * with the usual 5-minute TTL.
 */

import { callHubSpotApi } from './api';

export interface HubSpotTicketProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
}

export interface ListTicketPropertiesResult {
  ok: boolean;
  properties?: HubSpotTicketProperty[];
  error?: string;
}

const PROPS_CACHE_TTL_MS = 5 * 60 * 1_000;
const propsCache = new Map<string, { properties: HubSpotTicketProperty[]; at: number }>();

/** Exposed for tests so a stale cache doesn't leak between cases. */
export function clearTicketPropertiesCache(): void {
  propsCache.clear();
}

export async function listTicketProperties(
  token: string,
  signal?: AbortSignal,
): Promise<ListTicketPropertiesResult> {
  const cached = propsCache.get(token);
  if (cached && Date.now() - cached.at < PROPS_CACHE_TTL_MS) {
    return { ok: true, properties: cached.properties };
  }

  const res = await callHubSpotApi<{
    results?: Array<{ name?: string; label?: string; type?: string; fieldType?: string }>;
  }>(token, '/crm/v3/properties/tickets', { signal });
  if (!res.ok) {
    return { ok: false, error: res.error ?? 'Failed to list HubSpot ticket properties' };
  }

  const properties: HubSpotTicketProperty[] = (res.data?.results ?? [])
    .filter((p): p is { name: string } & typeof p => typeof p.name === 'string')
    .map((p) => ({
      name: p.name,
      label: p.label ?? p.name,
      type: p.type ?? 'string',
      fieldType: p.fieldType ?? 'text',
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  propsCache.set(token, { properties, at: Date.now() });
  return { ok: true, properties };
}
