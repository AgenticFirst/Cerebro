import type { ExecutionEvent } from '../engine/events/types';

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

  // Execution engine
  ENGINE_RUN: 'engine:run',
  ENGINE_CANCEL: 'engine:cancel',
  ENGINE_ACTIVE_RUNS: 'engine:active-runs',
  ENGINE_GET_EVENTS: 'engine:get-events',
  engineEvent: (runId: string) => `engine:event:${runId}`,

  // Scheduler
  SCHEDULER_SYNC: 'scheduler:sync',
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

export interface ProposalSnapshot {
  name: string;
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
}

export interface MessageSnapshot {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRunRequest {
  conversationId: string;
  content: string;
  expertId?: string | null;
  recentMessages?: MessageSnapshot[];
  routineProposals?: ProposalSnapshot[];
  expertProposals?: ProposalSnapshot[];
}

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'delegation_start'; parentRunId: string; childRunId: string; expertId: string; expertName: string }
  | { type: 'delegation_end'; parentRunId: string; childRunId: string; status: string }
  | { type: 'team_started'; teamId: string; teamName: string; strategy: string; memberCount: number }
  | { type: 'member_queued'; teamId: string; memberId: string; memberName: string; role: string }
  | { type: 'member_started'; teamId: string; memberId: string; memberName: string }
  | { type: 'member_completed'; teamId: string; memberId: string; memberName: string; status: 'completed' | 'error'; response?: string }
  | { type: 'team_synthesis'; teamId: string }
  | { type: 'team_completed'; teamId: string; status: 'completed' | 'error'; successCount: number; totalCount: number }
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

// --- Execution Engine ---

export interface EngineRunRequest {
  dag: {
    steps: Array<{
      id: string;
      name: string;
      actionType: string;
      params: Record<string, unknown>;
      dependsOn: string[];
      inputMappings: Array<{
        sourceStepId: string;
        sourceField: string;
        targetField: string;
      }>;
      requiresApproval: boolean;
      onError: 'fail' | 'skip' | 'retry';
      maxRetries?: number;
      timeoutMs?: number;
    }>;
  };
  routineId?: string;
  triggerSource?: string;
}

export interface EngineActiveRunInfo {
  runId: string;
  routineId?: string;
  startedAt: number;
}

export interface EngineAPI {
  run(request: EngineRunRequest): Promise<string>;
  cancel(runId: string): Promise<boolean>;
  activeRuns(): Promise<EngineActiveRunInfo[]>;
  getEvents(runId: string): Promise<ExecutionEvent[]>;
  onEvent(runId: string, callback: (event: ExecutionEvent) => void): () => void;
}

// --- Scheduler ---

export interface SchedulerAPI {
  sync(): Promise<void>;
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
  engine: EngineAPI;
  scheduler: SchedulerAPI;
}
