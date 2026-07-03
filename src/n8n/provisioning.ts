/**
 * One-time (and per-session) provisioning against n8n's INTERNAL /rest API.
 *
 * Everything in this file is version-sensitive: /rest/owner/setup,
 * /rest/login, and /rest/api-keys are undocumented internals that n8n is free
 * to change between releases. That's why:
 *   - the n8n version is pinned (N8N_PINNED_VERSION in types.ts),
 *   - all request/response shaping is isolated here behind small functions,
 *   - parsing is deliberately defensive (multiple known response shapes).
 *
 * Verified against n8n 2.28.x. If a version bump breaks provisioning, this
 * file is the only place that should need editing.
 */

interface RestResult {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  setCookies: string[];
  error: string | null;
}

async function callRest(
  baseUrl: string,
  pathname: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<RestResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/rest${pathname}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        // n8n's REST layer rejects requests without a browser-ish origin in
        // some setups; identify ourselves consistently instead.
        'User-Agent': 'Cerebro',
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, json: null, setCookies: [], error: msg };
  }

  const setCookies = response.headers.getSetCookie?.() ?? [];
  const text = await response.text().catch(() => '');
  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  const error = response.ok
    ? null
    : ((json?.message as string | undefined) ?? `HTTP ${response.status}`);
  return { ok: response.ok, status: response.status, json, setCookies, error };
}

/** n8n's session cookie. Name has been stable across 1.x/2.x. */
export const N8N_AUTH_COOKIE_NAME = 'n8n-auth';

export interface N8nSessionCookie {
  name: string;
  value: string;
}

function extractAuthCookie(setCookies: string[]): N8nSessionCookie | null {
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === N8N_AUTH_COOKIE_NAME && value) return { name, value };
  }
  return null;
}

/**
 * Generates a password satisfying n8n's policy (>= 8 chars, at least one
 * number and one capital letter) from crypto-random material.
 */
export function generateOwnerPassword(randomBytesHex: string): string {
  return `Cb1-${randomBytesHex.slice(0, 24)}`;
}

/**
 * Creates the instance owner. Succeeds silently if the instance is already
 * set up (idempotent re-runs after a half-finished first launch).
 */
export async function setupOwner(
  baseUrl: string,
  owner: { email: string; password: string },
): Promise<{ ok: boolean; alreadySetUp: boolean; error?: string }> {
  const res = await callRest(baseUrl, '/owner/setup', {
    method: 'POST',
    body: {
      email: owner.email,
      firstName: 'Cerebro',
      lastName: 'Local',
      password: owner.password,
    },
  });
  if (res.ok) return { ok: true, alreadySetUp: false };
  // "Instance owner already setup" style errors mean a previous run got this
  // far — treat as success and let login decide if the stored creds work.
  const msg = (res.error ?? '').toLowerCase();
  if (res.status === 400 && msg.includes('already')) {
    return { ok: true, alreadySetUp: true };
  }
  return { ok: false, alreadySetUp: false, error: res.error ?? 'Owner setup failed' };
}

/**
 * Logs in and returns the session cookie used both to mint API keys and to
 * auto-log-in the embedded editor iframe.
 * Sends both historical payload key spellings; extra keys are ignored.
 */
export async function login(
  baseUrl: string,
  owner: { email: string; password: string },
): Promise<{ ok: boolean; cookie?: N8nSessionCookie; error?: string }> {
  const res = await callRest(baseUrl, '/login', {
    method: 'POST',
    body: {
      email: owner.email,
      emailOrLdapLoginId: owner.email,
      password: owner.password,
    },
  });
  if (!res.ok) return { ok: false, error: res.error ?? 'Login failed' };
  const cookie = extractAuthCookie(res.setCookies);
  if (!cookie) return { ok: false, error: 'Login succeeded but no n8n-auth cookie returned' };
  return { ok: true, cookie };
}

/** Digs the raw API key string out of the /rest/api-keys response, which has
 *  moved between {data: {rawApiKey}}, {data: {apiKey}}, and flat variants. */
function extractApiKey(json: Record<string, unknown> | null): string | null {
  if (!json) return null;
  const candidates: unknown[] = [json];
  if (json.data && typeof json.data === 'object') candidates.push(json.data);
  for (const obj of candidates) {
    const rec = obj as Record<string, unknown>;
    for (const key of ['rawApiKey', 'apiKey']) {
      const val = rec[key];
      if (typeof val === 'string' && val.length > 10) return val;
    }
  }
  return null;
}

/**
 * Mints a public-API key for the logged-in owner.
 *
 * 2.28.x requires a `scopes` array; GET /rest/api-keys/scopes returns every
 * scope the current user may grant, so we request all of them (Cerebro is the
 * instance owner's only client). Falls back to scope-less payloads for
 * versions that predate scoped keys.
 */
export async function createApiKey(
  baseUrl: string,
  cookie: N8nSessionCookie,
): Promise<{ ok: boolean; apiKey?: string; error?: string }> {
  const cookieHeader = `${cookie.name}=${cookie.value}`;

  let scopes: string[] | null = null;
  const scopesRes = await callRest(baseUrl, '/api-keys/scopes', { cookie: cookieHeader });
  if (scopesRes.ok && Array.isArray(scopesRes.json?.data)) {
    scopes = (scopesRes.json.data as unknown[]).filter((s): s is string => typeof s === 'string');
  }

  let res = await callRest(baseUrl, '/api-keys', {
    method: 'POST',
    cookie: cookieHeader,
    body: { label: 'Cerebro', expiresAt: null, ...(scopes ? { scopes } : {}) },
  });
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    // Older versions reject unknown fields / expect no body at all.
    res = await callRest(baseUrl, '/api-keys', {
      method: 'POST',
      cookie: cookieHeader,
      body: { label: 'Cerebro', expiresAt: null },
    });
    if (!res.ok && (res.status === 400 || res.status === 422)) {
      res = await callRest(baseUrl, '/api-keys', { method: 'POST', cookie: cookieHeader });
    }
  }
  if (!res.ok) return { ok: false, error: res.error ?? 'API key creation failed' };
  const apiKey = extractApiKey(res.json);
  if (!apiKey) return { ok: false, error: 'API key response had no recognizable key field' };
  return { ok: true, apiKey };
}
