/**
 * Unit tests for the hubspot_search_tickets action.
 *
 * These mock global.fetch (which callHubSpotApi uses under the hood) so they
 * run offline — no HubSpot token required. They assert the search body shape
 * (createdate epoch-ms filters, sort, properties, clamped limit), the
 * id→label resolution, and the graceful error path.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../types';
import type { HubSpotChannel } from '../hubspot-channel';
import { createHubSpotSearchTicketsAction } from '../hubspot-search-tickets';

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
    listPipelines: async () => ({
      ok: true,
      pipelines: [
        {
          id: '0',
          label: 'Support Pipeline',
          stages: [
            { id: '1', label: 'New', displayOrder: 0 },
            { id: '2', label: 'Waiting on us', displayOrder: 1 },
          ],
        },
      ],
    }),
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

/** Mock fetch returning the given JSON body with the given status. */
function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hubspot_search_tickets', () => {
  it('builds a createdate range search and maps tickets with stage labels + deep links', async () => {
    const fetchMock = mockFetch(200, {
      total: 1,
      results: [
        {
          id: 'T1',
          properties: {
            subject: 'Login broken',
            content: 'Cannot log in',
            hs_pipeline: '0',
            hs_pipeline_stage: '2',
            hs_ticket_priority: 'HIGH',
            createdate: '2026-05-28T09:00:00Z',
            hs_lastmodifieddate: '2026-05-28T10:00:00Z',
            hubspot_owner_id: 'owner-7',
          },
        },
      ],
    });

    const action = createHubSpotSearchTicketsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(
      buildActionInput({
        created_after: '2026-05-28',
        created_before: '2026-05-29',
        limit: 250, // should clamp to 100
      }),
    );

    // ── Request shape ──
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/tickets/search');
    expect((init as RequestInit).method).toBe('POST');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.limit).toBe(100);
    expect(sent.sorts).toEqual([{ propertyName: 'createdate', direction: 'DESCENDING' }]);
    expect(sent.properties).toContain('hs_pipeline_stage');
    const filters = sent.filterGroups[0].filters;
    const after = filters.find((f: { operator: string }) => f.operator === 'GTE');
    const before = filters.find((f: { operator: string }) => f.operator === 'LTE');
    expect(after.propertyName).toBe('createdate');
    expect(after.value).toBe(String(Date.parse('2026-05-28')));
    expect(before.value).toBe(String(Date.parse('2026-05-29')));

    // ── Result mapping ──
    expect(result.data.count).toBe(1);
    const tickets = result.data.tickets as Array<Record<string, unknown>>;
    expect(tickets[0].ticket_id).toBe('T1');
    expect(tickets[0].subject).toBe('Login broken');
    expect(tickets[0].stage).toBe('2');
    expect(tickets[0].stage_label).toBe('Waiting on us');
    expect(tickets[0].pipeline_label).toBe('Support Pipeline');
    expect(tickets[0].priority).toBe('HIGH');
    expect(tickets[0].ticket_url).toBe('https://app.hubspot.com/contacts/999/ticket/T1');
    expect(result.data.error).toBeNull();
  });

  it('sends an empty filterGroups when no filters are given', async () => {
    const fetchMock = mockFetch(200, { results: [] });
    const action = createHubSpotSearchTicketsAction({ getChannel: () => buildChannel() });
    await action.execute(buildActionInput({}));
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.filterGroups).toEqual([]);
    expect(sent.limit).toBe(50); // default
  });

  it('returns a graceful error (not a throw) when HubSpot responds non-ok', async () => {
    mockFetch(401, { message: 'Bad credentials' });
    const action = createHubSpotSearchTicketsAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({}));
    expect(result.data.count).toBe(0);
    expect(result.data.tickets).toEqual([]);
    expect(result.data.error).toBe('Bad credentials');
  });

  it('throws when HubSpot is not configured', async () => {
    const action = createHubSpotSearchTicketsAction({ getChannel: () => null });
    await expect(action.execute(buildActionInput({}))).rejects.toThrow(/not configured/i);
  });

  it('throws when there is no access token', async () => {
    const action = createHubSpotSearchTicketsAction({
      getChannel: () => buildChannel({ token: null }),
    });
    await expect(action.execute(buildActionInput({}))).rejects.toThrow(/no access token/i);
  });
});
