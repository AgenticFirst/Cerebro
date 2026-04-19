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

  // Task terminal (PTY)
  TASK_TERMINAL_RESIZE: 'task-terminal:resize',
  TASK_TERMINAL_DATA: 'task-terminal:data',  // Global channel (Turbo pattern)
  TASK_TERMINAL_INPUT: 'task-terminal:input',  // Renderer → main: write to PTY stdin
  TASK_TERMINAL_READ_BUFFER: 'task-terminal:read-buffer',  // Renderer → main: load persisted buffer
  TASK_TERMINAL_REMOVE_BUFFER: 'task-terminal:remove-buffer',  // Renderer → main: delete persisted buffer on task deletion
  taskTerminalData: (runId: string) => `task-terminal:data:${runId}`,  // Legacy per-run

  // Task workspace (per-task isolated directory for agent builds)
  TASK_WORKSPACE_CREATE: 'task-workspace:create',       // Creates dir + .claude symlink, returns path
  TASK_WORKSPACE_PATH: 'task-workspace:path',           // Returns derived path (no creation)
  TASK_WORKSPACE_LIST_FILES: 'task-workspace:list-files',
  TASK_WORKSPACE_READ_FILE: 'task-workspace:read-file',
  TASK_WORKSPACE_REMOVE: 'task-workspace:remove',       // Deletes workspace on task delete

  // Sandbox
  SANDBOX_PICK_DIRECTORY: 'sandbox:pick-directory',
  SANDBOX_REVEAL_WORKSPACE: 'sandbox:reveal-workspace',
  SANDBOX_GET_PROFILE: 'sandbox:get-profile',
  SANDBOX_SET_CACHE: 'sandbox:set-cache',

  // Shell
  SHELL_OPEN_PATH: 'shell:open-path',
  SHELL_REVEAL_PATH: 'shell:reveal-path',
  SHELL_STAT_PATH: 'shell:stat-path',
  SHELL_DOWNLOAD_TO_DOWNLOADS: 'shell:download-to-downloads',
  SHELL_READ_TEXT_FILE: 'shell:read-text-file',

  // Telegram bridge
  TELEGRAM_VERIFY: 'telegram:verify',
  TELEGRAM_ENABLE: 'telegram:enable',
  TELEGRAM_DISABLE: 'telegram:disable',
  TELEGRAM_STATUS: 'telegram:status',

  // Files (managed buckets at <userData>/files)
  FILES_PICK_FILES: 'files:pick-files',
  FILES_IMPORT_TO_BUCKET: 'files:import-to-bucket',
  FILES_DELETE_MANAGED: 'files:delete-managed',
  FILES_DELETE_MANAGED_BATCH: 'files:delete-managed-batch',
  FILES_PREVIEW_URL: 'files:preview-url',
  FILES_COPY_MANAGED: 'files:copy-managed',
  FILES_REVEAL: 'files:reveal',
  FILES_OPEN: 'files:open',
  FILES_DOWNLOAD: 'files:download',
  FILES_READ_MANAGED_TEXT: 'files:read-managed-text',
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

  // Task mode
  runType?: 'chat' | 'task';
  taskPhase?: 'plan' | 'execute' | 'follow_up' | 'direct';
  maxTurns?: number;
  maxPhases?: number;
  maxClarifyQuestions?: number;
  runIdOverride?: string;
  workspacePath?: string;
  clarificationAnswers?: string;
  model?: string;
  followUpContext?: string;
}

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'system'; message: string; subtype?: string }
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

// --- Sandbox ---

export interface SandboxAPI {
  pickDirectory(): Promise<string | null>;
  revealWorkspace(workspacePath: string): Promise<void>;
  getProfile(): Promise<string>;
  /** Push a freshly-fetched config into the main-process cache after a mutation. */
  setCache(config: import('../sandbox/types').SandboxConfig): Promise<void>;
}

// --- Telegram bridge ---

export interface TelegramVerifyResponse {
  ok: boolean;
  username?: string;
  botId?: number;
  error?: string;
}

export interface TelegramStatusResponse {
  running: boolean;
  lastPollAt: number | null;
  lastError: string | null;
  unknownLastAttempt: Record<string, number>;
}

export interface TelegramAPI {
  verify(token: string): Promise<TelegramVerifyResponse>;
  enable(): Promise<{ ok: boolean; error?: string }>;
  disable(): Promise<void>;
  status(): Promise<TelegramStatusResponse>;
}

// --- Files (managed buckets) ---

export interface FilesImportArgs {
  sourcePath: string;     // absolute path on disk
  bucketId: string;       // destination bucket id (used as subdir)
  fileId: string;         // pre-allocated id, becomes the on-disk basename
  destExt: string;        // lowercased ext (no dot), preserved on disk
}

