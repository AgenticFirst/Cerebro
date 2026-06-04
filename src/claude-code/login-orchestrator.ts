/**
 * Drives the Claude Code login flow from inside Cerebro so users never
 * have to open a terminal — fixing the broken "run `claude` in a terminal
 * to sign in" message that used to leak into Slack threads.
 *
 * Two modes:
 *
 *   - **oauth** (`claude /login` via REPL): one-click flow for the desktop
 *     case. The CLI either opens the user's browser (localhost callback,
 *     no paste-back) or prints a copyable URL on a headless box. We
 *     capture the URL when present, and watch the subprocess for clean
 *     exit + a re-probe to confirm.
 *
 *   - **setup-token** (`claude setup-token`): paste-back flow for
 *     Slack/Telegram operators on a remote host. The CLI prints a URL,
 *     the user authenticates in their own browser, copies a code, and
 *     pastes it back. We feed `code\n` into the PTY stdin once the
 *     operator replies.
 *
 * Single-flight: the singleton refuses concurrent `start()` calls — the
 * previous attempt must finish or be cancelled first. This matches how
 * the underlying CLI behaves (one auth attempt at a time).
 *
 * The class is event-emitting; the main process re-broadcasts those
 * events over IPC to the renderer card and the Slack/Telegram bridges.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { getCachedClaudeCodeInfo } from './detector';
import { probeClaudeAuth, clearProbeCache } from './auth-probe';
import { stripAnsiFull } from '../utils/ansi';

export type LoginMode = 'oauth' | 'setup-token';

export type LoginStatus =
  | 'starting' // PTY spawned, no URL captured yet
  | 'awaiting-user' // URL emitted; for oauth, waiting on browser/exit; for setup-token, waiting on submitCode()
  | 'submitting-code' // paste-back code written, waiting for CLI to verify
  | 'success'
  | 'failure'
  | 'cancelled';

export interface LoginSnapshot {
  loginId: string;
  mode: LoginMode;
  status: LoginStatus;
  url: string | null;
  /** True when the orchestrator needs a code from the user (setup-token mode). */
  requiresCode: boolean;
  /** Diagnostic message when status is `failure` (or `success` for a soft warning). */
  reason?: string;
  /** Wall-clock ms when this attempt began. */
  startedAt: number;
}

interface ActiveAttempt {
  loginId: string;
  mode: LoginMode;
  proc: pty.IPty;
  startedAt: number;
  status: LoginStatus;
  url: string | null;
  reason: string | null;
  /** Concatenated stripped-ANSI stdout, capped to the last 4 KB for URL scanning. */
  scratch: string;
  /** Resolves once `start()` either captures a URL or completes the whole flow. */
  urlResolve: ((snapshot: LoginSnapshot) => void) | null;
  urlReject: ((err: Error) => void) | null;
  /** Resolves once the CLI exits (success or failure). */
  exitResolve: ((snapshot: LoginSnapshot) => void) | null;
  urlTimer: NodeJS.Timeout | null;
}

const URL_TIMEOUT_MS = 20_000;
const POST_SUBMIT_TIMEOUT_MS = 30_000;
// Match the first claude.ai or console.anthropic.com URL the CLI prints.
// Tolerates trailing whitespace / ANSI hyperlink terminators.
const URL_RE =
  /https?:\/\/(?:claude\.ai|console\.anthropic\.com|auth\.anthropic\.com)\/[^\s\x07\x1b]+/i;

export class ClaudeCodeLoginOrchestrator extends EventEmitter {
  private active: ActiveAttempt | null = null;

  /**
   * Spawn the chosen login subprocess and resolve once we either have a
   * URL to show the user (most cases) or know the login completed without
   * one (e.g. the CLI opened the browser and the localhost callback fired
   * before any URL was printed). Rejects if the spawn fails or no URL /
   * completion signal arrives within the URL_TIMEOUT_MS window.
   */
  start(mode: LoginMode): Promise<LoginSnapshot> {
    if (this.active) {
      return Promise.reject(
        new Error('A Claude Code login attempt is already in progress. Cancel it first.'),
      );
    }
    const info = getCachedClaudeCodeInfo();
    if (info.status !== 'available' || !info.path) {
      return Promise.reject(new Error('Claude Code binary not found.'));
    }

    const loginId = crypto.randomUUID();
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    env.FORCE_COLOR = '0';
    // Disable any browser-opening helper — we want the URL on stdout so we
    // can surface it. The CLI still works without a browser; on machines
    // where the OS can open one, the user clicks the link we render.
    env.BROWSER = 'true';

    const args = mode === 'setup-token' ? ['setup-token'] : ['/login'];

    let proc: pty.IPty;
    try {
      proc = pty.spawn(info.path, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env,
      });
    } catch (err) {
      return Promise.reject(
        new Error(`Failed to spawn login subprocess: ${(err as Error).message}`),
      );
    }

