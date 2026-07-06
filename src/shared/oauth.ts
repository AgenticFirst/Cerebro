/**
 * Shared OAuth 2.0 plumbing for bring-your-own-client integrations (calendar,
 * gmail, future ones): Authorization-Code + PKCE flow, token requests, and the
 * bearer-authed provider fetch with the 401 → TokenExpiredError convention.
 *
 * Runs entirely in the Electron main process: a one-shot loopback HTTP server on
 * 127.0.0.1 captures the redirect, the system browser handles consent, and the
 * provider adapter exchanges the code for tokens. Client secrets and tokens
 * never leave main (encrypted at rest via secure-token.ts).
 *
 * Originally lived in src/calendar/oauth.ts + src/calendar/providers/{types,http}.ts;
 * those modules re-export from here so calendar call sites are unchanged.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { AddressInfo } from 'node:net';

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

// ── Token / client shapes ────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  /** Null when the provider doesn't return a refresh token (re-consent needed). */
  refreshToken: string | null;
  /** Epoch milliseconds at which accessToken expires. */
  expiresAt: number;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  /** Loopback redirect captured for this flow (http://127.0.0.1:<port>/callback). */
  redirectUri: string;
}

/** Thrown when a refresh fails because the grant was revoked/expired. */
export class TokenExpiredError extends Error {
  constructor(message = 'OAuth token expired or revoked') {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

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

/**
 * The minimal seam runOAuthFlow needs from a provider adapter. CalendarProvider
 * and the Gmail provider both satisfy it structurally.
 */
export interface OAuthFlowProvider {
  buildAuthUrl(opts: {
    client: OAuthClient;
    pkceChallenge: string;
    state: string;
    loginHint?: string;
  }): string;
  exchangeCode(opts: {
    client: OAuthClient;
    code: string;
    pkceVerifier: string;
  }): Promise<TokenSet>;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ── PKCE ─────────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(crypto.randomBytes(16));
}

// ── Interactive flow ─────────────────────────────────────────────────────────

function successHtml(title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cerebro</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.c{color:#06b6d4;font-size:42px}</style></head>
<body><div class="box"><div class="c">✓</div><h2>${title}</h2><p>You can close this tab and return to Cerebro.</p></div></body></html>`;
}

const ERROR_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Cerebro</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style></head>
<body><div style="text-align:center"><h2>Authorization failed</h2><p>You can close this tab and try again in Cerebro.</p></div></body></html>`;

interface LoopbackResult {
  redirectUri: string;
  /** Resolves with the authorization code once the redirect is captured. */
  waitForCode: Promise<string>;
  close: () => void;
}

/** Start a one-shot loopback server that captures `?code=&state=`. */
function startLoopback(expectedState: string, successTitle: string): Promise<LoopbackResult> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const waitForCode = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404);
          res.end();
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (error || !code || state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(ERROR_HTML);
          rejectCode(
            new Error(error ? `OAuth error: ${error}` : 'Invalid OAuth callback (state mismatch)'),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(successHtml(successTitle));
        resolveCode(code);
      } catch (err) {
        res.writeHead(500);
        res.end();
        rejectCode(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        redirectUri: `http://127.0.0.1:${port}/callback`,
        waitForCode,
        close: () => server.close(),
      });
    });
  });
}

/**
 * Run the full interactive OAuth flow for a provider and return the token set.
 * Opens the system browser and waits for the loopback redirect.
 */
export async function runOAuthFlow(
  provider: OAuthFlowProvider,
  clientId: string,
  clientSecret: string,
  opts?: { loginHint?: string; successTitle?: string },
): Promise<TokenSet> {
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const loopback = await startLoopback(state, opts?.successTitle ?? 'Connected');
  const client = { clientId, clientSecret, redirectUri: loopback.redirectUri };

  const authUrl = provider.buildAuthUrl({
    client,
    pkceChallenge: challenge,
    state,
    loginHint: opts?.loginHint,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await shell.openExternal(authUrl);
    const code = await Promise.race([
      loopback.waitForCode,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error('Authorization timed out. Please try again.')),
          FLOW_TIMEOUT_MS,
        );
      }),
    ]);
    return await provider.exchangeCode({ client, code, pkceVerifier: verifier });
  } finally {
    if (timer) clearTimeout(timer);
    loopback.close();
  }
}
