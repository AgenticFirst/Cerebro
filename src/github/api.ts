/**
 * Function-style GitHub REST client used by the holder, the poller, and
 * each engine action.
 *
 * Mirrors the HubSpot helper shape (see src/hubspot/api.ts): a single
 * generic `callGitHubApi<T>` returning a uniform `{ ok, status, data, error,
 * etag, rateLimitRemaining }` envelope so callers don't re-derive auth +
 * error-message parsing per endpoint.
 *
 * GitHub's rate limit ceiling is 5000 req/hr authenticated; we surface
 * `rateLimitRemaining` from response headers so the bridge can back off
 * before hitting 0 and the UI can warn the user.
 */

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_USER_AGENT = 'Cerebro';
export const GITHUB_API_VERSION = '2022-11-28';

export interface GitHubApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Human-readable error — preferred over the raw status code. */
  error: string | null;
  /** ETag from the response, if any — usable for If-None-Match on the next poll. */
  etag: string | null;
  /** X-RateLimit-Remaining as a number, or null when missing/unparseable. */
  rateLimitRemaining: number | null;
}

interface CallOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** When set, sent as `If-None-Match: <etag>`. A 304 response surfaces as `ok:true, status:304, data:null`. */
  etag?: string | null;
  signal?: AbortSignal;
}

export async function callGitHubApi<T = unknown>(
  token: string,
  pathname: string,
  init: CallOpts = {},
): Promise<GitHubApiResult<T>> {
  const url = buildUrl(pathname, init.query);
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': GITHUB_USER_AGENT,
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.etag) headers['If-None-Match'] = init.etag;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: msg, etag: null, rateLimitRemaining: null };
  }

  const etag = response.headers.get('ETag');
  const remainingHeader = response.headers.get('X-RateLimit-Remaining');
  const rateLimitRemaining = remainingHeader === null ? null : Number.parseInt(remainingHeader, 10);

  // 304 Not Modified — use the existing cached state.
  if (response.status === 304) {
    return {
      ok: true, status: 304, data: null, error: null, etag,
      rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : null,
    };
  }

  const text = await response.text().catch(() => '');
  let parsed: T | null = null;
  if (text) {
    try { parsed = JSON.parse(text) as T; } catch { parsed = null; }
  }

  if (!response.ok) {
    const message = readErrorMessage(parsed) ?? `HTTP ${response.status}`;
    return {
      ok: false, status: response.status, data: parsed, error: message, etag,
      rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : null,
    };
  }

  return {
    ok: true, status: response.status, data: parsed, error: null, etag,
    rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : null,
  };
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const base = pathname.startsWith('http') ? pathname : `${GITHUB_API_BASE}${pathname}`;
  if (!query) return base;
  const u = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function readErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;
  return null;
}

export function parseRepoFullName(fullName: string): { owner: string; repo: string } | null {
  const match = /^([^/]+)\/([^/]+)$/.exec(fullName.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}
