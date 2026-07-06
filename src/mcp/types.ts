/**
 * Shared types + settings-key helpers for MCP server connections.
 *
 * Split of responsibilities (mirrors Gmail):
 *   - Backend `mcp_servers` table: non-secret metadata + discovered-tools
 *     cache (local-only, never syncs).
 *   - Settings table `mcp_<serverId>_<field>` keys: encrypted secrets
 *     (OAuth client/tokens for Drive, env/header values for custom servers),
 *     owned exclusively by the main-process McpBridge.
 */

export const MCP_INDEX_KEY = 'mcp_servers_index';

export function mcpSettingKey(serverId: string, field: string): string {
  return `mcp_${serverId}_${field}`;
}

/** Settings fields per server; cleared together on remove. */
export const MCP_SERVER_FIELDS = [
  'client_id',
  'client_secret',
  'access_token',
  'refresh_token',
  'token_expiry',
  'env_json',
  'headers_json',
] as const;

export type McpServerKind = 'gdrive' | 'custom';
export type McpTransport = 'stdio' | 'http';
export type McpServerStatus = 'discovering' | 'connected' | 'error' | 'auth_expired';

export interface DiscoveredTool {
  name: string;
  description: string;
  /** From the MCP tool annotations (readOnlyHint); false when unknown. */
  readOnly: boolean;
}

/** Renderer-facing snapshot of a connected server (no secrets). */
export interface McpServerInfo {
  id: string;
  slug: string;
  name: string;
  kind: McpServerKind;
  transport: McpTransport;
  /** stdio only */
  command: string | null;
  args: string[];
  /** http only */
  url: string | null;
  envNames: string[];
  headerNames: string[];
  chatEnabled: boolean;
  status: McpServerStatus;
  lastError: string | null;
  lastDiscoveredAt: string | null;
  tools: DiscoveredTool[];
  accountLabel: string | null;
}

export interface AddCustomMcpInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** One entry in the JSON passed to `claude --mcp-config`. */
export type McpConfigEntry =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface McpRunConfig {
  /** Keyed by server slug — tool names become `mcp__<slug>__<tool>`. */
  mcpServers: Record<string, McpConfigEntry>;
  /** Per-run env overlay backing `${VAR}` placeholders in the config. */
  env: Record<string, string>;
}

/** Google's official remote Drive MCP (Workspace Developer Preview). */
export const GDRIVE_MCP_URL = 'https://drivemcp.googleapis.com/mcp/v1';
export const GDRIVE_SLUG = 'gdrive';
/** Read-only v1: the two write tools (create_file, copy_file) are excluded. */
export const GDRIVE_WRITE_TOOLS = new Set(['create_file', 'copy_file']);

export function mcpToolName(slug: string, tool: string): string {
  return `mcp__${slug}__${tool}`;
}

/** Env var carrying a server's bearer token for `${VAR}` header expansion. */
export function mcpTokenEnvVar(slug: string): string {
  return `CEREBRO_MCP_${slug.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_TOKEN`;
}

/**
 * Derive a stable, unique slug from a display name: lowercase alphanumerics
 * plus dashes, deduplicated against taken slugs with a numeric suffix.
 */
export function slugifyServerName(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'server';
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}
