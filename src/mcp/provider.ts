/**
 * Google OAuth adapter for the Drive MCP connection (bring-your-own client,
 * Desktop-app type). Mirrors src/gmail/provider.ts with Drive scopes.
 *
 * Scope note: v1 is deliberately read-only (`drive.readonly`) — MCP tools run
 * inside the Claude Code subprocess and bypass Cerebro's approval gate, so
 * write scopes stay out until an approval bridge for MCP tools exists.
 */

import {
  oauthTokenRequest,
  providerFetch,
  type OAuthClient,
  type OAuthFlowProvider,
  type TokenSet,
} from '../shared/oauth';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const DRIVE_SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.readonly';

export class GoogleDriveOAuthProvider implements OAuthFlowProvider {
  buildAuthUrl(opts: {
    client: OAuthClient;
    pkceChallenge: string;
    state: string;
    loginHint?: string;
  }): string {
    const p = new URLSearchParams({
      client_id: opts.client.clientId,
      redirect_uri: opts.client.redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPES,
      code_challenge: opts.pkceChallenge,
      code_challenge_method: 'S256',
      state: opts.state,
      access_type: 'offline',
      prompt: 'consent',
    });
    if (opts.loginHint) p.set('login_hint', opts.loginHint);
    return `${AUTH_URL}?${p.toString()}`;
  }

  async exchangeCode(opts: {
    client: OAuthClient;
    code: string;
    pkceVerifier: string;
  }): Promise<TokenSet> {
    const body = new URLSearchParams({
      code: opts.code,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      redirect_uri: opts.client.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: opts.pkceVerifier,
    });
    return oauthTokenRequest(TOKEN_URL, body, 'Google Drive');
  }

  async refresh(opts: { client: OAuthClient; refreshToken: string }): Promise<TokenSet> {
    const body = new URLSearchParams({
      refresh_token: opts.refreshToken,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      grant_type: 'refresh_token',
    });
    const tokens = await oauthTokenRequest(TOKEN_URL, body, 'Google Drive');
    // Google omits refresh_token on refresh — keep the existing one.
    if (!tokens.refreshToken) tokens.refreshToken = opts.refreshToken;
    return tokens;
  }

  async getUserInfo(accessToken: string): Promise<{ email: string; name?: string }> {
    const r = await providerFetch<{ email?: string; name?: string }>(USERINFO_URL, accessToken, {
      label: 'Google Drive userinfo',
    });
    return { email: r.email ?? '', name: r.name };
  }
}
