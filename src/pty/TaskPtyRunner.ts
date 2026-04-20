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
  /** Extra directories to expose via `--add-dir` (e.g. `.claude/` when cwd is external). */
  addDirs?: string[];
  /**
   * Interactive resume: spawn `claude --resume <session>` and hand the TUI
   * straight to the user. No positional prompt, no auto-injection via stdin
   * once the TUI renders. Only meaningful together with `resume: true`.
   */
  interactive?: boolean;
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
      args.push('--max-turns', String(options.maxTurns ?? 10));
    } else {
      args.push('--session-id', toUuidFormat(options.sessionId || options.runId));
      args.push('--agent', options.agentName);
      args.push('--max-turns', String(options.maxTurns ?? 10));
    }

    args.push('--verbose');
    args.push('--dangerously-skip-permissions');
    args.push('--permission-mode', 'bypassPermissions');

    for (const dir of options.addDirs ?? []) {
      args.push('--add-dir', dir);
    }

    if (options.appendSystemPrompt && !options.resume) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }
    args.push('--model', options.model || 'sonnet');

    // Prompt is a POSITIONAL argument (must be last) — this gives the full
    // interactive TUI. Using `-p` would put Claude Code in print mode instead.
    // On --resume, Claude Code pastes the positional prompt into the input box
    // but does NOT submit it, so the TUI sits idle. We instead inject the
    // prompt via stdin + Enter once the TUI is ready (see onData below).
    if (!options.resume) {
      args.push(options.prompt);
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    env.FORCE_COLOR = '3';
    // node-pty chdirs to `cwd` but doesn't update PWD — the child inherits
    // the stale PWD from Electron's launch dir, so $PWD in the system prompt
    // would resolve to HOME and Claude Code writes PLAN.md outside the workspace.
    env.PWD = options.cwd;

    const wrapped = wrapClaudeSpawn({ claudeBinary: info.path, claudeArgs: args });

    console.log(
      `[TaskPtyRunner] spawn ${options.resume ? 'RESUME' : 'fresh'} session=${toUuidFormat(options.sessionId || options.runId)}`,
    );

    // Default 120 cols matches the fixed cols the ExpertConsole uses for its
    // xterm viewport. Keeping them identical is critical: Claude Code redraws
    // frames via cursor-up (`\x1b[nA`) counting *logical* rows, so if xterm
    // has fewer cols than the content the PTY wrote, lines wrap, the visible
    // rows exceed what cursor-up targets, and old frames pile up in scrollback
    // (the "stacked frames" artifact). Any change here must be mirrored in
    // PTY_COLS inside ExpertConsole.tsx.
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

    // On --resume, Claude Code loads the TUI with the prior session but does
    // NOT auto-submit the positional prompt. For driven resumes we wait for
    // the TUI to render its input box, then paste the prompt + Enter via
    // stdin. For INTERACTIVE resumes (user clicked "Resume" on a paused
    // console), we skip all injection — the user is expected to type their
    // own next message. Seeding both flags as "already injected/scheduled"
    // disables the detection branch below.
    const wantsInjection = !!options.resume && !options.interactive;
    let resumePromptInjected = !wantsInjection;
    let resumeInjectScheduled = !wantsInjection;
    let resumeStripped = '';

    const injectResumePrompt = () => {
      if (resumePromptInjected || !this.ptyProcess) return;
      resumePromptInjected = true;
      resumeStripped = '';
      console.log('[TaskPtyRunner] injecting resume prompt via bracketed paste');
      try {
        const BRACKETED_PASTE_START = '\x1b[200~';
        const BRACKETED_PASTE_END = '\x1b[201~';
        this.ptyProcess.write(BRACKETED_PASTE_START + options.prompt + BRACKETED_PASTE_END);
        setTimeout(() => {
          try { this.ptyProcess?.write('\r'); } catch { /* noop */ }
        }, 300);
      } catch { /* noop */ }
    };

    // Safety net: if the TUI never shows the `> ` prompt indicator we detect
    // (e.g., Claude Code re-renders it differently), force-inject after 8s
    // so the run doesn't sit forever at an unseen ready state. Interactive
    // resumes skip the timer since there's no prompt to inject.
    const resumeFallbackTimer = wantsInjection
      ? setTimeout(() => {
          if (!resumePromptInjected) {
            console.log('[TaskPtyRunner] resume fallback timer fired — injecting anyway');
            injectResumePrompt();
          }
        }, 8000)
      : null;

    this.ptyProcess.onData((data: string) => {
      if (!trustHandled) {
        strippedAccum += stripAnsiAggressive(data);
        if (/trust\s+this\s+folder/i.test(strippedAccum) || /Yes,\s*I\s*trust/i.test(strippedAccum)) {
          trustHandled = true;
          strippedAccum = '';
          setTimeout(() => { this.ptyProcess?.write('\r'); }, 300);
        }
      }

      if (!resumePromptInjected && !resumeInjectScheduled) {
        resumeStripped += stripAnsiAggressive(data);
        // Cap the buffer — the indicator match only needs the tail and the
        // stream can spew megabytes of history replay before the prompt shows.
        if (resumeStripped.length > 4096) {
          resumeStripped = resumeStripped.slice(-4096);
        }
        // Look for the input prompt indicator (`> ` at start of a line) that
        // appears once the TUI is fully loaded and ready to accept input.
        if (/(?:^|\n)\s*>\s/.test(resumeStripped)) {
          resumeInjectScheduled = true;
          // Wait a beat for the input box to settle, then inject.
          setTimeout(injectResumePrompt, 1000);
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
      if (resumeFallbackTimer) clearTimeout(resumeFallbackTimer);
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
