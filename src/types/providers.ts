// Claude Code is the only inference backend Cerebro uses now.

export type ClaudeCodeStatus = 'unknown' | 'detecting' | 'available' | 'unavailable' | 'error';

export interface ClaudeCodeInfo {
  status: ClaudeCodeStatus;
  version?: string;
  path?: string;
  error?: string;
}
