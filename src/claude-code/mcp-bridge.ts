/**
 * MCP Bridge Lifecycle Manager — creates and cleans up temp files
 * for the MCP server that bridges Claude Code to Cerebro's backend.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMcpServerScript } from './mcp-server';

export interface McpBridgeFiles {
  configPath: string;
  serverPath: string;
}

/**
 * Write the MCP server script and config JSON to temp files.
 * Returns paths that should be passed to ClaudeCodeRunner and cleaned up after the run.
 */
export function createMcpBridge(options: {
  runId: string;
  backendPort: number;
  scope: string;
  scopeId: string | null;
  conversationId: string;
}): McpBridgeFiles {
  const tmpDir = os.tmpdir();
  const serverPath = path.join(tmpDir, `cerebro-mcp-server-${options.runId}.js`);
  const configPath = path.join(tmpDir, `cerebro-mcp-config-${options.runId}.json`);

  // Write the MCP server script
  fs.writeFileSync(serverPath, getMcpServerScript(), 'utf-8');

  // Write the MCP config JSON
  const config = {
    mcpServers: {
      cerebro: {
        command: 'node',
        args: [serverPath],
        env: {
          CEREBRO_PORT: String(options.backendPort),
          CEREBRO_SCOPE: options.scope,
          CEREBRO_SCOPE_ID: options.scopeId || '',
          CEREBRO_CONVERSATION_ID: options.conversationId,
        },
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

  return { configPath, serverPath };
}

/**
 * Delete both temp files. Best-effort — never throws.
 */
export function cleanupMcpBridge(files: McpBridgeFiles): void {
  try { fs.unlinkSync(files.serverPath); } catch { /* ignore */ }
  try { fs.unlinkSync(files.configPath); } catch { /* ignore */ }
}
