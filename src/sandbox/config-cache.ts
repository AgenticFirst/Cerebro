/**
 * In-memory cache of the sandbox config for the main process.
 *
 * Mirrors `getCachedClaudeCodeInfo` in ../claude-code/detector.ts. `wrap-spawn`
 * reads from here to decide whether to wrap the `claude` subprocess with
 * sandbox-exec. `profilePath` is populated lazily: the first spawn after a
 * mutation generates the `.sb` file and caches the path so subsequent spawns
 * reuse it without redoing the profile generation or disk write.
 */

import type { SandboxConfig } from './types';

let cachedConfig: SandboxConfig | null = null;
let cachedDataDir: string | null = null;
let cachedProfilePath: string | null = null;

export function getCachedSandboxConfig(): SandboxConfig | null {
  return cachedConfig;
}

export function setCachedSandboxConfig(config: SandboxConfig): void {
  cachedConfig = config;
  // Invalidate the generated profile whenever the config changes.
  cachedProfilePath = null;
}

export function clearCachedSandboxConfig(): void {
  cachedConfig = null;
  cachedProfilePath = null;
}

export function setSandboxDataDir(dir: string): void {
  cachedDataDir = dir;
}

export function getSandboxDataDir(): string | null {
  return cachedDataDir;
}

export function getCachedProfilePath(): string | null {
  return cachedProfilePath;
}

export function setCachedProfilePath(profilePath: string): void {
  cachedProfilePath = profilePath;
}
