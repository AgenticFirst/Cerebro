/**
 * Detects whether the OpenAI Codex CLI (`codex`) is installed.
 *
 * Mirrors `src/claude-code/detector.ts`: runs `which codex` (or `where` on
 * Windows) then `codex --version`. Electron apps don't inherit the user's
 * shell PATH, so we fall back to scanning common npm/nvm/Homebrew locations.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineInfo } from '../types';

let cachedInfo: EngineInfo = { status: 'unknown' };

export function getCachedCodexInfo(): EngineInfo {
  return cachedInfo;
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function getFallbackPaths(): string[] {
  const home = os.homedir();
  const candidates = [
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(home, '.npm-global', 'bin', 'codex'),
  ];

  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const dir of fs.readdirSync(nvmVersionsDir)) {
      candidates.push(path.join(nvmVersionsDir, dir, 'bin', 'codex'));
    }
  } catch {
    // nvm not installed — skip
  }

  return candidates;
}

async function findInFallbackPaths(): Promise<string | null> {
  for (const candidate of getFallbackPaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      await runCommand(candidate, ['--version']);
      return candidate;
    } catch {
      // exists but doesn't run — skip
    }
  }
  return null;
}

export async function detectCodex(): Promise<EngineInfo> {
  cachedInfo = { status: 'detecting' };

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    let codexPath: string;
    try {
      codexPath = await runCommand(whichCmd, ['codex']);
    } catch {
      if (process.platform !== 'win32') {
        const fallback = await findInFallbackPaths();
        if (fallback) {
          codexPath = fallback;
        } else {
          cachedInfo = { status: 'unavailable' };
          return cachedInfo;
        }
      } else {
        cachedInfo = { status: 'unavailable' };
        return cachedInfo;
      }
    }

    let version: string | undefined;
    try {
      const versionOutput = await runCommand(codexPath, ['--version']);
      const match = versionOutput.match(/(\d+\.\d+[\w.-]*)/);
      version = match ? match[1] : versionOutput;
    } catch {
      // version check failed but binary exists — still mark available
    }

    cachedInfo = { status: 'available', version, path: codexPath };
    return cachedInfo;
  } catch (err) {
    cachedInfo = {
      status: 'error',
      error: err instanceof Error ? err.message : 'Detection failed',
    };
    return cachedInfo;
  }
}
