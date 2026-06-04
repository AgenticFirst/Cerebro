/**
 * Auth probe for the Claude Code CLI.
 *
 * The detector tells us whether the binary exists; this tells us whether
 * the on-disk credentials are valid. Silent 5-min hangs in chat runs are
 * almost always Claude Code sitting at an unanswered auth prompt. We
 * spawn a tiny `claude -p ping --max-turns 1` and watch for the first
 * stream-json line within 5 seconds — if it appears, the CLI is
 * authenticated; otherwise we surface a `reason` (stderr tail, "timed
 * out", etc.) so callers can short-circuit with the auth recovery flow.
 *
 * Result is cached in module memory for 60 s to avoid spawning a probe
 * subprocess per chat turn. `{ force: true }` busts the cache — call
 * with that after a successful login.
 */

import { spawn } from 'node:child_process';
import { getCachedClaudeCodeInfo } from './detector';
import type { ClaudeCodeProbeResult } from '../types/ipc';

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

let cache: { value: ClaudeCodeProbeResult; expiresAt: number } | null = null;
// Coalesce concurrent probes — every chat run, slash-command, and bridge
// turn hits this. Without single-flight, N parallel calls each spawn their
// own subprocess and burn N×5s on the auth-broken path.
let inflight: Promise<ClaudeCodeProbeResult> | null = null;

export function clearProbeCache(): void {
  cache = null;
}

export async function probeClaudeAuth(opts?: { force?: boolean }): Promise<ClaudeCodeProbeResult> {
  if (opts?.force) cache = null;
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  if (inflight) return inflight;

  inflight = runProbe();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function runProbe(): Promise<ClaudeCodeProbeResult> {
  const info = getCachedClaudeCodeInfo();
  if (info.status !== 'available' || !info.path) {
    const value: ClaudeCodeProbeResult = { ok: false, reason: 'Claude Code binary not found' };
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  const binary = info.path;
  const result = await new Promise<ClaudeCodeProbeResult>((resolve) => {
    const child = spawn(
      binary,
      [
        '-p',
        'ping',
        '--max-turns',
        '1',
        '--output-format',
        'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let resolved = false;
    let stderrTail = '';
    const settle = (v: ClaudeCodeProbeResult): void => {
      if (resolved) return;
      resolved = true;
      if (!child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 1000);
      }
      resolve(v);
    };
    const timer = setTimeout(
      () =>
        settle({ ok: false, reason: 'Probe timed out — Claude Code may not be authenticated.' }),
      PROBE_TIMEOUT_MS,
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        clearTimeout(timer);
        settle({ ok: true });
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-300);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      settle({ ok: false, reason: `Spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({
        ok: false,
        reason: stderrTail.trim() || `Subprocess exited (code ${code}) before producing output.`,
      });
    });
  });

  cache = { value: result, expiresAt: Date.now() + CACHE_TTL_MS };
  return result;
}