    const attempt: ActiveAttempt = {
      loginId,
      mode,
      proc,
      startedAt: Date.now(),
      status: 'starting',
      url: null,
      reason: null,
      scratch: '',
      urlResolve: null,
      urlReject: null,
      exitResolve: null,
      urlTimer: null,
    };
    this.active = attempt;

    const snapshotPromise = new Promise<LoginSnapshot>((resolve, reject) => {
      attempt.urlResolve = resolve;
      attempt.urlReject = reject;
    });

    attempt.urlTimer = setTimeout(() => {
      if (!this.active || this.active.loginId !== loginId) return;
      if (this.active.status !== 'starting') return;
      // No URL after 20s. Two real possibilities:
      //   1. The CLI opened the user's browser (no printed URL), and we
      //      should keep waiting for it to exit.
      //   2. The CLI is wedged.
      // Move to 'awaiting-user' optimistically — the exit handler will
      // settle either way. Resolve the start() promise with a null URL so
      // callers can render "Waiting for browser…".
      this.transition('awaiting-user');
      attempt.urlResolve?.(this.snapshot());
      attempt.urlResolve = null;
      attempt.urlReject = null;
    }, URL_TIMEOUT_MS);

    proc.onData((data: string) => this.handleData(data));
    proc.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal));

    return snapshotPromise;
  }

  /**
   * Feed the paste-back code into the PTY for setup-token mode. No-op for
   * oauth mode (which has no code to paste). Resolves once the CLI exits.
   */
  submitCode(loginId: string, code: string): Promise<LoginSnapshot> {
    const a = this.active;
    if (!a || a.loginId !== loginId) {
      return Promise.reject(new Error('No matching login attempt is active.'));
    }
    if (a.mode !== 'setup-token') {
      return Promise.reject(new Error('submitCode is only valid for setup-token mode.'));
    }
    if (a.status !== 'awaiting-user') {
      return Promise.reject(new Error(`Cannot submit code while status is '${a.status}'.`));
    }
    const trimmed = code.trim();
    if (!trimmed) {
      return Promise.reject(new Error('Empty code.'));
    }

    this.transition('submitting-code');
    try {
      a.proc.write(`${trimmed}\r`);
    } catch (err) {
      a.reason = `Failed to write code: ${(err as Error).message}`;
      this.transition('failure');
      this.cleanup(a);
      return Promise.resolve(this.snapshot());
    }

    return new Promise<LoginSnapshot>((resolve) => {
      a.exitResolve = resolve;
      // Hard timeout in case the CLI never settles after the paste.
      setTimeout(() => {
        if (!this.active || this.active.loginId !== a.loginId) return;
        if (a.status === 'success' || a.status === 'failure') return;
        a.reason = 'CLI did not respond after code submission.';
        try {
          a.proc.kill();
        } catch {
          /* noop */
        }
      }, POST_SUBMIT_TIMEOUT_MS);
    });
  }

  /** Tear down any in-flight attempt. Safe to call when nothing is active. */
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

  /** Current attempt, or null when idle. */
  current(): LoginSnapshot | null {
    return this.active ? this.snapshot() : null;
  }

  // ── Internals ─────────────────────────────────────────────────

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
      // Already settled — just clean up.
      this.cleanup(a);
      return;
    }

    if (exitCode === 0) {
      // Bust the cached probe so the next chat turn sees the fresh creds.
      clearProbeCache();
      const probe = await probeClaudeAuth({ force: true });
      if (probe.ok) {
        this.transition('success');
      } else {
        a.reason = probe.reason ?? 'Login subprocess exited cleanly but auth probe still fails.';
        this.transition('failure');
      }
    } else {
      a.reason =
        signal != null
          ? `Login subprocess killed by signal ${signal}.`
          : `Login subprocess exited with code ${exitCode}.`;
      this.transition('failure');
    }

    const snap = this.snapshot();
    if (a.urlReject) {
      // We never even got to emit a URL. Surface as a rejection so the
      // caller can show an immediate error in the card.
      a.urlReject(new Error(a.reason ?? 'Login failed before any URL was emitted.'));
      a.urlReject = null;
      a.urlResolve = null;
    }
    a.exitResolve?.(snap);
    a.exitResolve = null;
    this.cleanup(a);
  }

  private transition(next: LoginStatus): void {
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

  private snapshot(): LoginSnapshot {
    const a = this.active!;
    return {
      loginId: a.loginId,
      mode: a.mode,
      status: a.status,
      url: a.url,
      requiresCode: a.mode === 'setup-token',
      reason: a.reason ?? undefined,
      startedAt: a.startedAt,
    };
  }
}

let singleton: ClaudeCodeLoginOrchestrator | null = null;

export function getLoginOrchestrator(): ClaudeCodeLoginOrchestrator {
  if (!singleton) singleton = new ClaudeCodeLoginOrchestrator();
  return singleton;
}
