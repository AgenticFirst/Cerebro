/**
 * Auth probe for the Codex CLI.
 *
 * Unlike Claude Code (which needs a token-costing `claude -p` roundtrip),
 * Codex ships a clean `codex login status` subcommand — zero API cost. We
 * run it, treat exit 0 + a "logged in / signed in / active account" line as
 * authenticated, and classify everything else as signed-out.
 *
 * Result is cached in module memory for 60 s and coalesced via single-flight,
 * mirroring `src/claude-code/auth-probe.ts`. `{ force: true }` busts the cache
 * (call it after a successful login).
 */

import { execFile } from 'node:child_process';
import { getCachedCodexInfo } from './detector';
import type { EngineProbeResult } from '../types';

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

const SIGNED_IN_RE = /logged\s+in|signed\s+in|active\s+account/i;
const AUTH_REQUIRED_RE =
  /not\s+logged\s+in|please\s+(?:run|use)\s+\/?login|not\s+authenticated|run\s+`?codex\s+login`?|token\s+(?:expired|invalid|revoked)|401\s+unauthori[sz]ed/i;

let cache: { value: EngineProbeResult; expiresAt: number } | null = null;
let inflight: Promise<EngineProbeResult> | null = null;

export function clearCodexProbeCache(): void {
  cache = null;
}

export async function probeCodexAuth(opts?: { force?: boolean }): Promise<EngineProbeResult> {
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

function runProbe(): Promise<EngineProbeResult> {
  const info = getCachedCodexInfo();
  if (info.status !== 'available' || !info.path) {
    const value: EngineProbeResult = { ok: false, reason: 'Codex CLI not found' };
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return Promise.resolve(value);
  }

  return new Promise<EngineProbeResult>((resolve) => {
    execFile(
      info.path!,
      ['login', 'status'],
      { timeout: PROBE_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const combined = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        let value: EngineProbeResult;
        if (!error && SIGNED_IN_RE.test(combined)) {
          value = { ok: true };
        } else if (AUTH_REQUIRED_RE.test(combined) || error) {
          value = { ok: false, reason: lastNonEmpty(combined) || 'Codex is not signed in.' };
        } else {
          // Exit 0 but no recognizable marker — treat as signed in (newer CLI
          // wording) rather than block a working install.
          value = { ok: true };
        }
        cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        resolve(value);
      },
    );
  });
}

function lastNonEmpty(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}
