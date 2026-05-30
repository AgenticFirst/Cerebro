/**
 * One-shot Codex invocation — the Codex analog of `singleShotClaudeCode`.
 *
 * Runs `codex exec` (no `--json`: codex prints progress to stderr and only the
 * final agent message to stdout) with the prompt piped on stdin, and returns
 * the trimmed stdout. Used by routine-engine steps that need a synchronous
 * string result. Read-only sandbox by default (these steps reason/extract;
 * they don't edit the workspace).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getCachedCodexInfo } from './detector';
import { probeCodexAuth } from './auth-probe';
import { getCodexCwd } from './config';
import type { SingleShotEngineOptions } from '../types';

let singleShotSeq = 0;

/** Best-effort one-line run log under <dataDir>/logs/codex, mirroring the
 *  streaming runner's per-run log. Gives routine/title inference a debuggable
 *  artifact (and lets e2e attribute a routine step to the codex subprocess). */
function writeSingleShotLog(cwd: string, line: string): void {
  try {
    const dir = path.join(cwd, 'logs', 'codex');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `singleshot-${Date.now()}-${singleShotSeq++}.log`);
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // disk issue — never break inference over a log write
  }
}

export class CodexUnavailableError extends Error {
  constructor() {
    super('Codex CLI is not available — cannot run single-shot inference');
    this.name = 'CodexUnavailableError';
  }
}

export class CodexNotSignedInError extends Error {
  constructor(reason?: string) {
    super(reason ? `Cerebro lost its Codex session: ${reason}` : 'Cerebro lost its Codex session.');
    this.name = 'CodexNotSignedInError';
  }
}

export async function singleShotCodex(options: SingleShotEngineOptions): Promise<string> {
  const info = getCachedCodexInfo();
  if (info.status !== 'available' || !info.path) {
    throw new CodexUnavailableError();
  }

  const cwd = options.cwd ?? getCodexCwd();
  if (!cwd) {
    throw new Error('singleShotCodex: cwd not set. Call setCodexCwd(dataDir) at startup.');
  }

  const probe = await probeCodexAuth();
  if (!probe.ok) {
    throw new CodexNotSignedInError(probe.reason);
  }

  const args: string[] = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd];
  if (options.model) args.push('--model', options.model);
  const effort = options.reasoningEffort ?? 'low';
  args.push('-c', `model_reasoning_effort="${effort}"`);

  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;

  return await new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    // Spawn codex directly — it confines itself via `--sandbox`; wrapping it in
    // Cerebro's Claude-tuned sandbox-exec profile blocks its command sandbox and
    // ~/.codex writes (see CodexRunner for the full rationale).
    const child = spawn(info.path!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
    });
    writeSingleShotLog(cwd, `[start] codex ${args.join(' ')}`);

    let stdout = '';
    let stderr = '';
    let aborted = false;

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

    const onAbort = () => {
      aborted = true;
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
      }
      reject(new Error('Aborted'));
    };
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child.stdin?.write(options.prompt);
      child.stdin?.end();
    } catch {
      // EPIPE if codex died instantly — the close handler reports it.
    }

    child.on('error', (err) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (aborted) return;
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });

    child.on('close', (code) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      if (aborted) return;
      if (code !== 0 && code !== null) {
        const tail = stderr.trim().slice(-500) || stdout.trim().slice(-500) || '(no output)';
        reject(new Error(`Codex exited with code ${code}: ${tail}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
