/**
 * TaskPtyRunner — spawns Claude Code via node-pty for task runs.
 *
 * Produces REAL terminal output (with colors, tool boxes, spinners)
 * that pipes directly to xterm.js in the renderer. Also accumulates
 * raw text (ANSI-stripped) for structural tag parsing by the stream
 * parser (<plan>, <phase>, <deliverable>, etc.).
 *
 * Follows Turbo's PtyManager buffering pattern: 16ms flush interval.
 */

import { EventEmitter } from 'node:events';
import { getCachedClaudeCodeInfo } from '../claude-code/detector';
import { wrapClaudeSpawn } from '../sandbox/wrap-spawn';

const PTY_BUFFER_INTERVAL_MS = 16; // ~60fps, same as Turbo

export interface TaskPtyRunOptions {
  runId: string;
  prompt: string;
  agentName: string;
  cwd: string;
  maxTurns?: number;
  model?: string;
  appendSystemPrompt?: string;
}

/**
 * Events:
 *  - 'data'  (data: string)              — raw PTY output for xterm
 *  - 'text'  (text: string)              — ANSI-stripped text for tag parsing
 *  - 'exit'  (code: number, signal?: string) — process exited
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

    const args: string[] = [
      '-p', options.prompt,
      '--agent', options.agentName,
      '--verbose',
      '--max-turns', String(options.maxTurns ?? 60),
      '--dangerously-skip-permissions',
    ];

    if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }
    if (options.model) {
      args.push('--model', options.model);
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    // Force full color output even through PTY
    env.FORCE_COLOR = '3';

    const wrapped = wrapClaudeSpawn({ claudeBinary: info.path, claudeArgs: args });

    // Dynamic import of node-pty (native module, must be external in vite)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty') as typeof import('node-pty');

    this.ptyProcess = pty.spawn(wrapped.binary, wrapped.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: options.cwd,
      env,
    });

    // Buffer PTY output at 60fps (same as Turbo)
    this.ptyProcess.onData((data: string) => {
      this.buffer += data;

      if (!this.flushTimer) {
        this.flushTimer = setInterval(() => {
          if (this.buffer.length > 0) {
            const chunk = this.buffer;
            this.buffer = '';
            this.emit('data', chunk);

            // Strip ANSI codes and accumulate for tag parsing
            const clean = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
            if (clean) {
              this.accumulatedText += clean;
              this.emit('text', clean);
            }
          }
        }, PTY_BUFFER_INTERVAL_MS);
      }
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
      // Flush remaining buffer
      if (this.buffer.length > 0) {
        const chunk = this.buffer;
        this.buffer = '';
        this.emit('data', chunk);
        const clean = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
        if (clean) {
          this.accumulatedText += clean;
          this.emit('text', clean);
        }
      }
      if (!this.killed) {
        this.emit('exit', exitCode, signal !== undefined ? String(signal) : undefined);
      }
    });
  }

  resize(cols: number, rows: number): void {
    if (this.ptyProcess) {
      try { this.ptyProcess.resize(cols, rows); } catch { /* ignore if already dead */ }
    }
  }

  abort(): void {
    this.killed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.ptyProcess) {
      this.ptyProcess.kill();
    }
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }
}
