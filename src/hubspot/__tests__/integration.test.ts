/**
 * Live HubSpot integration tests.
 *
 * These hit the real HubSpot API and require a Private App access token in
 * the `HUBSPOT_TEST_TOKEN` env var. The token is NEVER committed — set it in
 * your shell before running:
 *
 *   HUBSPOT_TEST_TOKEN=pat-na2-... npm run test:frontend -- src/hubspot
 *
 * If the env var isn't set the whole suite is skipped (so CI / other devs
 * aren't broken). Every contact / ticket the suite creates is tracked and
 * deleted in `afterAll` so we don't pollute the operator's HubSpot portal.
 */

import { afterAll, describe, expect, it } from 'vitest';
import type { ActionContext, ActionInput } from '../../engine/actions/types';
import type { HubSpotChannel } from '../../engine/actions/hubspot-channel';
import { callHubSpotApi } from '../api';
import { createHubSpotCreateTicketAction } from '../../engine/actions/hubspot-create-ticket';
import { createHubSpotUpsertContactAction } from '../../engine/actions/hubspot-upsert-contact';

const TOKEN = process.env.HUBSPOT_TEST_TOKEN ?? '';
const HAS_TOKEN = TOKEN.startsWith('pat-');

// describe.skipIf keeps CI green when no token is configured.
const d = HAS_TOKEN ? describe : describe.skip;

// ── Cleanup tracking ──────────────────────────────────────────

const createdContactIds = new Set<string>();
const createdTicketIds = new Set<string>();

afterAll(async () => {
  if (!HAS_TOKEN) return;
  for (const id of createdTicketIds) {
    await callHubSpotApi(TOKEN, `/crm/v3/objects/tickets/${id}`, { method: 'DELETE' })
      .catch(() => { /* best effort */ });
  }
  for (const id of createdContactIds) {
    await callHubSpotApi(TOKEN, `/crm/v3/objects/contacts/${id}`, { method: 'DELETE' })
      .catch(() => { /* best effort */ });
  }
});

// ── Test helpers ──────────────────────────────────────────────

function buildChannel(token: string, opts: Partial<{ pipeline: string; stage: string; portalId: string }> = {}): HubSpotChannel {
  return {
    getAccessToken: () => token,
    getPortalId: () => opts.portalId ?? null,
    getDefaultPipeline: () => opts.pipeline ?? null,
    getDefaultStage: () => opts.stage ?? null,
    isConnected: () => Boolean(token && opts.pipeline && opts.stage),
  };
}

