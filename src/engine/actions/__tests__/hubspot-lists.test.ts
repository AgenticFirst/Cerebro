/**
 * Unit tests for the HubSpot Lists ("segments") actions.
 *
 * Mocks global.fetch (used by callHubSpotApi) so they run offline. Asserts the
 * /crm/v3/lists request shapes (create/rename/delete/search), the membership
 * add/remove endpoints, comma-separated record_ids parsing, and the graceful
 * error path (e.g. a dynamic list rejecting manual membership).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../types';
import type { HubSpotChannel } from '../hubspot-channel';
import {
  createHubSpotListListsAction,
  createHubSpotCreateListAction,
  createHubSpotUpdateListAction,
  createHubSpotDeleteListAction,
  createHubSpotListMembershipAction,
} from '../hubspot-lists';

function buildChannel(opts: Partial<{ token: string | null }> = {}): HubSpotChannel {
  return {
    getAccessToken: () => (opts.token === undefined ? 'pat-test' : opts.token),
    getPortalId: () => '999',
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

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hubspot_create_list', () => {
  it('POSTs a static contacts list by default', async () => {
    const fetchMock = mockFetch(200, { list: { listId: '42', name: 'VIP' } });
    const action = createHubSpotCreateListAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ name: 'VIP' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/lists/');
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual({ name: 'VIP', objectTypeId: '0-1', processingType: 'MANUAL' });

    expect(result.data.created).toBe(true);
    expect(result.data.list_id).toBe('42');
  });

  it('honors processing_type DYNAMIC', async () => {
    const fetchMock = mockFetch(200, { list: { listId: '43', name: 'Auto' } });
    const action = createHubSpotCreateListAction({ getChannel: () => buildChannel() });
    await action.execute(buildActionInput({ name: 'Auto', processing_type: 'dynamic' }));
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.processingType).toBe('DYNAMIC');
  });

  it('throws when name is missing', async () => {
    const action = createHubSpotCreateListAction({ getChannel: () => buildChannel() });
    await expect(action.execute(buildActionInput({}))).rejects.toThrow(/name is required/i);
  });
});

describe('hubspot_update_list', () => {
  it('PUTs the new name as a query param', async () => {
    const fetchMock = mockFetch(200, {});
    const action = createHubSpotUpdateListAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ list_id: '42', name: 'Top accounts' }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/lists/42/update-list-name');
    expect(String(url)).toContain('listName=Top%20accounts');
    expect((init as RequestInit).method).toBe('PUT');
    expect(result.data.updated).toBe(true);
  });
});

describe('hubspot_delete_list', () => {
  it('DELETEs the list by id', async () => {
    const fetchMock = mockFetch(200, {});
    const action = createHubSpotDeleteListAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ list_id: '42' }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/lists/42');
    expect((init as RequestInit).method).toBe('DELETE');
    expect(result.data.deleted).toBe(true);
  });
});

describe('hubspot_list_lists', () => {
  it('searches lists and maps size, dates, and pagination metadata', async () => {
    const fetchMock = mockFetch(200, {
      lists: [
        {
          listId: '42',
          name: 'VIP',
          processingType: 'MANUAL',
          createdAt: '2026-06-16T10:00:00Z',
          updatedAt: '2026-06-17T10:00:00Z',
          additionalProperties: { hs_list_size: '5' },
        },
      ],
      total: 120,
      hasMore: true,
    });
    const action = createHubSpotListListsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ query: 'VIP' }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/lists/search');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.query).toBe('VIP');
    expect(sent.additionalProperties).toEqual(['hs_list_size']);

    expect(result.data.count).toBe(1);
    expect(result.data.total).toBe(120);
    expect(result.data.has_more).toBe(true);
    expect(result.data.next_offset).toBe(1);
    expect(result.data.lists[0]).toEqual({
      list_id: '42',
      name: 'VIP',
      processing_type: 'MANUAL',
      size: 5,
      created_at: '2026-06-16T10:00:00Z',
      updated_at: '2026-06-17T10:00:00Z',
    });
  });

  it('caps limit at 500 and passes offset through', async () => {
    const fetchMock = mockFetch(200, { lists: [], total: 0, hasMore: false });
    const action = createHubSpotListListsAction({ getChannel: () => buildChannel() });
    await action.execute(buildActionInput({ limit: 9999, offset: 100 }));
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.count).toBe(500);
    expect(sent.offset).toBe(100);
  });

  it('sort_by created_at scans all pages and returns newest first', async () => {
    const pageOne = {
      lists: [
        { listId: '1', name: 'Old', processingType: 'MANUAL', createdAt: '2024-01-01T00:00:00Z' },
        { listId: '2', name: 'Mid', processingType: 'MANUAL', createdAt: '2025-06-01T00:00:00Z' },
      ],
      total: 3,
      hasMore: true,
    };
    const pageTwo = {
      lists: [
        {
          listId: '2296',
          name: 'New',
          processingType: 'DYNAMIC',
          createdAt: '2026-06-16T00:00:00Z',
        },
      ],
      total: 3,
      hasMore: false,
    };
    const fn = vi.fn(
      async () =>
        new Response(JSON.stringify(fn.mock.calls.length <= 1 ? pageOne : pageTwo), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fn);

    const action = createHubSpotListListsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ sort_by: 'created_at', limit: 2 }));

    expect(fn).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fn.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.count).toBe(500);
    expect(firstBody.offset).toBe(0);
    expect(secondBody.offset).toBe(2);

    expect(result.data.total).toBe(3);
    expect(result.data.count).toBe(2);
    expect(result.data.has_more).toBe(true);
    expect(result.data.lists.map((l: { list_id: string }) => l.list_id)).toEqual(['2296', '2']);
    expect(result.data.lists[0].created_at).toBe('2026-06-16T00:00:00Z');
  });

  it('sort_by name defaults ascending and puts missing values last', async () => {
    mockFetch(200, {
      lists: [
        { listId: '3', name: 'Zeta', processingType: 'MANUAL' },
        { listId: '4', name: '', processingType: 'MANUAL' },
        { listId: '5', name: 'Alpha', processingType: 'MANUAL' },
      ],
      total: 3,
      hasMore: false,
    });
    const action = createHubSpotListListsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ sort_by: 'name' }));
    expect(result.data.lists.map((l: { list_id: string }) => l.list_id)).toEqual(['5', '3', '4']);
  });
});

describe('hubspot_list_membership', () => {
  it('PUTs an array of ids to the add endpoint, parsing a comma-separated string', async () => {
    const fetchMock = mockFetch(200, { recordsIdsAdded: ['789', '790'] });
    const action = createHubSpotListMembershipAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ list_id: '42', mode: 'add', record_ids: '789, 790' }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/lists/42/memberships/add');
    expect((init as RequestInit).method).toBe('PUT');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent).toEqual(['789', '790']);
    expect(result.data.mode).toBe('add');
    expect(result.data.updated).toBe(2);
  });

  it('uses the remove endpoint for mode remove and accepts an array', async () => {
    const fetchMock = mockFetch(200, { recordsIdsRemoved: ['789'] });
    const action = createHubSpotListMembershipAction({ getChannel: () => buildChannel() });
    await action.execute(buildActionInput({ list_id: '42', mode: 'remove', record_ids: ['789'] }));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/crm/v3/lists/42/memberships/remove');
  });

  it('surfaces a dynamic-list rejection gracefully', async () => {
    mockFetch(400, { message: 'Cannot manually add records to a dynamic list' });
    const action = createHubSpotListMembershipAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({ list_id: '42', mode: 'add', record_ids: '789' }),
    );
    expect(result.data.updated).toBe(0);
    expect(result.data.error).toMatch(/dynamic list/i);
  });

  it('throws when no record ids are given', async () => {
    const action = createHubSpotListMembershipAction({ getChannel: () => buildChannel() });
    await expect(
      action.execute(buildActionInput({ list_id: '42', mode: 'add', record_ids: '' })),
    ).rejects.toThrow(/record id/i);
  });
});
