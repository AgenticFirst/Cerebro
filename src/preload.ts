import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  TelegramVerifyResponse,
  TelegramStatusResponse,
  TelegramConversationUpdatedEvent,
  WhatsAppStatusResponse,
  WhatsAppConversationUpdatedEvent,
  HubSpotStatusResponse,
  HubSpotVerifyResult,
  HubSpotPipelineSummary,
  GHLStatusResponse,
  GHLVerifyResult,
  GitHubStatusResponse,
  GitHubVerifyResult,
  GitHubRepoSummary,
  IntegrationProposalEventPayload,
  UpdateInfo,
  UpdateAsset,
  UpdateDownloadProgress,
  UpdateDownloadedEvent,
} from './types/ipc';
import type { ExecutionEvent } from './engine/events/types';
import type { ClaudeCodeInfo } from './types/providers';
import type { ClaudeCodeInstallResult, ClaudeCodeProbeResult } from './types/ipc';
import type { VoiceSessionEvent } from './voice/types';

const api: CerebroAPI = {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>> {
    return ipcRenderer.invoke(IPC_CHANNELS.BACKEND_REQUEST, request);
  },

  getStatus(): Promise<BackendStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.BACKEND_STATUS);
  },

  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
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
    install(onLog: (line: string) => void): Promise<ClaudeCodeInstallResult> {
      const listener = (_event: Electron.IpcRendererEvent, line: string) => onLog(line);
      ipcRenderer.on(IPC_CHANNELS.CLAUDE_CODE_INSTALL_LOG, listener);
      return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_INSTALL).finally(() => {
        ipcRenderer.removeListener(IPC_CHANNELS.CLAUDE_CODE_INSTALL_LOG, listener);
      });
    },
    cancelInstall(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_INSTALL_CANCEL);
    },
    probeAuth(): Promise<ClaudeCodeProbeResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_CODE_PROBE_AUTH);
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

  taskTerminal: {
    onGlobalData(callback: (runId: string, data: string) => void): () => void {
      const handler = (_event: Electron.IpcRendererEvent, runId: string, data: string) =>
        callback(runId, data);
      ipcRenderer.on(IPC_CHANNELS.TASK_TERMINAL_DATA, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_TERMINAL_DATA, handler);
    },
    onData(runId: string, callback: (data: string) => void): () => void {
      const channel = IPC_CHANNELS.taskTerminalData(runId);
      const handler = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    resize(runId: string, cols: number, rows: number): void {
      ipcRenderer.send(IPC_CHANNELS.TASK_TERMINAL_RESIZE, runId, cols, rows);
    },
    sendInput(runId: string, data: string): void {
      ipcRenderer.send(IPC_CHANNELS.TASK_TERMINAL_INPUT, runId, data);
    },
    readBuffer(runId: string): Promise<string | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_TERMINAL_READ_BUFFER, runId);
    },
    removeBuffer(runId: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_TERMINAL_REMOVE_BUFFER, runId);
    },
    createWorkspace(taskId: string): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKSPACE_CREATE, taskId);
    },
    getWorkspacePath(taskId: string): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKSPACE_PATH, taskId);
    },
    listFiles(taskId: string, overridePath?: string) {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKSPACE_LIST_FILES, taskId, overridePath);
    },
    readFile(taskId: string, relativePath: string): Promise<string | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKSPACE_READ_FILE, taskId, relativePath);
    },
    removeWorkspace(taskId: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.TASK_WORKSPACE_REMOVE, taskId);
    },
    startShellSession(sessionKey: string, cwd: string, cols: number, rows: number): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_START, sessionKey, cwd, cols, rows);
    },
    stopShellSession(sessionKey: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_STOP, sessionKey);
    },
  },

  shell: {
    openPath(filePath: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_PATH, filePath);
    },
    openExternal(url: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url);
    },
    revealPath(filePath: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_REVEAL_PATH, filePath);
    },
    statPath(filePath: string): Promise<{ exists: boolean; isDirectory: boolean; size: number }> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_STAT_PATH, filePath);
    },
    downloadToDownloads(filePath: string): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_DOWNLOAD_TO_DOWNLOADS, filePath);
    },
    readTextFile(filePath: string): Promise<string> {
      return ipcRenderer.invoke(IPC_CHANNELS.SHELL_READ_TEXT_FILE, filePath);
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

  telegram: {
    verify(token: string): Promise<TelegramVerifyResponse> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_VERIFY, token);
    },
    enable(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_ENABLE);
    },
    disable(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_DISABLE);
    },
    status(): Promise<TelegramStatusResponse> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_STATUS);
    },
    reload(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_RELOAD);
    },
    setToken(token: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_SET_TOKEN, token);
    },
    clearToken(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.TELEGRAM_CLEAR_TOKEN);
    },
    onConversationUpdated(
      callback: (event: TelegramConversationUpdatedEvent) => void,
    ): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: TelegramConversationUpdatedEvent,
      ) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.TELEGRAM_CONVERSATION_UPDATED, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.TELEGRAM_CONVERSATION_UPDATED, listener);
    },
  },

  whatsapp: {
    startPairing(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_START_PAIRING);
    },
    cancelPairing(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_CANCEL_PAIRING);
    },
    clearSession(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_CLEAR_SESSION);
    },
    status(): Promise<WhatsAppStatusResponse> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_STATUS);
    },
    setAllowlist(list: string[]): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_SET_ALLOWLIST, list);
    },
    enable(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_ENABLE);
    },
    disable(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_DISABLE);
    },
    onStatusChanged(callback: (status: WhatsAppStatusResponse) => void): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: WhatsAppStatusResponse,
      ) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WHATSAPP_STATUS_CHANGED, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.WHATSAPP_STATUS_CHANGED, listener);
    },
    onConversationUpdated(
      callback: (event: WhatsAppConversationUpdatedEvent) => void,
    ): () => void {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: WhatsAppConversationUpdatedEvent,
      ) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WHATSAPP_CONVERSATION_UPDATED, listener);
      return () =>
        ipcRenderer.removeListener(IPC_CHANNELS.WHATSAPP_CONVERSATION_UPDATED, listener);
    },
  },

  hubspot: {
    verify(token: string): Promise<HubSpotVerifyResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.HUBSPOT_VERIFY, token);
    },
    listPipelines(): Promise<{ ok: boolean; pipelines?: HubSpotPipelineSummary[]; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.HUBSPOT_LIST_PIPELINES);
    },
    status(): Promise<HubSpotStatusResponse> {
      return ipcRenderer.invoke(IPC_CHANNELS.HUBSPOT_STATUS);
    },
    setToken(token: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.HUBSPOT_SET_TOKEN, token);
    },
    clearToken(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.HUBSPOT_CLEAR_TOKEN);
    },
    setDefaults(defaults: { pipeline: string | null; stage: string | null }): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.HUBSPOT_SET_DEFAULTS, defaults);
    },
  },

  ghl: {
    verify(apiKey: string, locationId: string): Promise<GHLVerifyResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.GHL_VERIFY, apiKey, locationId);
    },
    status(): Promise<GHLStatusResponse> {
      return ipcRenderer.invoke(IPC_CHANNELS.GHL_STATUS);
    },
    setCredentials(apiKey: string, locationId: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GHL_SET_CREDENTIALS, apiKey, locationId);
    },
    clearCredentials(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GHL_CLEAR_CREDENTIALS);
    },
  },

  github: {
    verify(token: string): Promise<GitHubVerifyResult> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_VERIFY, token);
    },
    status(): Promise<GitHubStatusResponse> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_STATUS);
    },
    setToken(token: string): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_SET_TOKEN, token);
    },
    clearToken(): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_CLEAR_TOKEN);
    },
    listRepos(): Promise<{ ok: boolean; repos?: GitHubRepoSummary[]; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LIST_REPOS);
    },
    listWatchedRepos(): Promise<{ ok: boolean; repos?: string[]; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_LIST_WATCHED_REPOS);
    },
    setWatchedRepos(repos: string[]): Promise<{ ok: boolean; error?: string }> {
      return ipcRenderer.invoke(IPC_CHANNELS.GITHUB_SET_WATCHED_REPOS, repos);
    },
    onStatusChanged(callback: (status: GitHubStatusResponse) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, data: GitHubStatusResponse) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.GITHUB_STATUS_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.GITHUB_STATUS_CHANGED, listener);
    },
  },

  chatActions: {
    catalog(lang: 'en' | 'es') {
      return ipcRenderer.invoke(IPC_CHANNELS.CHAT_ACTIONS_CATALOG, lang);
    },
    onIntegrationProposal(
      callback: (payload: IntegrationProposalEventPayload) => void,
    ): () => void {
      const listener = (_event: unknown, payload: IntegrationProposalEventPayload) =>
        callback(payload);
      ipcRenderer.on(IPC_CHANNELS.INTEGRATION_PROPOSAL, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.INTEGRATION_PROPOSAL, listener);
    },
  },

  updater: {
    checkNow(): Promise<UpdateInfo | null> {
      return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK_NOW);
    },
    download(asset: UpdateAsset): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD, asset);
    },
    dismiss(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DISMISS);
    },
    notified(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_NOTIFIED);
    },
    openReleasePage(url: string): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_OPEN_RELEASE_PAGE, url);
    },
    onAvailable(callback: (info: UpdateInfo) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, data: UpdateInfo) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_AVAILABLE, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_AVAILABLE, listener);
    },
    onProgress(callback: (progress: UpdateDownloadProgress) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, data: UpdateDownloadProgress) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, listener);
    },
    onDownloaded(callback: (event: UpdateDownloadedEvent) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, data: UpdateDownloadedEvent) =>
        callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOADED, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOADED, listener);
    },
    onError(callback: (message: string) => void): () => void {
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.UPDATE_ERROR, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_ERROR, listener);
    },
  },

  files: {
    pickFiles() {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_PICK_FILES);
    },
    importToBucket(args) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_IMPORT_TO_BUCKET, args);
    },
    copyManaged(args) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_COPY_MANAGED, args);
    },
    deleteManaged(relPath) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_DELETE_MANAGED, relPath);
    },
    deleteManagedBatch(relPaths) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_DELETE_MANAGED_BATCH, relPaths);
    },
    previewUrl(args) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_PREVIEW_URL, args);
    },
    reveal(args) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_REVEAL, args);
    },
    open(args) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_OPEN, args);
    },
    download(args) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_DOWNLOAD, args);
    },
    readManagedText(relPath) {
      return ipcRenderer.invoke(IPC_CHANNELS.FILES_READ_MANAGED_TEXT, relPath);
    },
  },
};

contextBridge.exposeInMainWorld('cerebro', api);
