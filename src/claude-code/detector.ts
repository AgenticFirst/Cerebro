/**
 * Detects whether Claude Code CLI is installed on the user's system.
 *
 * Runs `which claude` (or `where claude` on Windows) then `claude --version`
 * to determine availability, path, and version.
 */

import { execFile } from 'node:child_process';
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

export async function detectClaudeCode(): Promise<ClaudeCodeInfo> {
  cachedInfo = { status: 'detecting' };

  try {
    // Find the claude binary
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    let claudePath: string;
    try {
      claudePath = await runCommand(whichCmd, ['claude']);
    } catch {
      cachedInfo = { status: 'unavailable' };
      return cachedInfo;
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
