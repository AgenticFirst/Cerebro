/**
 * Unit tests for the HubSpot owner-resolution helpers. These mock global.fetch
 * (which callHubSpotApi uses) so they run offline — no token needed. They cover
 * the match ladder (email / full name / first-or-last / numeric id), ambiguity,
 * the missing-scope path, pagination, and the per-token cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveOwner, ownerDisplayNames, clearOwnersCache } from '../owners';

const TOKEN = 'pat-test-token';

interface MockCall {
  url: string;
}
const calls: MockCall[] = [];
type Responder = () => { status: number; json: unknown };
let responders: Responder[] = [];

function mockFetch(): void {
  calls.length = 0;
  responders = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push({ url });
    const responder = responders.shift() ?? (() => ({ status: 200, json: { results: [] } }));
    const { status, json } = responder();
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  });
}

function queue(...rs: Responder[]): void {
  responders.push(...rs);
}

const OWNERS = [
  { id: '101', email: 'maria@example.com', firstName: 'María', lastName: 'López' },
  { id: '102', email: 'juan@example.com', firstName: 'Juan', lastName: 'Pérez' },
  { id: '103', email: 'juan.other@example.com', firstName: 'Juan', lastName: 'Gómez' },
];
const ownersPage =
  (results: unknown[], after?: string): Responder =>
  () => ({ status: 200, json: { results, ...(after ? { paging: { next: { after } } } : {}) } });

beforeEach(() => {
  mockFetch();
  clearOwnersCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveOwner', () => {
  it('resolves by exact email (case-insensitive)', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, 'MARIA@example.com');
    expect(res).toMatchObject({
      ownerId: '101',
      matchedBy: 'email',
      ambiguous: false,
      error: null,
    });
    expect(calls[0].url).toContain('/crm/v3/owners');
  });

  it('resolves by exact full name', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, 'María López');
    expect(res).toMatchObject({ ownerId: '101', matchedBy: 'fullName' });
  });

  it('resolves by a unique first name', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, 'María');
    expect(res.ownerId).toBe('101');
    expect(res.matchedBy).toBe('name');
  });

  it('flags ambiguity when a first name matches multiple users', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, 'Juan');
    expect(res.ownerId).toBeNull();
    expect(res.ambiguous).toBe(true);
    expect(res.error).toContain('juan@example.com');
    expect(res.error).toContain('juan.other@example.com');
  });

  it('treats a pure-numeric query as an id and confirms it exists', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, '102');
    expect(res).toMatchObject({ ownerId: '102', matchedBy: 'id' });
  });

  it('returns an error for an unknown numeric id', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, '999');
    expect(res.ownerId).toBeNull();
    expect(res.error).toContain('999');
  });

  it('returns a clear no-match error', async () => {
    queue(ownersPage(OWNERS));
    const res = await resolveOwner(TOKEN, 'Nobody Here');
    expect(res.ownerId).toBeNull();
    expect(res.ambiguous).toBe(false);
    expect(res.error).toContain('Nobody Here');
  });

  it('surfaces a scope/API error without throwing', async () => {
    queue(() => ({ status: 403, json: { message: 'missing scope crm.objects.owners.read' } }));
    const res = await resolveOwner(TOKEN, 'maria@example.com');
    expect(res.ownerId).toBeNull();
    expect(res.error).toContain('scope');
  });

  it('follows pagination across pages', async () => {
    queue(ownersPage([OWNERS[0]], 'CURSOR'), ownersPage([OWNERS[1], OWNERS[2]]));
    const res = await resolveOwner(TOKEN, 'juan.other@example.com');
    expect(res.ownerId).toBe('103');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('after=CURSOR');
  });

  it('caches the owner list per token (one fetch for repeat lookups)', async () => {
    queue(ownersPage(OWNERS));
    await resolveOwner(TOKEN, 'maria@example.com');
    await resolveOwner(TOKEN, 'juan@example.com');
    expect(calls).toHaveLength(1);
  });

  it('returns an empty result for a blank query without calling the API', async () => {
    const res = await resolveOwner(TOKEN, '   ');
    expect(res).toMatchObject({ ownerId: null, error: null });
    expect(calls).toHaveLength(0);
  });
});

describe('ownerDisplayNames', () => {
  it('maps ids to "First Last", skipping unknown ids', async () => {
    queue(ownersPage(OWNERS));
    const names = await ownerDisplayNames(TOKEN, ['101', '102', '404']);
    expect(names.get('101')).toBe('María López');
    expect(names.get('102')).toBe('Juan Pérez');
    expect(names.has('404')).toBe(false);
  });

  it('returns an empty map (no fetch) when given no ids', async () => {
    const names = await ownerDisplayNames(TOKEN, []);
    expect(names.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
