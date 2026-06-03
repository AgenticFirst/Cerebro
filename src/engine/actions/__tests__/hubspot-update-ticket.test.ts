/**
 * Unit tests for the hubspot_update_ticket action.
 *
 * These mock global.fetch (which callHubSpotApi uses under the hood) so they
 * run offline — no HubSpot token required. They assert the PATCH request shape
 * (endpoint, method, internal property names), the free-form properties merge,
 * the empty-patch short-circuit, and the graceful error paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../types';
import type { HubSpotChannel } from '../hubspot-channel';
import { createHubSpotUpdateTicketAction } from '../hubspot-update-ticket';

function buildChannel(opts: Partial<{ token: string | null; portalId: string }> = {}): HubSpotChannel {
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

function buildActionInput(params: Record<string, unknown>, wiredInputs: Record<string, unknown> = {}): ActionInput {
  const context: ActionContext = {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: 0,
    signal: new AbortController().signal,
    log: () => { /* no-op */ },
    emitEvent: () => { /* no-op */ },
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

describe('hubspot_update_ticket', () => {
  it('PATCHes the ticket with named fields mapped to internal property names', async () => {
    const fetchMock = mockFetch(200, { id: 'T1', properties: {} });

    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({
      ticket_id: 'T1',
      subject: 'Refund processed',
      priority: 'high', // lowercase → upper-cased + validated
      stage: '2',
      owner_id: 'owner-7',
    }));

    // ── Request shape ──
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/tickets/T1');
    expect((init as RequestInit).method).toBe('PATCH');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.properties).toEqual({
      subject: 'Refund processed',
      hs_ticket_priority: 'HIGH',
      hs_pipeline_stage: '2',
      hubspot_owner_id: 'owner-7',
    });

    // ── Result mapping ──
    expect(result.data.updated).toBe(true);
    expect(result.data.ticket_id).toBe('T1');
    expect(result.data.updated_fields).toEqual(
      expect.arrayContaining(['subject', 'hs_ticket_priority', 'hs_pipeline_stage', 'hubspot_owner_id']),
    );
    expect(result.data.ticket_url).toBe('https://app.hubspot.com/contacts/999/ticket/T1');
    expect(result.data.error).toBeNull();
  });

  it('merges the free-form properties map on top of named fields (overrides win)', async () => {
    const fetchMock = mockFetch(200, { id: 'T1' });

    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    await action.execute(buildActionInput({
      ticket_id: 'T1',
      subject: 'Named subject',
      properties: { custom_field_x: 'abc', subject: 'Override subject' },
    }));

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.properties.custom_field_x).toBe('abc');
    expect(sent.properties.subject).toBe('Override subject');
  });

  it('renders templates against wiredInputs', async () => {
    const fetchMock = mockFetch(200, { id: 'T9' });
    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    await action.execute(buildActionInput(
      { ticket_id: '{{id}}', subject: 'Order {{order}}' },
      { id: 'T9', order: '1234' },
    ));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/crm/v3/objects/tickets/T9');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.properties.subject).toBe('Order 1234');
  });

  it('returns updated:false WITHOUT calling the API when no properties are given', async () => {
    const fetchMock = mockFetch(200, {});
    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ ticket_id: 'T1' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.data.updated).toBe(false);
    expect(result.data.error).toBe('no properties to update');
  });

  it('returns a graceful not-found (not a throw) on 404', async () => {
    mockFetch(404, { message: 'Not found' });
    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ ticket_id: 'T1', subject: 'x' }));
    expect(result.data.updated).toBe(false);
    expect(result.data.error).toBe('ticket not found');
  });

  it('returns a graceful error (not a throw) when HubSpot responds non-ok', async () => {
    mockFetch(401, { message: 'Bad credentials' });
    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    const result = await action.execute(buildActionInput({ ticket_id: 'T1', subject: 'x' }));
    expect(result.data.updated).toBe(false);
    expect(result.data.error).toBe('Bad credentials');
  });

  it('throws when ticket_id is missing', async () => {
    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel() });
    await expect(action.execute(buildActionInput({ subject: 'x' }))).rejects.toThrow(/ticket_id is required/i);
  });

  it('throws when HubSpot is not configured', async () => {
    const action = createHubSpotUpdateTicketAction({ getChannel: () => null });
    await expect(action.execute(buildActionInput({ ticket_id: 'T1', subject: 'x' }))).rejects.toThrow(/not configured/i);
  });

  it('throws when there is no access token', async () => {
    const action = createHubSpotUpdateTicketAction({ getChannel: () => buildChannel({ token: null }) });
    await expect(action.execute(buildActionInput({ ticket_id: 'T1', subject: 'x' }))).rejects.toThrow(/no access token/i);
  });
});
