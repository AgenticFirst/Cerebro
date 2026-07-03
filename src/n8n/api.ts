/**
 * Shared client for the managed n8n instance's *public* REST API (/api/v1),
 * authenticated with the X-N8N-API-KEY header. Mirrors src/hubspot/api.ts.
 *
 * The internal /rest endpoints used for one-time provisioning live in
 * provisioning.ts, not here — everything in this file is the documented,
 * stable API surface that engine actions call.
 */

export interface N8nApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Human-readable error — preferred over raw status. */
  error: string | null;
}

export async function callN8nApi<T = unknown>(
  baseUrl: string,
  apiKey: string,
  pathname: string,
  init: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<N8nApiResult<T>> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1${pathname}`;
  const method = init.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'X-N8N-API-KEY': apiKey,
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
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const maybeMsg =
      parsed && typeof (parsed as Record<string, unknown>).message === 'string'
        ? ((parsed as Record<string, unknown>).message as string)
        : `HTTP ${response.status}`;
    return { ok: false, status: response.status, data: parsed, error: maybeMsg };
  }
  return { ok: true, status: response.status, data: parsed, error: null };
}
