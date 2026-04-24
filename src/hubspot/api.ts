/**
 * Shared HubSpot REST client used by the engine actions + the holder.
 *
 * Centralizes base URL, bearer auth, JSON parsing, and the
 * "parse error body for a readable message" ladder so every action doesn't
 * re-derive it.
 */

export const HUBSPOT_API_BASE = 'https://api.hubapi.com';

export interface HubSpotApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Human-readable error — preferred over raw status. */
  error: string | null;
}

export async function callHubSpotApi<T = unknown>(
  token: string,
  pathname: string,
  init: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<HubSpotApiResult<T>> {
  const url = pathname.startsWith('http') ? pathname : `${HUBSPOT_API_BASE}${pathname}`;
  const method = init.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: msg };
  }

  const text = await response.text().catch(() => '');
  let parsed: T | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as T; } catch { parsed = null; }
  }

  if (!response.ok) {
    const maybeMsg = parsed && typeof (parsed as Record<string, unknown>).message === 'string'
      ? (parsed as Record<string, unknown>).message as string
      : `HTTP ${response.status}`;
    return { ok: false, status: response.status, data: parsed, error: maybeMsg };
  }
  return { ok: true, status: response.status, data: parsed, error: null };
}