function buildActionInput(params: Record<string, unknown>, wiredInputs: Record<string, unknown> = {}): ActionInput {
  const logs: string[] = [];
  const context: ActionContext = {
    runId: 'test-run',
    stepId: 'test-step',
    backendPort: 0,
    signal: new AbortController().signal,
    log: (msg) => { logs.push(msg); },
    emitEvent: () => { /* no-op */ },
  };
  return {
    params,
    wiredInputs,
    // RunScratchpad is duck-typed in our test path — none of these actions
    // touch it. Cast through unknown to keep the test file self-contained.
    scratchpad: {} as unknown as ActionInput['scratchpad'],
    context,
  };
}

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const TEST_EMAIL = `cerebro-test-${RUN_ID}@example.com`;
const TEST_PHONE = `+1555${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

// ── Tests ─────────────────────────────────────────────────────

d('HubSpot integration (live)', () => {
  // Pipeline + stage discovered in test 3, reused by tests 4-5.
  let firstPipelineId = '';
  let firstStageId = '';
  // Contact created in test 4, reused as the association in test 5.
  let upsertedContactId = '';

  it('1. verify(): valid token returns ok=true with a portal id', async () => {
    const res = await callHubSpotApi<{ portalId?: number | string }>(
      TOKEN,
      '/account-info/v3/details',
    );
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(res.data).toBeTruthy();
    const portalId = res.data?.portalId;
    expect(portalId).toBeDefined();
    expect(String(portalId)).toMatch(/^\d+$/);
  });

  it('2. verify(): invalid token returns ok=false with a readable error', async () => {
    const res = await callHubSpotApi(TOKEN + '-bogus-suffix', '/account-info/v3/details');
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(typeof res.error).toBe('string');
    expect(res.error?.length).toBeGreaterThan(0);
  });

  it('3. listPipelines(): returns at least one ticket pipeline with a stage', async () => {
    const res = await callHubSpotApi<{
      results?: Array<{ id: string; label: string; stages?: Array<{ id: string; label: string }> }>;
    }>(TOKEN, '/crm/v3/pipelines/tickets');
    expect(res.ok).toBe(true);
    const pipelines = res.data?.results ?? [];
    expect(pipelines.length).toBeGreaterThan(0);
    const first = pipelines[0];
    expect(first.id).toBeTruthy();
    expect(first.stages?.length).toBeGreaterThan(0);
    firstPipelineId = first.id;
    firstStageId = first.stages![0].id;
  });

  it('4. hubspot_upsert_contact: creates a new contact, then matches it on a second call', async () => {
    const action = createHubSpotUpsertContactAction({ getChannel: () => buildChannel(TOKEN) });

    // First call: brand-new email, expect a fresh create.
    const first = await action.execute(buildActionInput({
      email: TEST_EMAIL,
      phone: TEST_PHONE,
      firstname: 'Cerebro',
      lastname: 'TestRun',
    }));
    expect(first.data.created).toBe(true);
    expect(first.data.contact_id).toBeTruthy();
    upsertedContactId = String(first.data.contact_id);
    createdContactIds.add(upsertedContactId);

    // Second call with same email: action should match and return created=false.
    const second = await action.execute(buildActionInput({
      email: TEST_EMAIL,
      phone: TEST_PHONE,
      firstname: 'Cerebro',
    }));
    expect(second.data.created).toBe(false);
    expect(second.data.matched_by).toBe('email');
    expect(second.data.contact_id).toBe(upsertedContactId);
  });

  it('5. hubspot_create_ticket: opens a ticket associated with the upserted contact', async () => {
    expect(firstPipelineId).toBeTruthy();
    expect(firstStageId).toBeTruthy();
    expect(upsertedContactId).toBeTruthy();

    const action = createHubSpotCreateTicketAction({
      getChannel: () => buildChannel(TOKEN, {
        pipeline: firstPipelineId,
        stage: firstStageId,
        portalId: '123', // any value; only used to build a deep link string
      }),
    });

    const subject = `[Cerebro integration test ${RUN_ID}] please ignore`;
    const result = await action.execute(buildActionInput({
      subject,
      content: 'Created by Cerebro\'s automated integration tests. Safe to delete.',
      priority: 'LOW',
      contact_id: upsertedContactId,
    }));

    expect(result.data.created).toBe(true);
    expect(result.data.error).toBeNull();
    const ticketId = result.data.ticket_id;
    expect(ticketId).toBeTruthy();
    createdTicketIds.add(String(ticketId));

    // ticket_url is built from the portal id we passed in, so it should be
    // a real-looking URL (not asserting the portal — that's mocked).
    expect(typeof result.data.ticket_url).toBe('string');
    expect(result.data.ticket_url).toMatch(/^https:\/\/app\.hubspot\.com\/contacts\/123\/ticket\//);

    // Sanity-check via direct API: the ticket exists and has the right subject.
    const fetched = await callHubSpotApi<{ properties?: { subject?: string; hs_pipeline?: string } }>(
      TOKEN,
      `/crm/v3/objects/tickets/${ticketId}?properties=subject,hs_pipeline`,
    );
    expect(fetched.ok).toBe(true);
    expect(fetched.data?.properties?.subject).toBe(subject);
    expect(fetched.data?.properties?.hs_pipeline).toBe(firstPipelineId);
  });
});

// Surface a friendly hint in test output when nothing ran.
if (!HAS_TOKEN) {
  describe('HubSpot integration (live) — skipped', () => {
    it('set HUBSPOT_TEST_TOKEN=pat-... to run these', () => {
      expect(true).toBe(true);
    });
  });
}
