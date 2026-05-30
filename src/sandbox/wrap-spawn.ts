/**
 * Wraps a `claude` CLI spawn with macOS `sandbox-exec` when the sandbox is
 * enabled. Pass-through when disabled or off-macOS.
 *
 * Every spawn of the `claude` subprocess (chat stream, single-shot, routines,
 * voice) runs through here, so the profile-generation path is deliberately
 * cached: it only re-runs when the config changes (see config-cache.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  getCachedProfilePath,
  getCachedSandboxConfig,
  getSandboxDataDir,
  setCachedProfilePath,
} from './config-cache';
import { generateProfile } from './profile-generator';

export interface WrappedCommand {
  binary: string;
  args: string[];
  sandboxed: boolean;
}

export interface WrapInputs {
  claudeBinary: string;
  claudeArgs: string[];
}

/**
 * Engine-neutral spawn wrapper. Used by both the Claude Code and Codex
 * runners so a single macOS sandbox profile governs whichever CLI is active.
 */
export function wrapAgentSpawn(binary: string, args: string[]): WrappedCommand {
  const passthrough: WrappedCommand = { binary, args, sandboxed: false };

  const config = getCachedSandboxConfig();
  if (!config || !config.enabled || !config.platform_supported) return passthrough;
  // Belt-and-suspenders against a backend that misreports platform_supported.
  if (process.platform !== 'darwin') return passthrough;

  const dataDir = getSandboxDataDir();
  if (!dataDir) return passthrough;

  const profilePath = ensureProfileOnDisk(config, dataDir);

  return {
    binary: 'sandbox-exec',
    args: ['-f', profilePath, binary, ...args],
    sandboxed: true,
  };
}

export function wrapClaudeSpawn(inputs: WrapInputs): WrappedCommand {
  return wrapAgentSpawn(inputs.claudeBinary, inputs.claudeArgs);
}

function ensureProfileOnDisk(
  config: ReturnType<typeof getCachedSandboxConfig> & object,
  dataDir: string,
): string {
  const cached = getCachedProfilePath();
  if (cached) return cached;

  const profile = generateProfile({
    workspacePath: config.workspace_path,
    cerebroDataDir: dataDir,
    linkedProjects: config.linked_projects,
    forbiddenHomeSubpaths: config.forbidden_home_subpaths,
  });

  const profileDir = path.join(dataDir, 'sandbox');
  fs.mkdirSync(profileDir, { recursive: true });
  const profilePath = path.join(profileDir, 'profile.sb');
  fs.writeFileSync(profilePath, profile, 'utf-8');
  setCachedProfilePath(profilePath);
  return profilePath;
}
