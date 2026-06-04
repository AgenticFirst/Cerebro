/**
 * Unit tests for the generic HubSpot CRM-object actions (list/create/update/
 * delete for contacts/companies/deals).
 *
 * Mocks global.fetch (used by callHubSpotApi) so they run offline. Asserts the
 * uniform /crm/v3/objects/{type} request shapes, the property allowlist,
 * required-field errors, the contacts→upsert delegation, deep-link URLs, and
 * the graceful error paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../types';
import type { HubSpotChannel } from '../hubspot-channel';
import {
  createHubSpotCreateObjectAction,
  createHubSpotUpdateObjectAction,
  createHubSpotDeleteObjectAction,
  createHubSpotListObjectsAction,
} from '../hubspot-crm-objects';

function buildChannel(
  opts: Partial<{ token: string | null; portalId: string }> = {},
): HubSpotChannel {
  return {
    getAccessToken: () => (opts.token === undefined ? 'pat-test' : opts.token),
    getPortalId: () => opts.portalId ?? '999',
    getDefaultPipeline: () => null,
    getDefaultStage: () => null,
    getFollowUpProperty: () => null,
    getDueDateProperty: () => null,
    isConnected: () => Boolean(opts.token ?? 'pat-test'),
    listPipelines: async () => ({ ok: true, pipelines: [] }),
  };
}

function buildActionInput(
  params: Record<string, unknown>,
  wiredInputs: Record<string, unknown> = {},
): ActionInput {
  const context: ActionContext = {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: 0,
    signal: new AbortController().signal,
    log: () => {
      /* no-op */
    },
    emitEvent: () => {
      /* no-op */
    },
  };
  return {
    params,
    wiredInputs,
    scratchpad: {} as unknown as ActionInput['scratchpad'],
    context,
  };
}

/** Mock fetch returning one fixed JSON body for every call. */
function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Mock fetch returning a different response per call, in order. */
function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hubspot_create_object', () => {
  it('POSTs a company with allowed properties and returns id + deep-link', async () => {
    const fetchMock = mockFetch(200, { id: 'CMP1' });
    const action = createHubSpotCreateObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({
        object_type: 'companies',
        name: 'Acme',
        domain: 'acme.com',
      }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/companies');
    expect(String(url)).not.toContain('/search');
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.properties).toEqual({ name: 'Acme', domain: 'acme.com' });

    expect(result.data.created).toBe(true);
    expect(result.data.id).toBe('CMP1');
    expect(result.data.url).toBe('https://app.hubspot.com/contacts/999/record/0-2/CMP1');
    expect(result.data.error).toBeNull();
  });

  it('drops properties the type does not allow', async () => {
    const fetchMock = mockFetch(200, { id: 'D1' });
    const action = createHubSpotCreateObjectAction({ getChannel: () => buildChannel() });
    await action.execute(
      buildActionInput({
        object_type: 'deals',
        dealname: 'Q3 Renewal',
        amount: '5000',
        properties: { bogus_field: 'x' },
      }),
    );
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.properties).toEqual({ dealname: 'Q3 Renewal', amount: '5000' });
    expect(sent.properties.bogus_field).toBeUndefined();
  });

  it('returns a required-field error for a deal without dealname (no API call)', async () => {
    const fetchMock = mockFetch(200, {});
    const action = createHubSpotCreateObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ object_type: 'deals', amount: '5000' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.created).toBe(false);
    expect(result.data.error).toMatch(/dealname/i);
  });

  it('routes contacts through the idempotent upsert (search then create)', async () => {
    const fetchMock = mockFetchSequence([
      { status: 200, body: { results: [] } }, // search: not found
      { status: 200, body: { id: 'C1' } }, // create
    ]);
    const action = createHubSpotCreateObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({
        object_type: 'contacts',
        email: 'maria@example.com',
        firstname: 'Maria',
      }),
    );

    expect(String(fetchMock.mock.calls[0][0])).toContain('/crm/v3/objects/contacts/search');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/crm/v3/objects/contacts');
    expect(result.data.created).toBe(true);
    expect(result.data.id).toBe('C1');
    expect(result.data.url).toBe('https://app.hubspot.com/contacts/999/record/0-1/C1');
  });

  it('throws on an invalid object_type', async () => {
    const action = createHubSpotCreateObjectAction({ getChannel: () => buildChannel() });
    await expect(
      action.execute(buildActionInput({ object_type: 'widgets', name: 'x' })),
    ).rejects.toThrow(/object_type/i);
  });

  it('surfaces a HubSpot error gracefully (no throw)', async () => {
    mockFetch(403, { message: 'Missing scope' });
    const action = createHubSpotCreateObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ object_type: 'companies', name: 'Acme' }),
    );
    expect(result.data.created).toBe(false);
    expect(result.data.error).toBe('Missing scope');
  });
});

