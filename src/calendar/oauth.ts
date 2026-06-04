/**
 * OAuth 2.0 Authorization-Code + PKCE flow for the bring-your-own calendar
 * integration (Cerebro's first OAuth integration).
 *
 * Runs entirely in the Electron main process: a one-shot loopback HTTP server on
 * 127.0.0.1 captures the redirect, the system browser handles consent, and the
 * provider adapter exchanges the code for tokens. The client secret and tokens
 * never leave main (encrypted at rest via secure-token.ts).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { AddressInfo } from 'node:net';
import type { CalendarProvider, TokenSet } from './providers/types';

const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

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

const SUCCESS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Cerebro</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center}.c{color:#06b6d4;font-size:42px}</style></head>
<body><div class="box"><div class="c">✓</div><h2>Calendar connected</h2><p>You can close this tab and return to Cerebro.</p></div></body></html>`;

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
function startLoopback(expectedState: string): Promise<LoopbackResult> {
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
        res.end(SUCCESS_HTML);
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
  provider: CalendarProvider,
  clientId: string,
  clientSecret: string,
  loginHint?: string,
): Promise<TokenSet> {
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const loopback = await startLoopback(state);
  const client = { clientId, clientSecret, redirectUri: loopback.redirectUri };

  const authUrl = provider.buildAuthUrl({ client, pkceChallenge: challenge, state, loginHint });

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