export interface FilesImportResult {
  destRelPath: string;    // relative to <userData>/files
  sha256: string;         // hex
  sizeBytes: number;
  mime: string | null;    // best-effort guess
}

export interface FilesCopyArgs {
  srcRelPath: string;     // relative to <userData>/files
  destBucketId: string;
  destFileId: string;
  destExt: string;
}

export interface FilesAPI {
  /** Open a multi-select file picker. Returns absolute paths or empty array if cancelled. */
  pickFiles(): Promise<string[]>;
  /** Stream-copy a file from anywhere on disk into <userData>/files/<bucketId>/<fileId>.<ext>.
   *  Computes SHA-256 during the copy. Does NOT touch the database — caller follows
   *  up with POST /files/items. */
  importToBucket(args: FilesImportArgs): Promise<FilesImportResult>;
  /** Duplicate a managed file's bytes to a new managed location. */
  copyManaged(args: FilesCopyArgs): Promise<FilesImportResult>;
  /** Unlink the bytes for a single managed file. Path is relative to <userData>/files. */
  deleteManaged(relPath: string): Promise<void>;
  /** Unlink bytes for many managed files at once. Used by Empty Trash. */
  deleteManagedBatch(relPaths: string[]): Promise<void>;
  /** Build a renderer-loadable URL (cerebro-files:// for managed; cerebro-workspace:// for workspace files). */
  previewUrl(args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }): Promise<string>;
  /** Reveal a managed (rel) or workspace (abs) file in Finder. */
  reveal(args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }): Promise<void>;
  /** Open a managed (rel) or workspace (abs) file with the OS default app. */
  open(args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }): Promise<void>;
  /** Copy to ~/Downloads. Returns the final dest path. */
  download(args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }): Promise<string>;
  /** Read a managed file as text (2 MB cap), used by the markdown/text preview. */
  readManagedText(relPath: string): Promise<string>;
}

// --- Preload API exposed on window.cerebro ---

export interface CerebroAPI {
  invoke<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>>;
  getStatus(): Promise<BackendStatus>;
  startStream(request: StreamRequest): Promise<string>;
  cancelStream(streamId: string): Promise<void>;
  onStream(streamId: string, callback: (event: StreamEvent) => void): () => void;
  getPathForFile(file: File): string;
  agent: AgentAPI;
  engine: EngineAPI;
  scheduler: SchedulerAPI;
  claudeCode: ClaudeCodeAPI;
  installer: InstallerAPI;
  voice: VoiceAPI;
  taskTerminal: TaskTerminalAPI;
  shell: ShellAPI;
  sandbox: SandboxAPI;
  telegram: TelegramAPI;
  files: FilesAPI;
}

export interface ShellStatResult {
  exists: boolean;
  isDirectory: boolean;
  size: number;
}

export interface ShellAPI {
  openPath(filePath: string): Promise<void>;
  revealPath(filePath: string): Promise<void>;
  statPath(filePath: string): Promise<ShellStatResult>;
  /** Copy a regular file to the user's OS Downloads folder, deduping on collision.
   *  Returns the final destination path. Throws if source is missing or a directory. */
  downloadToDownloads(filePath: string): Promise<string>;
  /** Read a UTF-8 text file from disk. Refuses files larger than the main-process
   *  size guard (currently 2 MB) so the renderer can surface a friendly toast. */
  readTextFile(filePath: string): Promise<string>;
}

export interface TaskTerminalAPI {
  /** Subscribe to ALL PTY data globally (Turbo pattern — single channel). */
  onGlobalData(callback: (runId: string, data: string) => void): () => void;
  onData(runId: string, callback: (data: string) => void): () => void;
  resize(runId: string, cols: number, rows: number): void;
  /** Forward user keystrokes to the PTY's stdin. */
  sendInput(runId: string, data: string): void;
  /** Load the persisted terminal buffer for a run from disk. Returns null if none. */
  readBuffer(runId: string): Promise<string | null>;
  /** Delete the persisted terminal buffer for a run. */
  removeBuffer(runId: string): Promise<void>;

  /** Create an isolated workspace directory for a task. Returns absolute path. */
  createWorkspace(taskId: string): Promise<string>;
  /** Return derived workspace path without creating it. */
  getWorkspacePath(taskId: string): Promise<string>;
  /** Recursively list files in the workspace as a tree. Pass an explicit path to list an external project folder. */
  listFiles(taskId: string, overridePath?: string): Promise<WorkspaceFileNode[]>;
  /** Read a file from the workspace as text (1MB cap). */
  readFile(taskId: string, relativePath: string): Promise<string | null>;
  /** Remove the workspace directory when a task is deleted. */
  removeWorkspace(taskId: string): Promise<void>;
}

export interface WorkspaceFileNode {
  name: string;
  path: string; // relative to workspace root
  type: 'dir' | 'file';
  size?: number;
  mtime?: number;
  children?: WorkspaceFileNode[];
}