describe('hubspot_update_object', () => {
  it('PATCHes the object by id with the changed fields', async () => {
    const fetchMock = mockFetch(200, { id: 'D1' });
    const action = createHubSpotUpdateObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({
        object_type: 'deals',
        object_id: 'D1',
        amount: '8000',
      }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/deals/D1');
    expect((init as RequestInit).method).toBe('PATCH');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.properties).toEqual({ amount: '8000' });
    expect(result.data.updated).toBe(true);
    expect(result.data.url).toBe('https://app.hubspot.com/contacts/999/record/0-3/D1');
  });

  it('returns an error when no updatable fields are provided (no API call)', async () => {
    const fetchMock = mockFetch(200, {});
    const action = createHubSpotUpdateObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ object_type: 'companies', object_id: 'CMP1' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.updated).toBe(false);
    expect(result.data.error).toMatch(/no updatable fields/i);
  });

  it('throws when object_id is missing', async () => {
    const action = createHubSpotUpdateObjectAction({ getChannel: () => buildChannel() });
    await expect(
      action.execute(buildActionInput({ object_type: 'deals', amount: '1' })),
    ).rejects.toThrow(/object_id is required/i);
  });
});

describe('hubspot_delete_object', () => {
  it('DELETEs the object by id', async () => {
    const fetchMock = mockFetch(200, {});
    const action = createHubSpotDeleteObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ object_type: 'companies', object_id: 'CMP1' }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/companies/CMP1');
    expect((init as RequestInit).method).toBe('DELETE');
    expect(result.data.deleted).toBe(true);
    expect(result.data.error).toBeNull();
  });

  it('surfaces a delete error gracefully', async () => {
    mockFetch(404, { message: 'Not found' });
    const action = createHubSpotDeleteObjectAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ object_type: 'deals', object_id: 'D9' }),
    );
    expect(result.data.deleted).toBe(false);
    expect(result.data.error).toBe('Not found');
  });
});

describe('hubspot_list_objects', () => {
  it('searches the right object type and maps results with label + url', async () => {
    const fetchMock = mockFetch(200, {
      results: [{ id: 'CMP1', properties: { name: 'Acme', domain: 'acme.com' } }],
      total: 1,
    });
    const action = createHubSpotListObjectsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ object_type: 'companies', name: 'Acme' }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/companies/search');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.filterGroups[0].filters).toContainEqual({
      propertyName: 'name',
      operator: 'EQ',
      value: 'Acme',
    });

    expect(result.data.count).toBe(1);
    expect(result.data.objects[0].id).toBe('CMP1');
    expect(result.data.objects[0].label).toBe('Acme (acme.com)');
    expect(result.data.objects[0].url).toBe('https://app.hubspot.com/contacts/999/record/0-2/CMP1');
  });

  it('returns a graceful empty list + error on a failed search', async () => {
    mockFetch(401, { message: 'Bad credentials' });
    const action = createHubSpotListObjectsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ object_type: 'deals' }));
    expect(result.data.count).toBe(0);
    expect(result.data.error).toBe('Bad credentials');
  });
});

describe('connection guards', () => {
  it('throws when HubSpot is not configured', async () => {
    const action = createHubSpotListObjectsAction({ getChannel: () => null });
    await expect(action.execute(buildActionInput({ object_type: 'contacts' }))).rejects.toThrow(
      /not configured/i,
    );
  });

  it('throws when there is no access token', async () => {
    const action = createHubSpotCreateObjectAction({
      getChannel: () => buildChannel({ token: null }),
    });
    await expect(
      action.execute(buildActionInput({ object_type: 'companies', name: 'x' })),
    ).rejects.toThrow(/no access token/i);
  });
});
