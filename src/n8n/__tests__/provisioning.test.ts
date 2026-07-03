/**
 * Unit tests for the version-sensitive n8n provisioning adapter.
 * Mocks global.fetch; request/response shapes mirror what n8n 2.28.5 actually
 * returned in the live smoke test (owner setup, n8n-auth cookie, scoped
 * API keys via /rest/api-keys/scopes).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApiKey,
  generateOwnerPassword,
  login,
  N8N_AUTH_COOKIE_NAME,
  setupOwner,
} from '../provisioning';

const BASE = 'http://127.0.0.1:55678';

interface MockResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function mockFetchSequence(responses: MockResponse[]) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateOwnerPassword', () => {
  it('satisfies n8n policy: 8+ chars, a number, a capital letter', () => {
    const pw = generateOwnerPassword('abcdef0123456789abcdef0123456789');
    expect(pw.length).toBeGreaterThanOrEqual(8);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[A-Z]/);
  });
});

describe('setupOwner', () => {
  it('POSTs the owner payload to /rest/owner/setup', async () => {
    const fetchMock = mockFetchSequence([{ status: 200, body: { data: { id: 'u1' } } }]);
    const res = await setupOwner(BASE, { email: 'o@cerebro.local', password: 'Cb1-x2345678' });
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/rest/owner/setup`);
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toMatchObject({
      email: 'o@cerebro.local',
      password: 'Cb1-x2345678',
      firstName: 'Cerebro',
    });
  });

  it('treats "already setup" as success so re-runs are idempotent', async () => {
    mockFetchSequence([{ status: 400, body: { message: 'Instance owner already setup' } }]);
    const res = await setupOwner(BASE, { email: 'o@cerebro.local', password: 'Cb1-x2345678' });
    expect(res.ok).toBe(true);
    expect(res.alreadySetUp).toBe(true);
  });

  it('propagates real failures', async () => {
    mockFetchSequence([{ status: 500, body: { message: 'boom' } }]);
    const res = await setupOwner(BASE, { email: 'o@cerebro.local', password: 'Cb1-x2345678' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom');
  });
});

describe('login', () => {
  it('captures the n8n-auth session cookie', async () => {
    mockFetchSequence([
      {
        status: 200,
        body: { data: { id: 'u1' } },
        headers: {
          'set-cookie': `${N8N_AUTH_COOKIE_NAME}=jwt-token-here; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`,
        },
      },
    ]);
    const res = await login(BASE, { email: 'o@cerebro.local', password: 'Cb1-x2345678' });
    expect(res.ok).toBe(true);
    expect(res.cookie).toEqual({ name: N8N_AUTH_COOKIE_NAME, value: 'jwt-token-here' });
  });

  it('fails cleanly when no auth cookie comes back', async () => {
    mockFetchSequence([{ status: 200, body: { data: {} } }]);
    const res = await login(BASE, { email: 'o@cerebro.local', password: 'Cb1-x2345678' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cookie/);
  });
});

describe('createApiKey', () => {
  const cookie = { name: N8N_AUTH_COOKIE_NAME, value: 'jwt' };

  it('fetches grantable scopes and creates a scoped key (2.28.x path)', async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, body: { data: ['workflow:create', 'workflow:read', 'execution:read'] } },
      { status: 200, body: { data: { id: 'k1', rawApiKey: 'n8n-api-key-raw' } } },
    ]);
    const res = await createApiKey(BASE, cookie);
    expect(res.ok).toBe(true);
    expect(res.apiKey).toBe('n8n-api-key-raw');

    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/rest/api-keys/scopes`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(`${BASE}/rest/api-keys`);
    expect((init as RequestInit).headers).toMatchObject({ Cookie: `${N8N_AUTH_COOKIE_NAME}=jwt` });
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.scopes).toEqual(['workflow:create', 'workflow:read', 'execution:read']);
    expect(sent.expiresAt).toBeNull();
  });

  it('falls back to a scope-less payload for older versions', async () => {
    mockFetchSequence([
      { status: 404, body: { message: 'no scopes endpoint' } }, // scopes fetch fails
      { status: 200, body: { data: { apiKey: 'legacy-key-value' } } },
    ]);
    const res = await createApiKey(BASE, cookie);
    expect(res.ok).toBe(true);
    expect(res.apiKey).toBe('legacy-key-value');
  });

  it('reports when no recognizable key field exists', async () => {
    mockFetchSequence([
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: { id: 'k1' } } },
    ]);
    const res = await createApiKey(BASE, cookie);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/key field/);
  });
});
