/**
 * Unit tests for the shared ticket-field resolution: date normalization and
 * buildTicketExtras (owner / follow-up / due-date → property map). fetch is
 * mocked for the owner lookups buildTicketExtras delegates to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubSpotChannel } from '../../engine/actions/hubspot-channel';
import { clearOwnersCache } from '../owners';
import { normalizeHubSpotDate, formatHubSpotDate, buildTicketExtras } from '../ticket-fields';

const TOKEN = 'pat-test-token';

function mockFetch(json: unknown): void {
  vi.stubGlobal(
    'fetch',
    async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(json),
      }) as unknown as Response,
  );
}

const OWNERS = {
  results: [
    { id: '101', email: 'maria@example.com', firstName: 'María', lastName: 'López' },
    { id: '102', email: 'juan@example.com', firstName: 'Juan', lastName: 'Pérez' },
  ],
};

function buildChannel(
  opts: Partial<{ followUp: string | null; dueDate: string | null }> = {},
): HubSpotChannel {
  return {
    getAccessToken: () => TOKEN,
    getPortalId: () => '999',
    getDefaultPipeline: () => '0',
    getDefaultStage: () => '1',
    getFollowUpProperty: () => opts.followUp ?? null,
    getDueDateProperty: () => opts.dueDate ?? null,
    isConnected: () => true,
    listPipelines: async () => ({ ok: true, pipelines: [] }),
  };
}

const noop = () => {
  /* no-op */
};

beforeEach(() => {
  clearOwnersCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeHubSpotDate', () => {
  it('turns YYYY-MM-DD into midnight-UTC epoch ms', () => {
    const res = normalizeHubSpotDate('2026-06-10');
    expect(res.value).toBe(String(Date.UTC(2026, 5, 10)));
    expect(res.warning).toBeUndefined();
  });

  it('truncates an ISO datetime to midnight UTC', () => {
    const res = normalizeHubSpotDate('2026-06-10T15:30:00Z');
    expect(res.value).toBe(String(Date.UTC(2026, 5, 10)));
  });

  it('warns and writes nothing for an unparseable date', () => {
    const res = normalizeHubSpotDate('not-a-date');
    expect(res.value).toBeNull();
    expect(res.warning).toContain('not-a-date');
  });

  it('returns null for a blank input', () => {
    expect(normalizeHubSpotDate('  ').value).toBeNull();
  });
});

describe('formatHubSpotDate', () => {
  it('formats epoch ms back to YYYY-MM-DD', () => {
    expect(formatHubSpotDate(String(Date.UTC(2026, 5, 10)))).toBe('2026-06-10');
  });

  it('passes an ISO date through as YYYY-MM-DD', () => {
    expect(formatHubSpotDate('2026-06-10')).toBe('2026-06-10');
  });

  it('returns null for blank', () => {
    expect(formatHubSpotDate('')).toBeNull();
    expect(formatHubSpotDate(null)).toBeNull();
  });
});

describe('buildTicketExtras', () => {
  it('resolves owner by name and writes hubspot_owner_id', async () => {
    mockFetch(OWNERS);
    const res = await buildTicketExtras({
      channel: buildChannel(),
      token: TOKEN,
      log: noop,
      owner: 'María López',
    });
    expect(res.props.hubspot_owner_id).toBe('101');
    expect(res.ownerResolved).toBe('101');
    expect(res.warnings).toEqual([]);
  });

  it('honors a legacy raw owner id when owner is empty', async () => {
    mockFetch(OWNERS);
    const res = await buildTicketExtras({
      channel: buildChannel(),
      token: TOKEN,
      log: noop,
      ownerId: '555',
    });
    expect(res.props.hubspot_owner_id).toBe('555');
  });

  it('warns (and writes nothing) when an owner name cannot be resolved', async () => {
    mockFetch(OWNERS);
    const res = await buildTicketExtras({
      channel: buildChannel(),
      token: TOKEN,
      log: noop,
      owner: 'Ghost User',
    });
    expect(res.props.hubspot_owner_id).toBeUndefined();
    expect(res.warnings[0]).toContain('Owner not set');
  });

  it('writes the follow-up user to the configured property', async () => {
    mockFetch(OWNERS);
    const res = await buildTicketExtras({
      channel: buildChannel({ followUp: 'hs_followup_user' }),
      token: TOKEN,
      log: noop,
      followUpUser: 'juan@example.com',
    });
    expect(res.props.hs_followup_user).toBe('102');
    expect(res.followUpResolved).toBe('102');
  });

  it('warns when the follow-up property is not configured', async () => {
    mockFetch(OWNERS);
    const res = await buildTicketExtras({
      channel: buildChannel(),
      token: TOKEN,
      log: noop,
      followUpUser: 'juan@example.com',
    });
    expect(res.followUpResolved).toBeNull();
    expect(res.warnings[0]).toContain('no follow-up property is configured');
  });

  it('writes a normalized due date to the configured property', async () => {
    const res = await buildTicketExtras({
      channel: buildChannel({ dueDate: 'hs_due_date' }),
      token: TOKEN,
      log: noop,
      dueDate: '2026-06-10',
    });
    expect(res.props.hs_due_date).toBe(String(Date.UTC(2026, 5, 10)));
    expect(res.dueDateSet).toBe(String(Date.UTC(2026, 5, 10)));
  });

  it('warns when the due-date property is not configured', async () => {
    const res = await buildTicketExtras({
      channel: buildChannel(),
      token: TOKEN,
      log: noop,
      dueDate: '2026-06-10',
    });
    expect(res.dueDateSet).toBeNull();
    expect(res.warnings[0]).toContain('no due-date property is configured');
  });

  it('does no owner lookup and writes nothing when no rich fields are given', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await buildTicketExtras({ channel: buildChannel(), token: TOKEN, log: noop });
    expect(res.props).toEqual({});
    expect(res.warnings).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
