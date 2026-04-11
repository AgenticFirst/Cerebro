/**
 * Shared TypeScript types for the sandbox subsystem.
 *
 * The shape matches backend/sandbox/schemas.py — when one moves, move both.
 */

export type LinkMode = 'read' | 'write';

export interface LinkedProject {
  id: string;
  path: string;
  mode: LinkMode;
  label: string;
  added_at: string;
}

export interface SandboxConfig {
  enabled: boolean;
  workspace_path: string;
  linked_projects: LinkedProject[];
  banner_dismissed: boolean;
  platform_supported: boolean;
  forbidden_home_subpaths: string[];
}
