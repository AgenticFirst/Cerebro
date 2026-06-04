/**
 * Unit tests for the shared HubSpot contact helpers and the email-association
 * path on hubspot_create_ticket. These mock `global.fetch`, so they need no
 * token and run in CI (the live suite in integration.test.ts stays skipped).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../../engine/actions/types';
import type { HubSpotChannel } from '../../engine/actions/hubspot-channel';
import { findContactByEmail, upsertContact } from '../contacts';
import { createHubSpotCreateTicketAction } from '../../engine/actions/hubspot-create-ticket';
import { createHubSpotSearchContactAction } from '../../engine/actions/hubspot-search-contact';

const TOKEN = 'pat-test-token';

// ── fetch mock ────────────────────────────────────────────────

interface MockCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

const calls: MockCall[] = [];
type Responder = (call: MockCall) => { status: number; json: unknown };
let responders: Responder[] = [];

function mockFetch(): void {
  calls.length = 0;
  responders = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    const call: MockCall = { url, method: init.method ?? 'GET', body };
    calls.push(call);
    const responder = responders.shift() ?? (() => ({ status: 200, json: {} }));
    const { status, json } = responder(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json),
    } as unknown as Response;
  });
}

/** Queue responses in the order calls will be made. */
function queue(...rs: Responder[]): void {
  responders.push(...rs);
}

const searchHit =
  (id: string, props: Record<string, string> = {}): Responder =>
  () => ({ status: 200, json: { results: [{ id, properties: props }] } });
const searchMiss: Responder = () => ({ status: 200, json: { results: [] } });
const created =
  (id: string): Responder =>
  () => ({ status: 201, json: { id } });

beforeEach(() => {
  mockFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── test scaffolding for actions ──────────────────────────────

function buildChannel(): HubSpotChannel {
  return {
    getAccessToken: () => TOKEN,
    getPortalId: () => '12345',
    getDefaultPipeline: () => '0',
    getDefaultStage: () => '1',
    getFollowUpProperty: () => null,
    getDueDateProperty: () => null,
    isConnected: () => true,
    listPipelines: async () => ({ ok: true, pipelines: [] }),
  };
}

function buildActionInput(params: Record<string, unknown>): ActionInput {
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
    wiredInputs: {},
    scratchpad: {} as unknown as ActionInput['scratchpad'],
    context,
  };
}

// ── findContactByEmail ────────────────────────────────────────

describe('findContactByEmail', () => {
  it('returns the contact on a hit', async () => {
    queue(searchHit('501', { email: 'maria@example.com', firstname: 'Maria' }));
    const res = await findContactByEmail(TOKEN, 'maria@example.com');
    expect(res.error).toBeNull();
    expect(res.contact).toEqual({
      id: '501',
      properties: { email: 'maria@example.com', firstname: 'Maria' },
    });
    expect(calls[0].url).toContain('/crm/v3/objects/contacts/search');
  });

  it('returns null contact (no error) on a clean miss', async () => {
    queue(searchMiss);
    const res = await findContactByEmail(TOKEN, 'nobody@example.com');
    expect(res.error).toBeNull();
    expect(res.contact).toBeNull();
  });

  it('surfaces the error without throwing on API failure', async () => {
    queue(() => ({ status: 401, json: { message: 'invalid token' } }));
    const res = await findContactByEmail(TOKEN, 'maria@example.com');
    expect(res.contact).toBeNull();
    expect(res.error).toBe('invalid token');
  });
});

// ── upsertContact ─────────────────────────────────────────────

describe('upsertContact', () => {
  it('matches an existing contact and does not create', async () => {
    queue(searchHit('501'));
    const res = await upsertContact(TOKEN, { email: 'maria@example.com' });
    expect(res).toMatchObject({ contactId: '501', created: false, matchedBy: 'email' });
    // search only — no create POST since there were no extra fields to patch
    expect(calls).toHaveLength(1);
  });

  it('creates a contact when none matches', async () => {
    queue(searchMiss, created('777'));
    const res = await upsertContact(TOKEN, { email: 'new@example.com' });
    expect(res).toMatchObject({ contactId: '777', created: true, matchedBy: null });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/crm/v3/objects/contacts');
  });
});

// ── hubspot_create_ticket with contact_email ──────────────────

describe('hubspot_create_ticket — contact_email association', () => {
  const action = createHubSpotCreateTicketAction({ getChannel: buildChannel });

  it('associates an existing contact found by email', async () => {
    queue(searchHit('501'), created('900')); // search contact, then create ticket
    const out = await action.execute(
      buildActionInput({ subject: 'Help', contact_email: 'maria@example.com' }),
    );
    expect(out.data.created).toBe(true);
    expect(out.data.contact_associated).toBe(true);
    expect(out.data.contact_id).toBe('501');
    // ticket POST is the last call and carries the association
    const ticketCall = calls[calls.length - 1];
    expect(ticketCall.url).toContain('/crm/v3/objects/tickets');
    expect(ticketCall.body?.associations).toEqual([
      {
        to: { id: '501' },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
      },
    ]);
  });

  it('creates then associates when the email is unknown', async () => {
    queue(searchMiss, created('778'), created('901')); // search miss, create contact, create ticket
    const out = await action.execute(
      buildActionInput({ subject: 'Help', contact_email: 'new@example.com' }),
    );
    expect(out.data.contact_associated).toBe(true);
    expect(out.data.contact_id).toBe('778');
    const ticketCall = calls[calls.length - 1];
    expect(ticketCall.body?.associations).toEqual([
      {
        to: { id: '778' },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
      },
    ]);
  });

  it('still opens the ticket unassociated when contact resolution fails', async () => {
    // search fails, create-contact fails, then ticket create succeeds
    queue(
      () => ({ status: 500, json: { message: 'search down' } }),
      () => ({ status: 500, json: { message: 'create down' } }),
      created('902'),
    );
    const out = await action.execute(
      buildActionInput({ subject: 'Help', contact_email: 'maria@example.com' }),
    );
    expect(out.data.created).toBe(true);
    expect(out.data.contact_associated).toBe(false);
    expect(out.data.contact_id).toBeNull();
    const ticketCall = calls[calls.length - 1];
    expect(ticketCall.body?.associations).toBeUndefined();
  });

  it('prefers an explicit contact_id over contact_email (no lookup)', async () => {
    queue(created('903')); // only the ticket POST should fire
    const out = await action.execute(
      buildActionInput({ subject: 'Help', contact_id: '42', contact_email: 'maria@example.com' }),
    );
    expect(out.data.contact_id).toBe('42');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/crm/v3/objects/tickets');
  });
});

// ── hubspot_search_contact ────────────────────────────────────

describe('hubspot_search_contact', () => {
  const action = createHubSpotSearchContactAction({ getChannel: buildChannel });

  it('returns found + identity on a hit', async () => {
    queue(searchHit('501', { email: 'maria@example.com', firstname: 'Maria', lastname: 'Lopez' }));
    const out = await action.execute(buildActionInput({ email: 'maria@example.com' }));
    expect(out.data).toMatchObject({
      found: true,
      contact_id: '501',
      email: 'maria@example.com',
      firstname: 'Maria',
      lastname: 'Lopez',
    });
  });

  it('returns found:false on a miss', async () => {
    queue(searchMiss);
    const out = await action.execute(buildActionInput({ email: 'nobody@example.com' }));
    expect(out.data.found).toBe(false);
    expect(out.data.contact_id).toBeNull();
  });
});
