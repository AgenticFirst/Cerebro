/**
 * SttLoader.ensureReady — the shared warm-up every bridge (Slack, Telegram,
 * WhatsApp) runs before transcribing a voice note.
 *
 * The critical regression here: /voice/status returns `stt` as an engine
 * state STRING ("idle" | "loading" | "ready" | "error"). An earlier version
 * read `stt.is_loaded` (always undefined), so the fast path never fired and
 * every voice note re-posted the "first voice note…" loading notice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const backendJsonRequest = vi.fn();
vi.mock('../../shared/backend-settings', () => ({
  backendJsonRequest: (...args: unknown[]) => backendJsonRequest(...args),
}));

import { SttLoader, STT_MODEL_ID } from '../stt-loader';

function statusResponse(stt: string, modelId: string | null) {
  return { ok: true, status: 200, data: { stt, stt_model_id: modelId } };
}

describe('SttLoader.ensureReady', () => {
  beforeEach(() => {
    backendJsonRequest.mockReset();
  });

  it('returns true on the fast path without notifying or loading', async () => {
    backendJsonRequest.mockResolvedValueOnce(statusResponse('ready', STT_MODEL_ID));

    const loader = new SttLoader(() => 4242);
    const notify = vi.fn(async () => {});
    await expect(loader.ensureReady(notify)).resolves.toBe(true);

    expect(notify).not.toHaveBeenCalled();
    // Only the status probe — no POST /voice/stt/load round-trip.
    expect(backendJsonRequest).toHaveBeenCalledTimes(1);
    expect(backendJsonRequest).toHaveBeenCalledWith(4242, 'GET', '/voice/status');
  });

  it('does not take the fast path when a different model is loaded', async () => {
    backendJsonRequest
      .mockResolvedValueOnce(statusResponse('ready', 'some-other-model'))
      .mockResolvedValueOnce({ ok: true, status: 200, data: {} }); // POST /voice/stt/load

    const loader = new SttLoader(() => 4242);
    const notify = vi.fn(async () => {});
    await expect(loader.ensureReady(notify)).resolves.toBe(true);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(backendJsonRequest).toHaveBeenCalledWith(4242, 'POST', '/voice/stt/load');
  });

  it('loads (with one notice) when the engine is idle', async () => {
    backendJsonRequest
      .mockResolvedValueOnce(statusResponse('idle', null))
      .mockResolvedValueOnce({ ok: true, status: 200, data: {} });

    const loader = new SttLoader(() => 4242);
    const notify = vi.fn(async () => {});
    await expect(loader.ensureReady(notify)).resolves.toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('returns false when the load fails (non-404)', async () => {
    backendJsonRequest
      .mockResolvedValueOnce(statusResponse('idle', null))
      .mockResolvedValueOnce({ ok: false, status: 500, data: null });

    const loader = new SttLoader(() => 4242);
    await expect(loader.ensureReady(async () => {})).resolves.toBe(false);
  });

  it('coalesces concurrent calls onto one load with one notice', async () => {
    let releaseLoad!: (v: { ok: boolean; status: number; data: object }) => void;
    const pendingLoad = new Promise((resolve) => {
      releaseLoad = resolve as typeof releaseLoad;
    });
    backendJsonRequest.mockImplementation(async (_port, method: string, path: string) => {
      if (method === 'GET' && path === '/voice/status') return statusResponse('idle', null);
      if (method === 'POST' && path === '/voice/stt/load') return pendingLoad;
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    const loader = new SttLoader(() => 4242);
    const notify = vi.fn(async () => {});
    const first = loader.ensureReady(notify);
    const second = loader.ensureReady(notify);
    releaseLoad({ ok: true, status: 200, data: {} });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    const loadCalls = backendJsonRequest.mock.calls.filter(
      ([, m, p]) => m === 'POST' && p === '/voice/stt/load',
    );
    expect(loadCalls).toHaveLength(1);
  });
});
