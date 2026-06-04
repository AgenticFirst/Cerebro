/**
 * CodexRunner — spawns `codex exec --json` as a subprocess and translates its
 * JSONL output into RendererAgentEvents, the same event union ClaudeCodeRunner
 * emits. The prompt is piped on stdin (codex reads the instruction from stdin,
 * not a positional arg).
 *
 * Arg construction follows obelisk's proven `buildCodexExecArgs`:
 *   codex exec [resume <thread>] --json --skip-git-repo-check
 *     --sandbox workspace-write --cd <cwd>
 *     [--model <id>] -c model_reasoning_effort="<effort>"
 *
 * `--skip-git-repo-check` is mandatory: cwd is Cerebro's data dir, not a git
 * repo, so without it codex exits before reading the prompt. `--sandbox
 * workspace-write` is the non-interactive write bypass (no `--ask-for-approval
 * never`/`--yolo` needed). `--model` is omitted when unset so ChatGPT-account
 * sign-ins (which reject explicit models) keep working.
 *
 * Codex mints its own session id (in `thread.started`); the runner captures it
 * via `getThreadId()` so the runtime can persist it for `codex exec resume`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { RendererAgentEvent } from '../../agents/types';
import type { EngineRunOptions, RunnerErrorClass, StreamingRunner } from '../types';
import { getCachedCodexInfo } from './detector';
import { probeCodexAuth } from './auth-probe';
import { CodexEventParser } from './event-parser';
import { resolveBackendPythonBinDir, resolveBackendVirtualEnvRoot } from '../../python/venv';

const IDLE_WARNING_THRESHOLDS_MS = [45_000, 120_000, 300_000] as const;
const IDLE_NO_TOOL_KILL_MS = 90_000;
const IDLE_TOOL_KILL_MS = 1_800_000;
const AUTH_STDERR_PATTERNS = [
  'not logged in',
  'not authenticated',
  'unauthorized',
  '401',
  'run codex login',
  'please login',
] as const;

export class CodexRunner extends EventEmitter implements StreamingRunner {
  private process: ChildProcess | null = null;
  private parser = new CodexEventParser();
  private stderrTail = '';
  private stdoutTail = '';
  private logStream: fs.WriteStream | null = null;
  private logPath = '';
  private killed = false;
  private closeHandled = false;
  private idleStartedAt = 0;
  private idleWarningTimers: ReturnType<typeof setTimeout>[] = [];
  private idleKillTimer: ReturnType<typeof setTimeout> | null = null;
  private openToolCount = 0;
  private lastErrorClass: RunnerErrorClass = 'unknown';
  private sawAnyOutput = false;
  private modelUsed = '';

  getLastErrorClass(): RunnerErrorClass {
    return this.lastErrorClass;
  }

  getAccumulatedText(): string {
    return this.parser.getAccumulatedText();
  }

  /** Codex's own session/thread id, captured from `thread.started`. */
  getThreadId(): string | null {
    return this.parser.getThreadId();
  }

  /** StreamingRunner contract — alias of getThreadId for the runtime. */
  getSessionId(): string | null {
    return this.parser.getThreadId();
  }

  start(options: EngineRunOptions): void {
    void this.startAsync(options);
  }

  private async startAsync(options: EngineRunOptions): Promise<void> {
    const { runId, prompt, cwd } = options;
    this.lastErrorClass = 'unknown';

    const info = getCachedCodexInfo();
    if (info.status !== 'available' || !info.path) {
      this.fail(runId, 'Codex CLI is not available', 'spawn');
      return;
    }

    const probe = await probeCodexAuth();
    if (!probe.ok) {
      this.fail(runId, 'Cerebro lost its Codex session.', 'auth');
      return;
    }

    const args: string[] = ['exec'];
    if (options.resume && options.sessionId) {
      args.push('resume', options.sessionId);
    }
    args.push('--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', cwd);
    if (options.model) {
      args.push('--model', options.model);
      this.modelUsed = options.model;
    }
    const effort = options.reasoningEffort ?? 'medium';
    args.push('-c', `model_reasoning_effort="${effort}"`);

    // Env: inherit, make the bundled backend Python visible (so codex's Bash
    // tool can `import docx` etc.), and point the chat-action scripts at the
    // runtime file (both engines share <dataDir>/.claude/scripts + runtime.json).
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    // The reused Cerebro/expert prompt bodies + skill scripts reference
    // `$CLAUDE_PROJECT_DIR/.claude/...`; the scripts read
    // `${CLAUDE_PROJECT_DIR:-.}/.claude/cerebro-runtime.json` for the backend +
    // chat-actions ports. Codex doesn't set this var itself, so we do — making
    // chat-actions / approvals work identically under both engines.
    env.CLAUDE_PROJECT_DIR = cwd;
    const pyBin = resolveBackendPythonBinDir();
    if (pyBin) {
      env.PATH = `${pyBin}${path.delimiter}${env.PATH ?? ''}`;
      const venvRoot = resolveBackendVirtualEnvRoot();
      if (venvRoot) env.VIRTUAL_ENV = venvRoot;
      delete env.PYTHONHOME;
    }
    if (options.extraEnv) {
      for (const [k, v] of Object.entries(options.extraEnv)) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    // Do NOT wrap Codex in Cerebro's macOS `sandbox-exec` profile (that profile
    // is tuned for Claude Code and blocks Codex from spawning its own command
    // sandbox and from writing its session rollout under ~/.codex — breaking
    // tool calls and resume). Codex confines itself via `--sandbox
    // workspace-write`, so we spawn the binary directly. Mirrors obelisk.
    this.process = spawn(info.path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
    });

    this.openRunLog(runId, info.path, args);

    // Pipe the prompt on stdin, then close it so codex starts processing.
    try {
      this.process.stdin?.write(prompt);
      this.process.stdin?.end();
    } catch {
      // stdin EPIPE if the process died instantly — the close handler reports it.
    }

    this.idleStartedAt = Date.now();
    this.armIdleTimers(runId);

    let buffer = '';
    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.resetIdleTimers(runId);
      this.sawAnyOutput = true;
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.handleLine(line, runId);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.resetIdleTimers(runId);
      const text = data.toString();
      this.appendLog('stderr', text);
      this.stderrTail = (this.stderrTail + '\n' + text).slice(-500).trim();
      this.checkAuthFailure(text, runId);
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line)
          this.emit('event', { type: 'subprocess_stderr', runId, line } as RendererAgentEvent);
      }
    });

    this.process.on('close', (code, signal) => {
      if (this.closeHandled) return;
      this.closeHandled = true;
      this.clearIdleTimers();
      if (buffer.trim()) this.handleLine(buffer.trim(), runId);
      if (this.killed) return;

      const failure = this.parser.getFailure();
      const realSignal = signal && String(signal) !== '0' ? signal : null;
      const isError = (code !== 0 && code !== null) || realSignal != null || failure != null;

      if (isError) {
        let detail: string;
        if (failure) {
          this.lastErrorClass = failure.errorClass;
          detail = canonicalMessage(failure.errorClass, failure.message);
        } else {
          const tailLower = (this.stderrTail + ' ' + this.stdoutTail).toLowerCase();
          if (AUTH_STDERR_PATTERNS.some((p) => tailLower.includes(p))) {
            this.lastErrorClass = 'auth';
            detail = 'Cerebro lost its Codex session.';
          } else if (this.stderrTail) {
            this.lastErrorClass = 'unknown';
            detail = `Codex error (code ${code}): ${this.stderrTail}`;
          } else if (this.stdoutTail) {
            this.lastErrorClass = 'unknown';
            detail = `Codex error (code ${code}): ${this.stdoutTail}`;
          } else {
            this.lastErrorClass = signal ? 'unknown' : 'unknown';
            detail = `Codex exited unexpectedly (code ${code}${signal ? `, signal ${signal}` : ''})`;
            if (this.logPath) detail += `\n\n(Details: ${this.logPath})`;
          }
        }
        this.closeRunLog(`[exit] code=${code} signal=${signal ?? ''} class=${this.lastErrorClass}`);
        this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
        this.emit('error', detail);
      } else {
        this.lastErrorClass = 'none';
        this.closeRunLog(`[exit] code=${code} signal=${signal ?? ''} ok`);
        this.emit('event', {
          type: 'done',
          runId,
          messageContent: this.parser.getAccumulatedText(),
        } as RendererAgentEvent);
        this.emit('done', this.parser.getAccumulatedText());
      }
    });

    this.process.on('error', (err) => {
      if (this.killed) return;
      let detail = err.message;
      if (this.logPath) detail += `\n\n(Details: ${this.logPath})`;
      this.lastErrorClass = 'spawn';
      this.closeRunLog(`[spawn-error] ${err.message}`);
      this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
      this.emit('error', detail);
    });
  }

  abort(): void {
    this.killed = true;
    this.lastErrorClass = 'cancelled';
    this.clearIdleTimers();
    this.closeRunLog('[abort] user cancelled');
    if (!this.process || this.process.killed) return;
    this.process.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (this.process && !this.process.killed) this.process.kill('SIGKILL');
    }, 3000);
    this.process.once('exit', () => clearTimeout(forceTimer));
  }

  private handleLine(line: string, runId: string): void {
    const { events } = this.parser.feedLine(line);
    if (events.length === 0) {
      // Non-event line already logged by parser as system; keep a stdout tail
      // for the close-handler fallback.
      this.stdoutTail = (this.stdoutTail + '\n' + line).slice(-500).trim();
    }
    for (const ev of events) {
      if (ev.type === 'tool_start') {
        this.openToolCount += 1;
        this.armIdleTimers(runId);
      } else if (ev.type === 'tool_end') {
        if (this.openToolCount > 0) this.openToolCount -= 1;
        this.armIdleTimers(runId);
      }
      this.emit('event', ev);
    }
  }

  private fail(runId: string, message: string, cls: RunnerErrorClass): void {
    this.lastErrorClass = cls;
    this.emit('event', { type: 'error', runId, error: message } as RendererAgentEvent);
    this.emit('error', message);
  }

  private checkAuthFailure(text: string, runId: string): void {
    const lower = text.toLowerCase();
    if (!AUTH_STDERR_PATTERNS.some((p) => lower.includes(p))) return;
    if (this.killed || this.closeHandled) return;
    this.killed = true;
    this.clearIdleTimers();
    this.lastErrorClass = 'auth';
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) this.process.kill('SIGKILL');
      }, 1000);
    }
    const detail = 'Cerebro lost its Codex session.';
    this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
    this.emit('error', detail);
  }

  // ── idle watchdog (mirrors ClaudeCodeRunner) ───────────────────

  private armIdleTimers(runId: string): void {
    this.clearIdleTimers();
    this.idleStartedAt = Date.now();
    const hasOpenTool = this.openToolCount > 0;
    const killMs = hasOpenTool ? IDLE_TOOL_KILL_MS : IDLE_NO_TOOL_KILL_MS;
    for (const threshold of IDLE_WARNING_THRESHOLDS_MS) {
      if (threshold >= killMs) continue;
      const t = setTimeout(() => {
        if (this.killed || this.closeHandled) return;
        this.emit('event', {
          type: 'agent_idle_warning',
          runId,
          elapsedMs: Date.now() - this.idleStartedAt,
        } as RendererAgentEvent);
      }, threshold);
      this.idleWarningTimers.push(t);
    }
    this.idleKillTimer = setTimeout(() => {
      if (this.killed || this.closeHandled) return;
      this.killed = true;
      this.clearIdleTimers();
      let detail: string;
      if (hasOpenTool) {
        const minutes = Math.round(IDLE_TOOL_KILL_MS / 60_000);
        detail = `Codex subprocess was idle for ${minutes} minutes and was killed.`;
        this.lastErrorClass = 'unknown';
      } else if (!this.sawAnyOutput) {
        detail = 'Cerebro lost its Codex session.';
        this.lastErrorClass = 'auth';
      } else {
        const seconds = Math.round(IDLE_NO_TOOL_KILL_MS / 1000);
        detail = `Codex produced no output for ${seconds} seconds and was killed.`;
        this.lastErrorClass = 'idle_hang';
      }
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.process && !this.process.killed) this.process.kill('SIGKILL');
        }, 5000);
      }
      this.emit('event', { type: 'error', runId, error: detail } as RendererAgentEvent);
      this.emit('error', detail);
    }, killMs);
  }

  private resetIdleTimers(runId: string): void {
    if (this.killed || this.closeHandled) return;
    this.armIdleTimers(runId);
  }

  private clearIdleTimers(): void {
    for (const t of this.idleWarningTimers) clearTimeout(t);
    this.idleWarningTimers = [];
    if (this.idleKillTimer) {
      clearTimeout(this.idleKillTimer);
      this.idleKillTimer = null;
    }
  }

  // ── per-run logging (mirrors ClaudeCodeRunner) ─────────────────

  private openRunLog(runId: string, binary: string, args: readonly string[]): void {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs', 'codex');
      fs.mkdirSync(logDir, { recursive: true });
      this.logPath = path.join(logDir, `${runId}.log`);
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'w' });
      this.logStream.write(`[${new Date().toISOString()}] [start] ${binary} ${args.join(' ')}\n`);
      this.pruneOldLogs(logDir);
    } catch {
      this.logStream = null;
      this.logPath = '';
    }
  }

  private appendLog(channel: 'stdout' | 'stderr', text: string): void {
    if (!this.logStream) return;
    try {
      this.logStream.write(`[${channel}] ${text.endsWith('\n') ? text : text + '\n'}`);
    } catch {
      this.logStream = null;
    }
  }

  private closeRunLog(footer: string): void {
    if (!this.logStream) return;
    try {
      this.logStream.write(`[${new Date().toISOString()}] ${footer}\n`);
      this.logStream.end();
    } catch {
      /* swallow */
    }
    this.logStream = null;
  }

  private pruneOldLogs(logDir: string): void {
    try {
      const entries = fs
        .readdirSync(logDir)
        .filter((n) => n.endsWith('.log'))
        .map((n) => {
          const full = path.join(logDir, n);
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            /* ignore */
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const stale of entries.slice(50)) {
        try {
          fs.unlinkSync(stale.full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

function canonicalMessage(cls: RunnerErrorClass, raw: string): string {
  switch (cls) {
    case 'auth':
      return 'Cerebro lost its Codex session.';
    case 'overload':
      return 'Rate limited or overloaded. Please wait a moment and try again.';
    case 'context':
      return 'Codex ran out of context window. The conversation is too long for this model.';
    case 'max_turns':
      return 'Codex reached its turn limit without completing the task. Try a simpler request.';
    case 'session_missing':
      return 'Codex session not found — restoring from conversation history.';
    default:
      return `Codex error: ${raw}`;
  }
}
