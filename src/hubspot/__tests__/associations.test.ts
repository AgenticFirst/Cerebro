/**
 * Unit tests for the shared HubSpot association resolver and the two actions
 * that consume it (hubspot_get_ticket, hubspot_search_tickets with
 * include_associations). These mock `global.fetch`, so they need no token and
 * run in CI.
 *
 * The core thing under test is the bug: a ticket's company usually comes from
 * its associated *contact*, not a direct ticket→company link.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionContext, ActionInput } from '../../engine/actions/types';
import type { HubSpotChannel } from '../../engine/actions/hubspot-channel';
import { resolveObjectAssociations, resolveTicketAssociations } from '../associations';
import { createHubSpotGetTicketAction } from '../../engine/actions/hubspot-get-ticket';
import { createHubSpotSearchTicketsAction } from '../../engine/actions/hubspot-search-tickets';

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

/** v4 batch associations response from a fromId → toIds map. */
const assoc =
  (map: Record<string, string[]>): Responder =>
  () => ({
    status: 200,
    json: {
      results: Object.entries(map).map(([from, tos]) => ({
        from: { id: from },
        to: tos.map((toObjectId) => ({ toObjectId })),
      })),
    },
  });
/** v3 batch object read response from an id → properties map. */
const batchObjects =
  (objs: Record<string, Record<string, string>>): Responder =>
  () => ({
    status: 200,
    json: { results: Object.entries(objs).map(([id, properties]) => ({ id, properties })) },
  });
const fail =
  (code: number, message = 'err'): Responder =>
  () => ({ status: code, json: { message } });

