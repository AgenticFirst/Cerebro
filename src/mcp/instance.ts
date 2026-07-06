/**
 * Module-scoped handle to the McpBridge singleton, set by main.ts at boot.
 *
 * Exists so the agent runtime (src/agents/runtime.ts) can resolve per-run
 * MCP configs without importing main.ts (circular) — same seam pattern as
 * setClaudeCodeCwd. Null until the backend is up; callers treat null as
 * "no MCP servers" (fail-open: a missing bridge never blocks a run).
 */

import type { McpBridge } from './bridge';

let bridge: McpBridge | null = null;

export function setMcpBridge(instance: McpBridge | null): void {
  bridge = instance;
}

export function getMcpBridge(): McpBridge | null {
  return bridge;
}
