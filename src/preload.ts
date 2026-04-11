import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './types/ipc';
import type {
  BackendRequest,
  BackendResponse,
  BackendStatus,
  StreamRequest,
  StreamEvent,
  CerebroAPI,
  AgentRunRequest,
  RendererAgentEvent,
  ActiveRunInfo,
  EngineRunRequest,
  EngineActiveRunInfo,
} from './types/ipc';
import type { ExecutionEvent } from './engine/events/types';
import type { ClaudeCodeInfo } from './types/providers';
import type { VoiceSessionEvent } from './voice/types';

const api: CerebroAPI = {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>> {
    return ipcRenderer.invoke(IPC_CHANNELS.BACKEND_REQUEST, request);
  },

  getStatus(): Promise<BackendStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.BACKEND_STATUS);
  },

  startStream(request: StreamRequest): Promise<string> {
    return ipcRenderer.invoke(IPC_CHANNELS.STREAM_START, request);
  },

  cancelStream(streamId: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.STREAM_CANCEL, streamId);
  },

  onStream(streamId: string, callback: (event: StreamEvent) => void): () => void {
    const channel = IPC_CHANNELS.streamEvent(streamId);
    const listener = (_event: Electron.IpcRendererEvent, data: StreamEvent) => {
      callback(data);
    };
    ipcRenderer.on(channel, listener);

    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  agent: {
    run(request: AgentRunRequest): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.AGENT_RUN, request);
    },
    cancel(runId: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC_CHANNELS.AGENT_CANCEL, runId);
    },
    activeRuns(): Promise<ActiveRunInfo[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.AGENT_ACTIVE_RUNS);
    },
    onEvent(runId: string, callback: (event: RendererAgentEvent) => void): () => void {
      const channel = IPC_CHANNELS.agentEvent(runId);
      const listener = (_event: Electron.IpcRendererEvent, data: RendererAgentEvent) => {
        callback(data);
      };
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  },

  engine: {
    run(request: EngineRunRequest): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.ENGINE_RUN, request);
    },
    cancel(runId: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC_CHANNELS.ENGINE_CANCEL, runId);
    },
    activeRuns(): Promise<EngineActiveRunInfo[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.ENGINE_ACTIVE_RUNS);
    },
    getEvents(runId: string): Promise<ExecutionEvent[]> {
      return ipcRenderer.invoke(IPC_CHANNELS.ENGINE_GET_EVENTS, runId);
    },
    onEvent(runId: string, callback: (event: ExecutionEvent) => void): () => void {
      const channel = IPC_CHANNELS.engineEvent(runId);
      const listener = (_event: Electron.IpcRendererEvent, data: ExecutionEvent) => {
        callback(data);
      };
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
    approve(approvalId: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC_CHANNELS.ENGINE_APPROVE, approvalId);
    },
    deny(approvalId: string, reason?: string): Promise<boolean> {
      return ipcRenderer.invoke(IPC_CHANNELS.ENGINE_DENY, approvalId, reason);
    },
    onAnyEvent(callback: (event: ExecutionEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, data: ExecutionEvent) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.ENGINE_ANY_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.ENGINE_ANY_EVENT, listener);
    },
  },

  scheduler: {
    sync(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_SYNC);
    },
  },

  claudeCode: {
    detect(): Promise<ClaudeCodeInfo> {
      return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_DETECT);
    },
    getStatus(): Promise<ClaudeCodeInfo> {
      return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_STATUS);
    },
  },

  installer: {
    syncExpert(expertId: string) {
      return ipcRenderer.invoke(IPC_CHANNELS.INSTALLER_SYNC_EXPERT, expertId);
    },
    removeExpert(expertId: string) {
      return ipcRenderer.invoke(IPC_CHANNELS.INSTALLER_REMOVE_EXPERT, expertId);
    },
    syncAll() {
      return ipcRenderer.invoke(IPC_CHANNELS.INSTALLER_SYNC_ALL);
    },
    onExpertsChanged(callback: () => void): () => void {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.EXPERTS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.EXPERTS_CHANGED, listener);
    },
  },

  voice: {
    start(expertId: string, conversationId: string): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_START, expertId, conversationId);
    },
    stop(sessionId: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_STOP, sessionId);
    },
    sendAudioChunk(sessionId: string, chunk: ArrayBuffer): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_AUDIO_CHUNK, sessionId, chunk);
    },
    doneSpeaking(sessionId: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_DONE_SPEAKING, sessionId);
    },
    getModelStatus(): Promise<unknown> {
      return ipcRenderer.invoke(IPC_CHANNELS.VOICE_MODEL_STATUS);
    },
    onEvent(sessionId: string, callback: (event: VoiceSessionEvent) => void): () => void {
      const channel = IPC_CHANNELS.voiceEvent(sessionId);
      const listener = (_event: Electron.IpcRendererEvent, data: VoiceSessionEvent) => {
        callback(data);
      };
      ipcRenderer.on(channel, listener);
      return () => {
        ipcRenderer.removeListener(channel, listener);
      };
    },
  },

  sandbox: {
    pickDirectory(): Promise<string | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_PICK_DIRECTORY);
    },
    revealWorkspace(workspacePath: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_REVEAL_WORKSPACE, workspacePath);
    },
    getProfile(): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_GET_PROFILE);
    },
    setCache(config: unknown): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_SET_CACHE, config);
    },
  },
};

contextBridge.exposeInMainWorld('cerebro', api);
