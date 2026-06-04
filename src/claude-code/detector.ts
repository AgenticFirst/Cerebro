/**
 * Detects whether Claude Code CLI is installed on the user's system.
 *
 * Runs `which claude` (or `where claude` on Windows) then `claude --version`
 * to determine availability, path, and version.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeCodeInfo } from '../types/providers';

let cachedInfo: ClaudeCodeInfo = { status: 'unknown' };

export function getCachedClaudeCodeInfo(): ClaudeCodeInfo {
  return cachedInfo;
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Returns common macOS/Linux installation paths for the `claude` binary.
 * Electron apps don't inherit the user's shell PATH, so `which` often fails
 * even when Claude Code is installed via npm/nvm.
 */
function getFallbackPaths(): string[] {
  const home = os.homedir();
  const candidates = ['/usr/local/bin/claude', path.join(home, '.npm-global', 'bin', 'claude')];

  // Expand ~/.nvm/versions/node/*/bin/claude
  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    const nodeDirs = fs.readdirSync(nvmVersionsDir);
    for (const dir of nodeDirs) {
      candidates.push(path.join(nvmVersionsDir, dir, 'bin', 'claude'));
    }
  } catch {
    // nvm not installed — skip
  }

  return candidates;
}

/**
 * Tries each fallback path: checks existence then runs `--version` to verify.
 * Returns the first working path, or null if none work.
 */
async function findInFallbackPaths(): Promise<string | null> {
  for (const candidate of getFallbackPaths()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      await runCommand(candidate, ['--version']);
      return candidate;
    } catch {
      // Binary exists but doesn't run — skip
    }
  }
  return null;
}

export async function detectClaudeCode(): Promise<ClaudeCodeInfo> {
  cachedInfo = { status: 'detecting' };

  try {
    // Find the claude binary
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    let claudePath: string;
    try {
      claudePath = await runCommand(whichCmd, ['claude']);
    } catch {
      // On macOS/Linux, Electron doesn't inherit shell PATH — try common locations
      if (process.platform !== 'win32') {
        const fallback = await findInFallbackPaths();
        if (fallback) {
          claudePath = fallback;
        } else {
          cachedInfo = { status: 'unavailable' };
          return cachedInfo;
        }
      } else {
        cachedInfo = { status: 'unavailable' };
        return cachedInfo;
      }
    }

    // Get version
    let version: string | undefined;
    try {
      const versionOutput = await runCommand(claudePath, ['--version']);
      // Output might be like "claude 1.2.3" or just "1.2.3"
      const match = versionOutput.match(/(\d+\.\d+[\w.-]*)/);
      version = match ? match[1] : versionOutput;
    } catch {
      // Version check failed but binary exists — still mark as available
    }

    cachedInfo = {
      status: 'available',
      version,
      path: claudePath,
    };
    return cachedInfo;
  } catch (err) {
    cachedInfo = {
      status: 'error',
      error: err instanceof Error ? err.message : 'Detection failed',
    };
    return cachedInfo;
  }
}
