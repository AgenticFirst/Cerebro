/**
 * Thin GoHighLevel REST client used to verify credentials from the
 * Electron main process (separate from the backend's Python `GHLClient`,
 * which handles outbound pushes from the Sales Intel Analyst flow).
 */

export const GHL_API_BASE = 'https://services.leadconnectorhq.com';
export const GHL_API_VERSION = '2021-07-28';

export interface GHLApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export async function callGHLApi<T = unknown>(
  apiKey: string,
  pathname: string,
  init: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    body?: unknown;
    query?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<GHLApiResult<T>> {
  const qs = init.query
    ? '?' + new URLSearchParams(init.query).toString()
    : '';
  const url = pathname.startsWith('http') ? pathname : `${GHL_API_BASE}${pathname}${qs}`;
  const method = init.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: GHL_API_VERSION,
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
