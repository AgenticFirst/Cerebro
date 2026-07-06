import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveOAuthProvider, DRIVE_SCOPES } from '../provider';

const CLIENT = {
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'http://127.0.0.1:9999/callback',
};

describe('GoogleDriveOAuthProvider', () => {
  const provider = new GoogleDriveOAuthProvider();

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests read-only Drive scope with PKCE + offline access', () => {
    const url = new URL(
      provider.buildAuthUrl({ client: CLIENT, pkceChallenge: 'chal', state: 'st1' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPES);
    expect(url.searchParams.get('scope')).toContain('drive.readonly');
    expect(url.searchParams.get('scope')).not.toContain('drive.file');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('st1');
  });

  it('exchanges the auth code at the Google token endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
      }),
    );
    const tokens = await provider.exchangeCode({
      client: CLIENT,
      code: 'code1',
      pkceVerifier: 'ver',
    });
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = String((init as RequestInit).body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code_verifier=ver');
  });

  it('preserves the existing refresh token when Google omits it on refresh', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at2', expires_in: 3600 }), { status: 200 }),
    );
    const tokens = await provider.refresh({ client: CLIENT, refreshToken: 'rt-old' });
    expect(tokens.accessToken).toBe('at2');
    expect(tokens.refreshToken).toBe('rt-old');
  });
});
