// --- IPC Channel Constants ---

export const IPC_CHANNELS = {
  BACKEND_REQUEST: 'backend:request',
  BACKEND_STATUS: 'backend:status',
  STREAM_START: 'backend:stream-start',
  STREAM_CANCEL: 'backend:stream-cancel',
  // Stream events are sent on dynamic channels: `backend:stream-event:${streamId}`
  streamEvent: (streamId: string) => `backend:stream-event:${streamId}`,

  // Credential storage
  CREDENTIAL_SET: 'credential:set',
  CREDENTIAL_HAS: 'credential:has',
  CREDENTIAL_DELETE: 'credential:delete',
  CREDENTIAL_CLEAR: 'credential:clear',
  CREDENTIAL_LIST: 'credential:list',

  // Models
  MODELS_GET_DIR: 'models:get-dir',
  MODELS_DISK_SPACE: 'models:disk-space',

  // Agent system
  AGENT_RUN: 'agent:run',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_ACTIVE_RUNS: 'agent:active-runs',
  agentEvent: (runId: string) => `agent:event:${runId}`,
} as const;

// --- Backend Request/Response ---

export interface BackendRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface BackendResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

// --- Backend Status ---

export type BackendStatus = 'starting' | 'healthy' | 'unhealthy' | 'stopped';

// --- Streaming ---

export interface StreamRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface StreamEvent {
  event: 'data' | 'error' | 'end';
  data: string;
}

// --- Credential Storage ---

export interface CredentialSetRequest {
  service: string;
  key: string;
  value: string;
  label?: string;
}

export interface CredentialIdentifier {
  service: string;
  key: string;
}

export interface CredentialInfo {
  service: string;
  key: string;
  label?: string;
  updatedAt: string;
}

export interface CredentialResult<T = void> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface CredentialAPI {
  set(request: CredentialSetRequest): Promise<CredentialResult>;
  has(service: string, key: string): Promise<boolean>;
  delete(service: string, key: string): Promise<CredentialResult>;
  clear(service?: string): Promise<CredentialResult>;
  list(service?: string): Promise<CredentialInfo[]>;
}

// --- Models ---

export interface DiskSpace {
  free: number;
  total: number;
}

export interface ModelsAPI {
  getDir(): Promise<string>;
  getDiskSpace(): Promise<DiskSpace>;
}

// --- Agent System ---

export interface AgentRunRequest {
  conversationId: string;
  content: string;
  expertId?: string | null;
}

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'done'; runId: string; messageContent: string }
  | { type: 'error'; runId: string; error: string };

export interface ActiveRunInfo {
  runId: string;
  conversationId: string;
  expertId: string | null;
  startedAt: number;
}

export interface AgentAPI {
  run(request: AgentRunRequest): Promise<string>;
  cancel(runId: string): Promise<boolean>;
  activeRuns(): Promise<ActiveRunInfo[]>;
  onEvent(runId: string, callback: (event: RendererAgentEvent) => void): () => void;
}

// --- Preload API exposed on window.cerebro ---

export interface CerebroAPI {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>>;
  getStatus(): Promise<BackendStatus>;
  startStream(request: StreamRequest): Promise<string>;
  cancelStream(streamId: string): Promise<void>;
  onStream(streamId: string, callback: (event: StreamEvent) => void): () => void;
  credentials: CredentialAPI;
  models: ModelsAPI;
  agent: AgentAPI;
}
