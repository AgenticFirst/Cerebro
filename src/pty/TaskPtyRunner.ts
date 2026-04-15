/**
 * TaskPtyRunner — spawns Claude Code via node-pty for task runs.
 *
 * Produces REAL terminal output (with colors, tool boxes, spinners)
 * that pipes directly to xterm.js in the renderer. Also accumulates
 * raw text (ANSI-stripped) for structural tag parsing by the stream
 * parser (<plan>, <phase>, <deliverable>, etc.).
 */

import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import { getCachedClaudeCodeInfo } from '../claude-code/detector';
import { wrapClaudeSpawn } from '../sandbox/wrap-spawn';

const PTY_BUFFER_INTERVAL_MS = 16; // ~60fps
const MAX_ACCUMULATED_TEXT = 512 * 1024; // cap ANSI-stripped text in memory

/**
 * Format a 32-char hex ID (as produced by Python's `uuid.uuid4().hex`) into
 * the dashed UUID form that Claude Code's `--session-id` / `--resume` flags
 * require. Leaves already-dashed UUIDs untouched.
 */
function toUuidFormat(id: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return id;
  }
  if (/^[0-9a-f]{32}$/i.test(id)) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  }
  return id;
}

/** Strip CSI codes used for coloring/cursor. Fast path for 'text' events. */
function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
}

/** Aggressive strip including OSC, DCS, and 1-char ESC sequences for plaintext matching. */
function stripAnsiAggressive(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[a-zA-Z@]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[=>NOc78]/g, '');
}

export interface TaskPtyRunOptions {
  runId: string;
  prompt: string;
  agentName: string;
  cwd: string;
  maxTurns?: number;
  model?: string;
  appendSystemPrompt?: string;
  cols?: number;
  rows?: number;
  resume?: boolean;
  sessionId?: string;
}

/**
 * Events:
 *  - 'data'  (data: string)                    — raw PTY output for xterm
 *  - 'text'  (text: string)                    — ANSI-stripped text for tag parsing
 *  - 'exit'  (code: number, signal?: string)   — process exited (fires even on abort)
 */
export class TaskPtyRunner extends EventEmitter {
  private ptyProcess: import('node-pty').IPty | null = null;
  private killed = false;
  private buffer = '';
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private accumulatedText = '';

  start(options: TaskPtyRunOptions): void {
    const info = getCachedClaudeCodeInfo();
    if (info.status !== 'available' || !info.path) {
      this.emit('exit', 1, undefined);
      return;
    }

    const args: string[] = [];

    if (options.resume && options.sessionId) {
      args.push('--resume', toUuidFormat(options.sessionId));
    } else {
      args.push('--session-id', toUuidFormat(options.sessionId || options.runId));
      args.push('--agent', options.agentName);
      args.push('--max-turns', String(options.maxTurns ?? 10));
    }

    args.push('--verbose');
    args.push('--dangerously-skip-permissions');
    args.push('--permission-mode', 'bypassPermissions');

    if (options.appendSystemPrompt && !options.resume) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }
    args.push('--model', options.model || 'sonnet');

    // Prompt is a POSITIONAL argument (must be last) — this gives the full
    // interactive TUI. Using `-p` would put Claude Code in print mode instead.
    if (!options.resume) {
      args.push(options.prompt);
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    env.FORCE_COLOR = '3';

    const wrapped = wrapClaudeSpawn({ claudeBinary: info.path, claudeArgs: args });

    this.ptyProcess = pty.spawn(wrapped.binary, wrapped.args, {
      name: 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env,
    });

    // Auto-accept the workspace trust dialog. Interactive mode shows a prompt
    // that bypasses --dangerously-skip-permissions, so we detect it and press
    // Enter. On resume runs the prompt doesn't appear.
    let trustHandled = false;
    let strippedAccum = '';

    this.ptyProcess.onData((data: string) => {
      if (!trustHandled) {
        strippedAccum += stripAnsiAggressive(data);
        if (/trust\s+this\s+folder/i.test(strippedAccum) || /Yes,\s*I\s*trust/i.test(strippedAccum)) {
          trustHandled = true;
          strippedAccum = '';
          setTimeout(() => { this.ptyProcess?.write('\r'); }, 300);
        }
      }
      this.buffer += data;

      if (!this.flushTimer) {
        this.flushTimer = setInterval(() => this.flushBuffer(), PTY_BUFFER_INTERVAL_MS);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushBuffer();
      this.emit('exit', exitCode, signal !== undefined ? String(signal) : undefined);
    });
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer;
    this.buffer = '';
    this.emit('data', chunk);

    const clean = stripAnsi(chunk);
    if (clean) {
      this.accumulatedText += clean;
      if (this.accumulatedText.length > MAX_ACCUMULATED_TEXT) {
        this.accumulatedText = this.accumulatedText.slice(-MAX_ACCUMULATED_TEXT);
      }
      this.emit('text', clean);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      try { this.ptyProcess.resize(cols, rows); } catch { /* already dead */ }
    }
  }

  /** Write user keystrokes to the PTY's stdin. */
  write(data: string): void {
    if (this.ptyProcess) {
      try { this.ptyProcess.write(data); } catch { /* already dead */ }
    }
  }

  abort(): void {
    this.killed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.ptyProcess) {
      this.ptyProcess.kill('SIGTERM');
      const forceTimer = setTimeout(() => {
        if (this.ptyProcess) {
          try { this.ptyProcess.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 3000);
      this.ptyProcess.onExit(() => clearTimeout(forceTimer));
    }
  }

  isAborted(): boolean {
    return this.killed;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }
}
