/**
 * Sandbox startup: fetch config from the backend, seed the main-process cache,
 * and ensure the workspace directory exists. Falls back to a safe "sandbox off"
 * default if the backend is unreachable, so chat still works and the user
 * sees the opt-in banner.
 */

import fs from 'node:fs';
import path from 'node:path';
import { setCachedSandboxConfig, setSandboxDataDir } from './config-cache';
import type { SandboxConfig } from './types';

export interface InitializeSandboxParams {
  cerebroDataDir: string;
  fetchConfig: () => Promise<SandboxConfig | null>;
}

export async function initializeSandbox(params: InitializeSandboxParams): Promise<void> {
  setSandboxDataDir(params.cerebroDataDir);

  const config = await params.fetchConfig();

  if (!config) {
    console.warn('[Sandbox] Could not fetch config from backend — sandbox inactive this run');
    setCachedSandboxConfig({
      enabled: false,
      workspace_path: path.join(params.cerebroDataDir, 'sandbox', 'workspace'),
      linked_projects: [],
      banner_dismissed: false,
      platform_supported: process.platform === 'darwin',
      forbidden_home_subpaths: [],
    });
    return;
  }

  try {
    fs.mkdirSync(config.workspace_path, { recursive: true });
  } catch (err) {
    console.error(`[Sandbox] Failed to create workspace at ${config.workspace_path}:`, err);
  }

  setCachedSandboxConfig(config);

  if (config.enabled && config.platform_supported) {
    console.log(
      `[Sandbox] Active. Workspace: ${config.workspace_path}. Linked projects: ${config.linked_projects.length}`,
    );
  } else if (config.enabled && !config.platform_supported) {
    console.log('[Sandbox] Enabled in settings but current platform is not supported — running without enforcement');
  } else {
    console.log('[Sandbox] Disabled — Claude Code has unrestricted host access');
  }
}
