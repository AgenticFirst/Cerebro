/**
 * Builds the JSON object handed to `claude --mcp-config` for a single run,
 * plus per-run config file management under <userData>/logs/mcp-config/.
 *
 * Secrets discipline: bearer tokens and custom env/header values are NEVER
 * inlined into the JSON written to disk — entries reference `${VAR}`
 * placeholders that Claude Code expands from the subprocess env, and the
 * real values travel in the per-run env overlay only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { mcpTokenEnvVar, type McpConfigEntry, type McpRunConfig } from './types';

/** A server the bridge fully resolved (secrets decrypted) for one run. */
export interface ResolvedMcpServer {
  slug: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Fresh bearer token (http servers with managed auth, e.g. Drive). */
  bearerToken?: string;
}

function envPlaceholderVar(slug: string, key: string): string {
  return `CEREBRO_MCP_${slug.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${key
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toUpperCase()}`;
}

export function buildMcpRunConfig(servers: ResolvedMcpServer[]): McpRunConfig {
  const mcpServers: Record<string, McpConfigEntry> = {};
  const env: Record<string, string> = {};

  for (const server of servers) {
    if (server.transport === 'stdio') {
      if (!server.command) continue;
      const entryEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(server.env ?? {})) {
        const varName = envPlaceholderVar(server.slug, key);
        entryEnv[key] = `\${${varName}}`;
        env[varName] = value;
      }
      mcpServers[server.slug] = {
        command: server.command,
        args: server.args ?? [],
        ...(Object.keys(entryEnv).length > 0 ? { env: entryEnv } : {}),
      };
    } else {
      if (!server.url) continue;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(server.headers ?? {})) {
        const varName = envPlaceholderVar(server.slug, key);
        headers[key] = `\${${varName}}`;
        env[varName] = value;
      }
      if (server.bearerToken) {
        const varName = mcpTokenEnvVar(server.slug);
        headers.Authorization = `Bearer \${${varName}}`;
        env[varName] = server.bearerToken;
      }
      mcpServers[server.slug] = {
        type: 'http',
        url: server.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
  }

  return { mcpServers, env };
}

const MAX_CONFIG_FILES = 200;

/** Write the per-run config file and prune old ones (mirrors run-log pruning). */
export function writeMcpConfigFile(dataDir: string, runId: string, config: McpRunConfig): string {
  const dir = path.join(dataDir, 'logs', 'mcp-config');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: config.mcpServers }, null, 2), {
    mode: 0o600,
  });
  pruneOldConfigs(dir);
  return file;
}

function pruneOldConfigs(dir: string): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const { full } of files.slice(MAX_CONFIG_FILES)) {
      fs.unlinkSync(full);
    }
  } catch {
    // Pruning is best-effort; never block a spawn on it.
  }
}
