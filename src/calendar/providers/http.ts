/**
 * Shared HTTP helpers for OAuth calendar providers (Google, Outlook, future
 * ones). Centralizes the bearer-auth fetch, JSON parsing, and the
 * 401 → TokenExpiredError convention so each adapter is just normalization +
 * endpoint shapes. Mirrors src/hubspot/api.ts (callHubSpotApi).
 */

import { TokenExpiredError, type TokenSet } from './types';

/** Non-2xx response from a provider API (carries the status for 410/expiry checks). */
export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Exchange an OAuth form body for a token set. `label` prefixes error messages. */
export async function oauthTokenRequest(
  tokenUrl: string,
  body: URLSearchParams,
  label: string,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(
      `${label} token request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as TokenJson;
  if (!res.ok || !json.access_token) {
    const msg = json.error_description || json.error || `HTTP ${res.status}`;
    if (res.status === 400 || res.status === 401) throw new TokenExpiredError(msg);
    throw new Error(`${label} token error: ${msg}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}

/** Bearer-authed JSON fetch. Throws TokenExpiredError on 401, ProviderHttpError otherwise. */
export async function providerFetch<T = unknown>(
  url: string,
  accessToken: string,
  opts: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    headers?: Record<string, string>;
    label: string;
  },
): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 401) throw new TokenExpiredError(`${opts.label} 401: ${text.slice(0, 200)}`);
    throw new ProviderHttpError(res.status, `${opts.label} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}
