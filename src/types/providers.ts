export type CloudProvider = 'anthropic' | 'openai' | 'google';

export type ModelSource = 'local' | 'cloud';

export interface SelectedModel {
  source: ModelSource;
  provider?: CloudProvider;
  modelId: string;
  displayName: string;
}

export type ConnectionStatus = 'not_configured' | 'key_saved' | 'verifying' | 'connected' | 'error';

export interface ProviderConnectionState {
  status: ConnectionStatus;
  error?: string;
}
