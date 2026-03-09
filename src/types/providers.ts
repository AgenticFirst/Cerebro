export type CloudProvider = 'anthropic' | 'openai' | 'google';

export type ModelSource = 'local' | 'cloud' | 'claude-code';

export interface SelectedModel {
  source: ModelSource;
  provider?: CloudProvider;
  modelId: string;
  displayName: string;
}

export type ConnectionStatus = 'not_configured' | 'key_saved' | 'verifying' | 'connected' | 'error';

// Claude Code integration
export type ClaudeCodeStatus = 'unknown' | 'detecting' | 'available' | 'unavailable' | 'error';

export interface ClaudeCodeInfo {
  status: ClaudeCodeStatus;
  version?: string;
  path?: string;
  error?: string;
}

export interface ProviderConnectionState {
  status: ConnectionStatus;
  error?: string;
}
