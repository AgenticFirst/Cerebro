import type { ExecutionEvent } from '../engine/events/types';
import type { ClaudeCodeInfo } from './providers';
import type { VoiceSessionEvent } from '../voice/types';

// --- IPC Channel Constants ---

export const IPC_CHANNELS = {
  BACKEND_REQUEST: 'backend:request',
  BACKEND_STATUS: 'backend:status',
  STREAM_START: 'backend:stream-start',
  STREAM_CANCEL: 'backend:stream-cancel',
  // Stream events are sent on dynamic channels: `backend:stream-event:${streamId}`
  streamEvent: (streamId: string) => `backend:stream-event:${streamId}`,

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
  ENGINE_APPROVE: 'engine:approve',
  ENGINE_DENY: 'engine:deny',
  ENGINE_ANY_EVENT: 'engine:any-event',
  engineEvent: (runId: string) => `engine:event:${runId}`,

  // Scheduler
  SCHEDULER_SYNC: 'scheduler:sync',

  // Claude Code
  CLAUDE_CODE_DETECT: 'claude-code:detect',
  CLAUDE_CODE_STATUS: 'claude-code:status',

  // Voice
  VOICE_START: 'voice:start',
  VOICE_STOP: 'voice:stop',
  VOICE_AUDIO_CHUNK: 'voice:audio-chunk',
  VOICE_DONE_SPEAKING: 'voice:done-speaking',
  VOICE_MODEL_STATUS: 'voice:model-status',
  voiceEvent: (sessionId: string) => `voice:event:${sessionId}`,

  // Installer (Cerebro project-scoped subagents/skills under <userData>/.claude/)
  INSTALLER_SYNC_EXPERT: 'installer:sync-expert',
  INSTALLER_REMOVE_EXPERT: 'installer:remove-expert',
  INSTALLER_SYNC_ALL: 'installer:sync-all',
  EXPERTS_CHANGED: 'experts:changed',
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
  approve(approvalId: string): Promise<boolean>;
  deny(approvalId: string, reason?: string): Promise<boolean>;
  onAnyEvent(callback: (event: ExecutionEvent) => void): () => void;
}

// --- Scheduler ---

export interface SchedulerAPI {
  sync(): Promise<void>;
}

// --- Claude Code ---

export interface ClaudeCodeAPI {
  detect(): Promise<ClaudeCodeInfo>;
  getStatus(): Promise<ClaudeCodeInfo>;
}

// --- Installer ---

export interface InstallerAPI {
  syncExpert(expertId: string): Promise<{ ok: boolean; error?: string }>;
  removeExpert(expertId: string): Promise<{ ok: boolean; error?: string }>;
  syncAll(): Promise<{ ok: boolean; error?: string }>;
  onExpertsChanged(callback: () => void): () => void;
}

// --- Voice ---

export interface VoiceAPI {
  start(expertId: string, conversationId: string): Promise<string>;
  stop(sessionId: string): Promise<void>;
  sendAudioChunk(sessionId: string, chunk: ArrayBuffer): Promise<void>;
  doneSpeaking(sessionId: string): Promise<void>;
  getModelStatus(): Promise<unknown>;
  onEvent(sessionId: string, callback: (event: VoiceSessionEvent) => void): () => void;
}

// --- Preload API exposed on window.cerebro ---

export interface CerebroAPI {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>>;
  getStatus(): Promise<BackendStatus>;
  startStream(request: StreamRequest): Promise<string>;
  cancelStream(streamId: string): Promise<void>;
  onStream(streamId: string, callback: (event: StreamEvent) => void): () => void;
  agent: AgentAPI;
  engine: EngineAPI;
  scheduler: SchedulerAPI;
  claudeCode: ClaudeCodeAPI;
  installer: InstallerAPI;
  voice: VoiceAPI;
}
