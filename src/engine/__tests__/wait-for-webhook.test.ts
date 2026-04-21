import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForWebhookAction } from '../actions/wait-for-webhook';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

vi.mock('../actions/utils/backend-fetch', () => ({
  backendFetch: vi.fn(),
}));

import { backendFetch } from '../actions/utils/backend-fetch';

const mockFetch = vi.mocked(backendFetch);

function makeContext(overrides?: Partial<ActionContext>): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
    ...overrides,
  };
}

const LISTENER = {
  listener_id: 'abcdef1234567890',
  endpoint_url: 'http://127.0.0.1:9999/webhooks/catch/abcdef1234567890',
};

beforeEach(() => {
  mockFetch.mockReset();
  // Default to resolved — the cleanup DELETE fires fire-and-forget via
  // `.catch(() => {})`, so the mock must always return a Promise even for
  // calls the individual test didn't explicitly queue.
  mockFetch.mockResolvedValue({} as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForWebhookAction', () => {
  // W-U1
  it('registers a listener with the configured params', async () => {
    mockFetch
      .mockResolvedValueOnce(LISTENER) // POST /webhooks/listen
      .mockResolvedValueOnce({ received: true, payload: { ok: 1 }, headers: { a: 'b' }, received_at: '2026-04-21T10:00:00Z' }); // first poll

    await waitForWebhookAction.execute({
      params: { match_path: '/stripe', timeout: 10, description: 'note' },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    const registerCall = mockFetch.mock.calls[0];
    expect(registerCall[1]).toBe('POST');
    expect(registerCall[2]).toBe('/webhooks/listen');
    expect(registerCall[3]).toEqual({
      match_path: '/stripe',
      timeout: 10,
      description: 'note',
    });
  });

  it('defaults timeout to 3600s and match_path/description to empty string', async () => {
    mockFetch
      .mockResolvedValueOnce(LISTENER)
      .mockResolvedValueOnce({ received: true, payload: {}, headers: {}, received_at: 'now' });

    await waitForWebhookAction.execute({
      params: {},
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(mockFetch.mock.calls[0][3]).toEqual({
      match_path: '',
      timeout: 3600,
      description: '',
    });
  });

  // W-U2
  it('returns payload + endpoint_url when the first poll sees received', async () => {
    const payload = { event: 'signed', order_id: 42 };
    const headers = { 'x-stripe-signature': 'xyz' };
    mockFetch
      .mockResolvedValueOnce(LISTENER)
      .mockResolvedValueOnce({
        received: true,
        payload,
        headers,
        received_at: '2026-04-21T12:00:00Z',
      });

    const result = await waitForWebhookAction.execute({
      params: { timeout: 10 },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data.payload).toEqual(payload);
    expect(result.data.headers).toEqual(headers);
    expect(result.data.received_at).toBe('2026-04-21T12:00:00Z');
    expect(result.data.endpoint_url).toBe(LISTENER.endpoint_url);
    expect(result.summary).toContain(LISTENER.endpoint_url);
  });

  // W-U5 — DELETE cleanup fires on success.
  it('issues DELETE /webhooks/listen/<id> after a successful webhook', async () => {
    mockFetch
      .mockResolvedValueOnce(LISTENER)
      .mockResolvedValueOnce({ received: true, payload: {}, headers: {}, received_at: 'now' })
      .mockResolvedValueOnce({}); // DELETE

    await waitForWebhookAction.execute({
      params: { timeout: 10 },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    // Allow the fire-and-forget cleanup microtask to resolve.
    await Promise.resolve();

    const deleteCall = mockFetch.mock.calls.find(
      (c) => c[1] === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall![2]).toBe(`/webhooks/listen/${LISTENER.listener_id}`);
  });

  // W-U3 — pre-aborted signal still cleans up AFTER registering.
  it('throws Aborted mid-poll and still issues DELETE cleanup', async () => {
    const ac = new AbortController();
    let pollCount = 0;
    mockFetch.mockImplementation(async (_port, method, path) => {
      if (method === 'POST' && path === '/webhooks/listen') {
        return LISTENER as unknown as never;
      }
      if (method === 'GET' && path.includes('/status')) {
        pollCount++;
        // After the first unreceived poll, abort the signal.
        if (pollCount === 1) {
          queueMicrotask(() => ac.abort());
          return { received: false } as unknown as never;
        }
        // Any subsequent call should see aborted
        throw new Error('poll ran after abort');
      }
      return {} as never;
    });

    const promise = waitForWebhookAction.execute({
      params: { timeout: 60 },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext({ signal: ac.signal }),
    });

    await expect(promise).rejects.toThrow(/Aborted/);

    // Cleanup DELETE must still fire (try/finally).
    await Promise.resolve();
    const deleteCall = mockFetch.mock.calls.find((c) => c[1] === 'DELETE');
    expect(deleteCall).toBeDefined();
  });

  // W-U4 — timeout path throws with the configured seconds in the message.
  // We drive this deterministically by setting timeout=0: the deadline is
  // `Date.now() + 0`, so the very first `Date.now() < deadline` check fails
  // and the action throws synchronously without entering the poll loop.
  it('throws a timeout error mentioning the configured seconds when the deadline has passed', async () => {
    mockFetch.mockImplementation(async (_port, method) => {
      if (method === 'POST') return LISTENER as unknown as never;
      return {} as never;
    });

    await expect(
      waitForWebhookAction.execute({
        params: { timeout: 0 },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/Webhook timeout.*within 0s/);

    // Cleanup still fires despite the timeout.
    await Promise.resolve();
    const deleteCall = mockFetch.mock.calls.find((c) => c[1] === 'DELETE');
    expect(deleteCall).toBeDefined();
  });

  it('outputSchema declares payload and endpoint_url as required', () => {
    expect(waitForWebhookAction.outputSchema.required).toEqual(
      expect.arrayContaining(['payload', 'endpoint_url']),
    );
  });
});
