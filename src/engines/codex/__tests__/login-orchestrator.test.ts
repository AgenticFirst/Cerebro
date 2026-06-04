/**
 * Pins the URL-capture + state-machine behavior of the in-app `codex login`
 * flow. The fixture below is the ACTUAL output of `codex login` (codex-cli
 * 0.128.0) captured from a real run, so this test is a faithful guard against
 * the URL regex silently drifting. Uses a mocked PTY — it never spawns the real
 * codex binary (which would open the user's browser).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

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
  getCachedCodexInfo: () => ({ status: 'available', path: '/fake/codex' }),
}));

vi.mock('../auth-probe', () => ({
  probeCodexAuth: (opts?: { force?: boolean }) => probeFn(opts),
  clearCodexProbeCache: vi.fn(),
}));

import { CodexLoginOrchestrator } from '../login-orchestrator';

// The exact multi-line block `codex login` (0.128.0) prints to the PTY.
const REAL_CODEX_LOGIN_OUTPUT =
  'Starting local login server on http://localhost:1455.\n' +
  'If your browser did not open, navigate to this URL to authenticate:\n' +
  '\n' +
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access&code_challenge=OmwzI3KT8iNrTCu_nwSJuwaLVNiTIO0Lme9TC5YqLdo&code_challenge_method=S256&state=Hs_4t189PbW1xQLHF7VinxyBo5bzEw4rWA_hfLWWDpQ&originator=codex_cli_rs\n' +
  '\n' +
  'On a remote or headless machine? Use `codex login --device-auth` instead.\n';

describe('CodexLoginOrchestrator', () => {
  let orchestrator: CodexLoginOrchestrator;

  beforeEach(() => {
    orchestrator = new CodexLoginOrchestrator();
    currentPty = null;
    probeFn.mockReset();
    probeFn.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures the auth.openai.com URL from real `codex login` output', async () => {
    const startPromise = orchestrator.start();
    await Promise.resolve();
    currentPty!.emitData(REAL_CODEX_LOGIN_OUTPUT);
    const snap = await startPromise;
    expect(snap.status).toBe('awaiting-user');
    expect(snap.url).toBe(
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access&code_challenge=OmwzI3KT8iNrTCu_nwSJuwaLVNiTIO0Lme9TC5YqLdo&code_challenge_method=S256&state=Hs_4t189PbW1xQLHF7VinxyBo5bzEw4rWA_hfLWWDpQ&originator=codex_cli_rs',
    );
  });

  it('does NOT mistake the localhost callback line for the auth URL', async () => {
    const startPromise = orchestrator.start();
    await Promise.resolve();
    currentPty!.emitData(REAL_CODEX_LOGIN_OUTPUT);
    const snap = await startPromise;
    expect(snap.url).toContain('auth.openai.com');
    expect(snap.url).not.toMatch(/^https?:\/\/localhost/);
  });

  it('strips ANSI before scanning, so a colorized URL still matches', async () => {
    const startPromise = orchestrator.start();
    await Promise.resolve();
    currentPty!.emitData('\x1b[36mhttps://auth.openai.com/oauth/authorize?code=1\x1b[0m\n');
    const snap = await startPromise;
    expect(snap.url).toBe('https://auth.openai.com/oauth/authorize?code=1');
  });

  it('reports success when the CLI exits 0 and the auth probe passes', async () => {
    const startPromise = orchestrator.start();
    await Promise.resolve();
    currentPty!.emitData(REAL_CODEX_LOGIN_OUTPUT);
    await startPromise;
    const updates: string[] = [];
    orchestrator.on('update', (s: { status: string }) => updates.push(s.status));
    currentPty!.emitExit(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(probeFn).toHaveBeenCalledWith({ force: true });
    expect(updates).toContain('success');
  });

  it('marks failure when the CLI exits non-zero before any URL', async () => {
    const startPromise = orchestrator.start();
    await Promise.resolve();
    currentPty!.emitExit(2);
    await expect(startPromise).rejects.toThrow();
    expect(orchestrator.current()).toBeNull();
  });

  it('rejects concurrent start() until the first settles', async () => {
    const first = orchestrator.start();
    await Promise.resolve();
    await expect(orchestrator.start()).rejects.toThrow(/already in progress/);
    currentPty!.emitExit(0);
    await expect(first).rejects.toThrow();
  });

  it('cancel() kills the subprocess and clears the active attempt', async () => {
    const startPromise = orchestrator.start();
    await Promise.resolve();
    currentPty!.emitData(REAL_CODEX_LOGIN_OUTPUT);
    const snap = await startPromise;
    orchestrator.cancel(snap.loginId);
    expect(currentPty!.killed).toBe(true);
    expect(orchestrator.current()).toBeNull();
  });
});