beforeEach(() => {
  mockFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const urlCount = (fragment: string): number => calls.filter((c) => c.url.includes(fragment)).length;

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

// ── resolveTicketAssociations ─────────────────────────────────

describe('resolveTicketAssociations', () => {
  it('returns an empty map without calling the API for no ticket ids', async () => {
    const res = await resolveTicketAssociations(TOKEN, []);
    expect(res.byTicket.size).toBe(0);
    expect(res.error).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('resolves a direct ticket→company link as source "ticket"', async () => {
    queue(
      assoc({ T1: ['C1'] }), // tickets → contacts
      assoc({ T1: ['K1'] }), // tickets → companies (direct)
      assoc({ C1: ['K9'] }), // contacts → companies (ignored — direct wins)
      batchObjects({ C1: { email: 'c1@x.com', firstname: 'Ana', lastname: 'Ruiz' } }),
      batchObjects({ K1: { name: 'Argos', domain: 'argos.com' }, K9: { name: 'Other' } }),
    );
    const res = await resolveTicketAssociations(TOKEN, ['T1']);
    const t1 = res.byTicket.get('T1')!;
    expect(t1.contacts).toEqual([
      { id: 'C1', email: 'c1@x.com', firstname: 'Ana', lastname: 'Ruiz' },
    ]);
    expect(t1.companies).toEqual([
      { id: 'K1', name: 'Argos', domain: 'argos.com', source: 'ticket', via_contact_id: null },
    ]);
    expect(res.companiesScopeMissing).toBe(false);
  });

  it('derives the company from the contact when the ticket has no direct company', async () => {
    queue(
      assoc({ T1: ['C1'] }), // tickets → contacts
      assoc({}), // tickets → companies (none)
      assoc({ C1: ['K1'] }), // contacts → companies (the fallback)
      batchObjects({ C1: { email: 'c1@x.com' } }),
      batchObjects({ K1: { name: 'Keralty', domain: 'keralty.com' } }),
    );
    const res = await resolveTicketAssociations(TOKEN, ['T1']);
    const t1 = res.byTicket.get('T1')!;
    expect(t1.companies).toEqual([
      { id: 'K1', name: 'Keralty', domain: 'keralty.com', source: 'contact', via_contact_id: 'C1' },
    ]);
  });

  it('returns empty arrays for a ticket with no contact and no company', async () => {
    queue(
      assoc({}), // tickets → contacts (none)
      assoc({}), // tickets → companies (none)
    );
    const res = await resolveTicketAssociations(TOKEN, ['T1']);
    expect(res.byTicket.get('T1')).toEqual({ contacts: [], companies: [] });
    expect(res.error).toBeNull();
    // No contact ids → no contact/company batch reads.
    expect(calls).toHaveLength(2);
  });

  it('keeps the contact but no company when the contact has no company', async () => {
    queue(
      assoc({ T1: ['C1'] }), // tickets → contacts
      assoc({}), // tickets → companies (none)
      assoc({}), // contacts → companies (none)
      batchObjects({ C1: { email: 'c1@x.com' } }),
    );
    const res = await resolveTicketAssociations(TOKEN, ['T1']);
    const t1 = res.byTicket.get('T1')!;
    expect(t1.contacts).toHaveLength(1);
    expect(t1.companies).toEqual([]);
  });

  it('degrades gracefully when the companies scope is missing (403)', async () => {
    queue(
      assoc({ T1: ['C1'] }), // tickets → contacts (ok)
      fail(403, 'missing scope'), // tickets → companies (403)
      fail(403, 'missing scope'), // contacts → companies (403)
      batchObjects({ C1: { email: 'c1@x.com', firstname: 'Ana' } }),
    );
    const res = await resolveTicketAssociations(TOKEN, ['T1']);
    expect(res.companiesScopeMissing).toBe(true);
    expect(res.error).toBeNull();
    const t1 = res.byTicket.get('T1')!;
    expect(t1.contacts).toHaveLength(1);
    expect(t1.companies).toEqual([]);
  });

  it('propagates a hard failure of the contacts path', async () => {
    queue(fail(401, 'invalid token')); // tickets → contacts fails
    const res = await resolveTicketAssociations(TOKEN, ['T1']);
    expect(res.error).toBe('invalid token');
    expect(calls).toHaveLength(1);
  });

  it('chunks ticket ids at 100', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `T${i}`);
    // No queued responders → every call returns the default empty 200.
    await resolveTicketAssociations(TOKEN, ids);
    expect(urlCount('/crm/v4/associations/tickets/contacts/batch/read')).toBe(2);
    expect(urlCount('/crm/v4/associations/tickets/companies/batch/read')).toBe(2);
  });
});

// ── resolveObjectAssociations ─────────────────────────────────

describe('resolveObjectAssociations', () => {
  /**
   * The generic resolver fires its per-type reads concurrently, so FIFO
   * responders would be order-fragile — route by URL instead and queue one
   * router per expected call.
   */
  const routeBy =
    (routes: Array<[fragment: string, responder: Responder]>): Responder =>
    (call) => {
      for (const [fragment, responder] of routes) {
        if (call.url.includes(fragment)) return responder(call);
      }
      return { status: 200, json: {} };
    };

  it('resolves a contact’s companies, deals, and tickets with display properties', async () => {
    const router = routeBy([
      ['/crm/v4/associations/contacts/companies/', assoc({ C1: ['K1'] })],
      ['/crm/v4/associations/contacts/deals/', assoc({ C1: ['D1'] })],
      ['/crm/v4/associations/contacts/tickets/', assoc({ C1: ['T1'] })],
      [
        '/crm/v3/objects/companies/batch/read',
        batchObjects({ K1: { name: 'Keralty', domain: 'keralty.com' } }),
      ],
      [
        '/crm/v3/objects/deals/batch/read',
        batchObjects({ D1: { dealname: 'Q3 Renewal', amount: '5000' } }),
      ],
      ['/crm/v3/objects/tickets/batch/read', batchObjects({ T1: { subject: 'Login broken' } })],
    ]);
    queue(...Array.from({ length: 6 }, () => router));
    const res = await resolveObjectAssociations(TOKEN, 'contacts', ['C1']);
    const c1 = res.byObject.get('C1')!;
    expect(c1.companies).toEqual([{ company_id: 'K1', name: 'Keralty', domain: 'keralty.com' }]);
    expect(c1.deals).toEqual([{ deal_id: 'D1', dealname: 'Q3 Renewal', amount: '5000' }]);
    expect(c1.tickets).toEqual([{ ticket_id: 'T1', subject: 'Login broken' }]);
    expect(c1.contacts).toBeUndefined(); // the fromType itself is omitted
    expect(res.error).toBeNull();
    expect(res.scopeMissingTypes).toEqual([]);
    expect(calls).toHaveLength(6);
  });

  it('returns empty arrays (and makes no property reads) when nothing is associated', async () => {
    // No queued responders → every call returns the default empty 200.
    const res = await resolveObjectAssociations(TOKEN, 'deals', ['D1']);
    expect(res.byObject.get('D1')).toEqual({ contacts: [], companies: [], tickets: [] });
    expect(res.error).toBeNull();
    expect(calls).toHaveLength(3); // just the three association reads
  });

  it('marks a 403 type in scopeMissingTypes while the other types still resolve', async () => {
    const router = routeBy([
      ['/crm/v4/associations/contacts/companies/', fail(403, 'missing scope')],
      ['/crm/v4/associations/contacts/deals/', assoc({ C1: ['D1'] })],
      ['/crm/v4/associations/contacts/tickets/', assoc({})],
      ['/crm/v3/objects/deals/batch/read', batchObjects({ D1: { dealname: 'Renewal' } })],
    ]);
    queue(...Array.from({ length: 4 }, () => router));
    const res = await resolveObjectAssociations(TOKEN, 'contacts', ['C1']);
    expect(res.scopeMissingTypes).toEqual(['companies']);
    expect(res.error).toBeNull();
    const c1 = res.byObject.get('C1')!;
    expect(c1.companies).toEqual([]);
    expect(c1.deals).toEqual([{ deal_id: 'D1', dealname: 'Renewal', amount: null }]);
    expect(c1.tickets).toEqual([]);
  });

  it('records a hard failure in error while the other types still resolve', async () => {
    const router = routeBy([
      ['/crm/v4/associations/companies/contacts/', assoc({ K1: ['C1'] })],
      ['/crm/v4/associations/companies/deals/', fail(500, 'boom')],
      ['/crm/v4/associations/companies/tickets/', assoc({})],
      ['/crm/v3/objects/contacts/batch/read', batchObjects({ C1: { email: 'c1@x.com' } })],
    ]);
    queue(...Array.from({ length: 4 }, () => router));
    const res = await resolveObjectAssociations(TOKEN, 'companies', ['K1']);
    expect(res.error).toBe('boom');
    const k1 = res.byObject.get('K1')!;
    expect(k1.contacts).toEqual([
      { contact_id: 'C1', email: 'c1@x.com', firstname: null, lastname: null },
    ]);
    expect(k1.deals).toEqual([]);
  });

  it('returns seeded empty entries without calling the API for no ids', async () => {
    const res = await resolveObjectAssociations(TOKEN, 'contacts', []);
    expect(res.byObject.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('chunks ids at 100 per target type', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `C${i}`);
    // No queued responders → every call returns the default empty 200.
    await resolveObjectAssociations(TOKEN, 'contacts', ids);
    expect(urlCount('/crm/v4/associations/contacts/companies/batch/read')).toBe(2);
    expect(urlCount('/crm/v4/associations/contacts/deals/batch/read')).toBe(2);
    expect(urlCount('/crm/v4/associations/contacts/tickets/batch/read')).toBe(2);
  });
});

// ── hubspot_get_ticket ────────────────────────────────────────

describe('hubspot_get_ticket', () => {
  const action = createHubSpotGetTicketAction({ getChannel: buildChannel });

  it('returns the ticket plus its contact and contact-derived company', async () => {
    queue(
      () => ({ status: 200, json: { id: 'T1', properties: { subject: 'Login broken' } } }), // GET ticket
      assoc({ T1: ['C1'] }), // tickets → contacts
      assoc({}), // tickets → companies (none)
      assoc({ C1: ['K1'] }), // contacts → companies
      batchObjects({ C1: { email: 'c1@x.com', firstname: 'Ana' } }),
      batchObjects({ K1: { name: 'Keralty' } }),
    );
    const out = await action.execute(buildActionInput({ ticket_id: 'T1' }));
    expect(out.data.found).toBe(true);
    expect(out.data.subject).toBe('Login broken');
    expect(out.data.contacts).toEqual([
      { contact_id: 'C1', email: 'c1@x.com', firstname: 'Ana', lastname: null },
    ]);
    expect(out.data.companies).toEqual([
      { company_id: 'K1', name: 'Keralty', domain: null, source: 'contact', via_contact_id: 'C1' },
    ]);
    expect(out.data.companies_scope_missing).toBe(false);
    expect(out.data.ticket_url).toContain('/12345/ticket/T1');
  });

  it('flags companies_scope_missing while still returning the contact', async () => {
    queue(
      () => ({ status: 200, json: { id: 'T1', properties: { subject: 'S' } } }), // GET ticket
      assoc({ T1: ['C1'] }), // tickets → contacts (ok)
      fail(403, 'missing scope'), // tickets → companies (403)
      fail(403, 'missing scope'), // contacts → companies (403)
      batchObjects({ C1: { email: 'c1@x.com' } }),
    );
    const out = await action.execute(buildActionInput({ ticket_id: 'T1' }));
    expect(out.data.found).toBe(true);
    expect(out.data.companies_scope_missing).toBe(true);
    expect(out.data.companies).toEqual([]);
    expect(out.data.contacts).toHaveLength(1);
  });

  it('returns found:false for a 404 ticket without resolving associations', async () => {
    queue(fail(404, 'not found'));
    const out = await action.execute(buildActionInput({ ticket_id: 'nope' }));
    expect(out.data.found).toBe(false);
    expect(out.data.contacts).toEqual([]);
    expect(out.data.companies).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('surfaces a failed association lookup via associations_error', async () => {
    queue(
      () => ({ status: 200, json: { id: 'T1', properties: { subject: 'S' } } }), // GET ticket
      fail(500, 'boom'), // tickets → contacts fails hard
    );
    const out = await action.execute(buildActionInput({ ticket_id: 'T1' }));
    expect(out.data.found).toBe(true);
    expect(out.data.associations_error).toBe('boom');
    expect(out.data.contacts).toEqual([]);
    expect(out.data.companies).toEqual([]);
    expect(out.summary).toContain('association lookup failed');
  });
});

// ── hubspot_search_tickets — include_associations ─────────────

describe('hubspot_search_tickets include_associations', () => {
  const action = createHubSpotSearchTicketsAction({ getChannel: buildChannel });

  it('attaches contacts/companies in one batched lookup when requested', async () => {
    queue(
      () => ({
        status: 200,
        json: { results: [{ id: 'T1', properties: { subject: 'S' } }], total: 1 },
      }), // search
      assoc({ T1: ['C1'] }), // tickets → contacts
      assoc({ T1: ['K1'] }), // tickets → companies (direct)
      assoc({ C1: ['K9'] }), // contacts → companies
      batchObjects({ C1: { email: 'c1@x.com' } }),
      batchObjects({ K1: { name: 'Argos' }, K9: { name: 'Other' } }),
    );
    const out = await action.execute(buildActionInput({ include_associations: true }));
    const tickets = (out.data as { tickets: Array<Record<string, unknown>> }).tickets;
    expect(tickets[0].contacts).toEqual([
      { contact_id: 'C1', email: 'c1@x.com', firstname: null, lastname: null },
    ]);
    expect(tickets[0].companies).toEqual([
      { company_id: 'K1', name: 'Argos', domain: null, source: 'ticket', via_contact_id: null },
    ]);
  });

  it('makes zero association calls when the flag is omitted', async () => {
    queue(() => ({ status: 200, json: { results: [{ id: 'T1', properties: {} }], total: 1 } }));
    const out = await action.execute(buildActionInput({}));
    const tickets = (out.data as { tickets: Array<Record<string, unknown>> }).tickets;
    expect(tickets[0].contacts).toEqual([]);
    expect(tickets[0].companies).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(urlCount('/associations/')).toBe(0);
  });

  it('surfaces a failed association lookup via associations_error', async () => {
    queue(
      () => ({
        status: 200,
        json: { results: [{ id: 'T1', properties: { subject: 'S' } }], total: 1 },
      }), // search
      fail(500, 'boom'), // tickets → contacts fails hard
    );
    const out = await action.execute(buildActionInput({ include_associations: true }));
    expect(out.data.associations_error).toBe('boom');
    const tickets = (out.data as { tickets: Array<Record<string, unknown>> }).tickets;
    expect(tickets[0].contacts).toEqual([]);
    expect(out.summary).toContain('association lookup failed');
  });
});
