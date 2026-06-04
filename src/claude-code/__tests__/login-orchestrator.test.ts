/**
 * Pins the URL-capture + state-machine behavior of the in-Cerebro Claude
 * Code login flow. This is load-bearing: the chat sign-in card and the
 * Slack/Telegram operator-DM flow both render off the snapshots this
 * orchestrator emits — if the URL regex stops matching, users land on
 * "Waiting for browser…" forever and never see a clickable link.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Fake PTY we can drive from tests.
class FakePty extends EventEmitter {
  killed = false;
  written: string[] = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  onData(cb: (d: string) => void): void {
    this.dataListeners.push(cb);
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(cb);
  }
  write(data: string): void {
    this.written.push(data);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(d: string): void {
    for (const cb of this.dataListeners) cb(d);
  }
  emitExit(exitCode: number, signal?: number): void {
    for (const cb of this.exitListeners) cb({ exitCode, signal });
  }
}

let currentPty: FakePty | null = null;
const probeFn = vi.fn(async () => ({ ok: true as const }));

vi.mock('node-pty', () => ({
  spawn: () => {
    const p = new FakePty();
    currentPty = p;
    return p;
  },
}));

vi.mock('../detector', () => ({
  getCachedClaudeCodeInfo: () => ({ status: 'available', path: '/fake/claude' }),
}));

vi.mock('../auth-probe', () => ({
  probeClaudeAuth: (opts?: { force?: boolean }) => probeFn(opts),
  clearProbeCache: vi.fn(),
}));

// Import AFTER mocks are registered.
import { ClaudeCodeLoginOrchestrator } from '../login-orchestrator';

describe('ClaudeCodeLoginOrchestrator', () => {
  let orchestrator: ClaudeCodeLoginOrchestrator;

  beforeEach(() => {
    orchestrator = new ClaudeCodeLoginOrchestrator();
    currentPty = null;
    probeFn.mockReset();
    probeFn.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves start() with the captured claude.ai URL', async () => {
    const startPromise = orchestrator.start('setup-token');
    await Promise.resolve();
    currentPty!.emitData(
      'Open the following URL in your browser:\nhttps://claude.ai/oauth/authorize?code=abc123 \n',
    );
    const snap = await startPromise;
    expect(snap.url).toBe('https://claude.ai/oauth/authorize?code=abc123');
    expect(snap.status).toBe('awaiting-user');
    expect(snap.requiresCode).toBe(true);
    expect(snap.mode).toBe('setup-token');
  });

  it('also accepts console.anthropic.com URLs', async () => {
    const startPromise = orchestrator.start('oauth');
    await Promise.resolve();
    currentPty!.emitData('Visit https://console.anthropic.com/login?token=xyz to continue.');
    const snap = await startPromise;
    expect(snap.url).toContain('console.anthropic.com');
    expect(snap.requiresCode).toBe(false);
  });

  it('strips ANSI before scanning, so a colorized URL still matches', async () => {
    const startPromise = orchestrator.start('oauth');
    await Promise.resolve();
    currentPty!.emitData('\x1b[36mhttps://claude.ai/login?code=1\x1b[0m\n');
    const snap = await startPromise;
    expect(snap.url).toBe('https://claude.ai/login?code=1');
  });

  it('rejects concurrent start() calls until the first one settles', async () => {
    const first = orchestrator.start('oauth');
    await Promise.resolve();
    await expect(orchestrator.start('setup-token')).rejects.toThrow(/already in progress/);
    // Settle the first so the test fixture can clean up.
    currentPty!.emitExit(0);
    await expect(first).rejects.toThrow(); // exit-before-url → rejection is acceptable
  });

  it('feeds the paste-back code into the PTY on submitCode', async () => {
    const startPromise = orchestrator.start('setup-token');
    await Promise.resolve();
    currentPty!.emitData('Open https://claude.ai/oauth/authorize?code=abc');
    const snap = await startPromise;

    const submit = orchestrator.submitCode(snap.loginId, '  CODE-789  ');
    // The orchestrator should have written the trimmed code + carriage return.
    expect(currentPty!.written).toContainEqual('CODE-789\r');

    currentPty!.emitExit(0);
    const finalSnap = await submit;
    expect(finalSnap.status).toBe('success');
    expect(probeFn).toHaveBeenCalledWith({ force: true });
  });

  it('marks the attempt as failure when the CLI exits non-zero before any URL', async () => {
    const startPromise = orchestrator.start('oauth');
    await Promise.resolve();
    currentPty!.emitExit(2);
    await expect(startPromise).rejects.toThrow();
    expect(orchestrator.current()).toBeNull();
  });

  it('rejects submitCode in oauth mode', async () => {
    const startPromise = orchestrator.start('oauth');
    await Promise.resolve();
    currentPty!.emitData('https://claude.ai/oauth?x=1');
    const snap = await startPromise;
    await expect(orchestrator.submitCode(snap.loginId, 'code')).rejects.toThrow(
      /only valid for setup-token/,
    );
    currentPty!.emitExit(0);
  });

  it('falls through to failure when the post-success probe still says ok:false', async () => {
    probeFn.mockResolvedValueOnce({ ok: false, reason: 'still not authenticated' });
    const startPromise = orchestrator.start('setup-token');
    await Promise.resolve();
    currentPty!.emitData('https://claude.ai/oauth?code=1');
    const snap = await startPromise;

    const submit = orchestrator.submitCode(snap.loginId, 'WRONG');
    currentPty!.emitExit(0);
    const finalSnap = await submit;
    expect(finalSnap.status).toBe('failure');
    expect(finalSnap.reason).toMatch(/still not authenticated/);
  });

  it('cancel() kills the subprocess and clears the active attempt', async () => {
    const startPromise = orchestrator.start('oauth');
    await Promise.resolve();
    currentPty!.emitData('https://claude.ai/oauth?x=1');
    const snap = await startPromise;

    orchestrator.cancel(snap.loginId);
    expect(currentPty!.killed).toBe(true);
    expect(orchestrator.current()).toBeNull();
  });
});
