/**
 * Drives `codex login` (ChatGPT OAuth) from inside Cerebro so users sign in
 * without opening a terminal. Mirrors src/claude-code/login-orchestrator.ts,
 * trimmed to Codex's single browser-based OAuth flow (no paste-back code).
 *
 * `codex login` opens a localhost callback in the browser and also prints the
 * sign-in URL; we capture the URL when present and confirm via a forced
 * `codex login status` re-probe on clean exit.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { getCachedCodexInfo } from './detector';
import { probeCodexAuth, clearCodexProbeCache } from './auth-probe';
import { stripAnsiFull } from '../../utils/ansi';
import type { CodexLoginSnapshot, CodexLoginStatus } from '../../types/ipc';

interface ActiveAttempt {
  loginId: string;
  proc: pty.IPty;
  startedAt: number;
  status: CodexLoginStatus;
  url: string | null;
  reason: string | null;
  scratch: string;
  urlResolve: ((s: CodexLoginSnapshot) => void) | null;
  urlReject: ((e: Error) => void) | null;
  urlTimer: NodeJS.Timeout | null;
}

const URL_TIMEOUT_MS = 20_000;
const URL_RE =
  /https?:\/\/(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com|login\.openai\.com)\/[^\s\x07\x1b]+/i;

export class CodexLoginOrchestrator extends EventEmitter {
  private active: ActiveAttempt | null = null;

  start(): Promise<CodexLoginSnapshot> {
    if (this.active) {
      return Promise.reject(
        new Error('A Codex login attempt is already in progress. Cancel it first.'),
      );
    }
    const info = getCachedCodexInfo();
    if (info.status !== 'available' || !info.path) {
      return Promise.reject(new Error('Codex CLI not found.'));
    }

    const loginId = crypto.randomUUID();
    const env = { ...process.env } as Record<string, string>;
    env.FORCE_COLOR = '0';

    let proc: pty.IPty;
    try {
      proc = pty.spawn(info.path, ['login'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env,
      });
    } catch (err) {
      return Promise.reject(new Error(`Failed to spawn codex login: ${(err as Error).message}`));
    }

    const attempt: ActiveAttempt = {
      loginId,
      proc,
      startedAt: Date.now(),
      status: 'starting',
      url: null,
      reason: null,
      scratch: '',
      urlResolve: null,
      urlReject: null,
      urlTimer: null,
    };
    this.active = attempt;

    const snapshotPromise = new Promise<CodexLoginSnapshot>((resolve, reject) => {
      attempt.urlResolve = resolve;
      attempt.urlReject = reject;
    });

    attempt.urlTimer = setTimeout(() => {
      if (!this.active || this.active.loginId !== loginId) return;
      if (this.active.status !== 'starting') return;
      // No URL after the window — the CLI likely opened the browser itself.
      // Move to awaiting-user and let the exit handler settle.
      this.transition('awaiting-user');
      attempt.urlResolve?.(this.snapshot());
      attempt.urlResolve = null;
      attempt.urlReject = null;
    }, URL_TIMEOUT_MS);

    proc.onData((data: string) => this.handleData(data));
    proc.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal));

    return snapshotPromise;
  }

  cancel(loginId?: string): void {
    const a = this.active;
    if (!a) return;
    if (loginId && a.loginId !== loginId) return;
    a.reason = 'Cancelled by user.';
    this.transition('cancelled');
    try {
      a.proc.kill();
    } catch {
      /* noop */
    }
    this.cleanup(a);
  }

  current(): CodexLoginSnapshot | null {
    return this.active ? this.snapshot() : null;
  }

  private handleData(raw: string): void {
    const a = this.active;
    if (!a) return;
    const clean = stripAnsiFull(raw);
    if (!clean) return;
    a.scratch = (a.scratch + clean).slice(-4096);
    if (!a.url) {
      const m = a.scratch.match(URL_RE);
      if (m) {
        a.url = m[0];
        if (a.urlTimer) {
          clearTimeout(a.urlTimer);
          a.urlTimer = null;
        }
        this.transition('awaiting-user');
        a.urlResolve?.(this.snapshot());
        a.urlResolve = null;
        a.urlReject = null;
      }
    }
  }

  private async handleExit(exitCode: number, signal: number | undefined): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (a.urlTimer) {
      clearTimeout(a.urlTimer);
      a.urlTimer = null;
    }
    if (a.status === 'cancelled' || a.status === 'failure' || a.status === 'success') {
      this.cleanup(a);
      return;
    }

    if (exitCode === 0) {
      clearCodexProbeCache();
      const probe = await probeCodexAuth({ force: true });
      if (probe.ok) {
        this.transition('success');
      } else {
        a.reason = probe.reason ?? 'codex login exited cleanly but the auth probe still fails.';
        this.transition('failure');
      }
    } else {
      a.reason =
        signal != null
          ? `codex login killed by signal ${signal}.`
          : `codex login exited with code ${exitCode}.`;
      this.transition('failure');
    }

    if (a.urlReject) {
      a.urlReject(new Error(a.reason ?? 'codex login failed before any URL was emitted.'));
      a.urlReject = null;
      a.urlResolve = null;
    }
    this.cleanup(a);
  }

  private transition(next: CodexLoginStatus): void {
    const a = this.active;
    if (!a) return;
    a.status = next;
    this.emit('update', this.snapshot());
  }

  private cleanup(a: ActiveAttempt): void {
    if (this.active !== a) return;
    if (a.urlTimer) {
      clearTimeout(a.urlTimer);
      a.urlTimer = null;
    }
    this.active = null;
  }

  private snapshot(): CodexLoginSnapshot {
    const a = this.active!;
    return {
      loginId: a.loginId,
      status: a.status,
      url: a.url,
      reason: a.reason ?? undefined,
      startedAt: a.startedAt,
    };
  }
}

let singleton: CodexLoginOrchestrator | null = null;

export function getCodexLoginOrchestrator(): CodexLoginOrchestrator {
  if (!singleton) singleton = new CodexLoginOrchestrator();
  return singleton;
}
