/**
 * One-shot Claude Code invocation helper.
 *
 * Spawns `claude -p <prompt> --agent <name> --output-format text` as a
 * subprocess, waits for it to exit, and returns the trimmed stdout.
 *
 * Used by routine engine LLM steps (model_call, extract, summarize,
 * classify) which need a synchronous string result rather than a
 * streaming event flow. The chat path uses ClaudeCodeRunner instead.
 *
 * The subprocess is launched with `cwd: <cerebro-data-dir>` so Claude
 * Code auto-discovers Cerebro's project-scoped subagents and skills
 * under `<cerebro-data-dir>/.claude/`.
 */

import { spawn } from 'node:child_process';
import { getCachedClaudeCodeInfo } from './detector';

// ── Module-level config ──────────────────────────────────────────
//
// The Electron main process calls `setClaudeCodeCwd(dataDir)` once
// at startup so deeply-nested routine action callers don't have to
// thread the data dir through their context.

let defaultCwd: string | null = null;

export function setClaudeCodeCwd(cwd: string): void {
  defaultCwd = cwd;
}

export function getClaudeCodeCwd(): string | null {
  return defaultCwd;
}

// ── singleShotClaudeCode ─────────────────────────────────────────

export interface SingleShotOptions {
  /** Subagent name (e.g. "cerebro" or "fitness-coach-ab12cd"). */
  agent: string;
  /** Prompt text passed to `claude -p`. */
  prompt: string;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  /** Max conversation turns Claude Code may take. Defaults to 5. */
  maxTurns?: number;
  /** Override the default cwd (otherwise uses `setClaudeCodeCwd` value). */
  cwd?: string;
}

export class ClaudeCodeUnavailableError extends Error {
  constructor() {
    super('Claude Code CLI is not available — cannot run single-shot inference');
    this.name = 'ClaudeCodeUnavailableError';
  }
}

/**
 * Spawn `claude -p <prompt> --agent <name>` and return the trimmed stdout.
 *
 * Throws `ClaudeCodeUnavailableError` if the binary hasn't been detected.
 * Throws on non-zero exit, abort, or stderr-only failures.
 */
export function singleShotClaudeCode(options: SingleShotOptions): Promise<string> {
  const info = getCachedClaudeCodeInfo();
  if (info.status !== 'available' || !info.path) {
    return Promise.reject(new ClaudeCodeUnavailableError());
  }

  const cwd = options.cwd ?? defaultCwd;
  if (!cwd) {
    return Promise.reject(
      new Error(
        'singleShotClaudeCode: cwd not set. Call setClaudeCodeCwd(dataDir) at startup.',
      ),
    );
  }

  const args: string[] = [
    '-p', options.prompt,
    '--agent', options.agent,
    '--output-format', 'text',
    '--max-turns', String(options.maxTurns ?? 5),
  ];

  // Strip CLAUDECODE so the child doesn't think it's running inside another
  // Claude Code session (which would cause it to bail out).
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;

  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const child = spawn(info.path!, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });

    let stdout = '';
    let stderr = '';
    let aborted = false;

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const onAbort = () => {
      aborted = true;
      if (!child.killed) {
        child.kill('SIGTERM');
        // Force-kill after a short grace period.
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      }
      reject(new Error('Aborted'));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (aborted) return;
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on('close', (code) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (aborted) return;

      if (code !== 0 && code !== null) {
        const tail = stderr.trim().slice(-500);
        reject(
          new Error(
            `Claude Code exited with code ${code}${tail ? `: ${tail}` : ''}`,
          ),
        );
        return;
      }

      resolve(stdout.trim());
    });
  });
}
