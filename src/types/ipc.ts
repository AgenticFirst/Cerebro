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

  // Chat actions catalog (renderer → main; the run path is HTTP from the chat subprocess)
  CHAT_ACTIONS_CATALOG: 'chat-actions:catalog',
  /** Renderer → main: generate a short conversation title from the first user
   *  message (and optionally the first assistant response) via Claude Code.
   *  Resolves to the generated title string, or null on any failure. */
  CHAT_GENERATE_TITLE: 'chat:generate-title',
  /** Main → renderer: chat agent proposed an integration setup card.
   *  Payload: IntegrationProposalEventPayload. */
  INTEGRATION_PROPOSAL: 'chat-actions:integration-proposal',
  /** Main → renderer: chat agent announced a team run starting. The renderer
   *  populates the TeamRunCard with members in `queued` so the user has a
   *  live status surface during the (potentially multi-minute) run.
   *  Payload: TeamRunAnnouncedEventPayload. */
  TEAM_RUN_ANNOUNCED: 'chat-actions:team-run-announced',
  /** Main → renderer: per-member status update emitted by the team
   *  coordinator subprocess as it starts/finishes each member.
   *  Payload: TeamMemberUpdateEventPayload. */
  TEAM_MEMBER_UPDATE: 'chat-actions:team-member-update',

  // Scheduler
  SCHEDULER_SYNC: 'scheduler:sync',

  // Claude Code
  CLAUDE_CODE_DETECT: 'claude-code:detect',
  CLAUDE_CODE_STATUS: 'claude-code:status',
  CLAUDE_CODE_INSTALL: 'claude-code:install',
  CLAUDE_CODE_INSTALL_CANCEL: 'claude-code:install-cancel',
  /** Main → renderer: live stdout/stderr lines from the running install
   *  script. One event per buffered chunk. */
  CLAUDE_CODE_INSTALL_LOG: 'claude-code:install-log',
  CLAUDE_CODE_PROBE_AUTH: 'claude-code:probe-auth',
  /** Open a host terminal running `claude` so the user can complete the
   *  sign-in flow without leaving the app. Used by the auth-error
   *  recovery card in chat. */
  CLAUDE_CODE_OPEN_LOGIN: 'claude-code:open-login',

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
  // Plain shell session (Hard reset → drop into a normal terminal in the task cwd,
  // reusing the same TASK_TERMINAL_DATA/INPUT/RESIZE transport keyed by sessionKey).
  SHELL_SESSION_START: 'shell-session:start',
  SHELL_SESSION_STOP: 'shell-session:stop',

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
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  SHELL_REVEAL_PATH: 'shell:reveal-path',
  SHELL_STAT_PATH: 'shell:stat-path',
  SHELL_DOWNLOAD_TO_DOWNLOADS: 'shell:download-to-downloads',
  SHELL_READ_TEXT_FILE: 'shell:read-text-file',
  SHELL_PREVIEW_URL_FOR_PATH: 'shell:preview-url-for-path',
  SHELL_IS_PATH_PREVIEWABLE: 'shell:is-path-previewable',

  // Telegram bridge
  TELEGRAM_VERIFY: 'telegram:verify',
  TELEGRAM_ENABLE: 'telegram:enable',
  TELEGRAM_DISABLE: 'telegram:disable',
  TELEGRAM_STATUS: 'telegram:status',
  TELEGRAM_RELOAD: 'telegram:reload',
  TELEGRAM_SET_TOKEN: 'telegram:set-token',
  TELEGRAM_CLEAR_TOKEN: 'telegram:clear-token',
  /** Pushed from main → renderer whenever the bridge persists a message into a
   *  conversation (inbound user message OR final assistant reply), so the chat
   *  UI can refresh that conversation in real time. */
  TELEGRAM_CONVERSATION_UPDATED: 'telegram:conversation-updated',

  // Slack bridge (Bolt / Socket Mode)
  SLACK_VERIFY: 'slack:verify',
  SLACK_ENABLE: 'slack:enable',
  SLACK_DISABLE: 'slack:disable',
  SLACK_STATUS: 'slack:status',
  SLACK_RELOAD: 'slack:reload',
  SLACK_SET_TOKENS: 'slack:set-tokens',
  SLACK_CLEAR_TOKENS: 'slack:clear-tokens',
  SLACK_SET_ALLOWLIST: 'slack:set-allowlist',
  SLACK_GET_MANIFEST: 'slack:get-manifest',
  /** Main → renderer whenever the bridge persists a message into a Slack
   *  conversation (inbound user OR final assistant reply). Lets the chat
   *  UI refresh that conversation in real time. */
  SLACK_CONVERSATION_UPDATED: 'slack:conversation-updated',

  // WhatsApp bridge (Baileys / WhatsApp Web)
  WHATSAPP_START_PAIRING: 'whatsapp:start-pairing',
  WHATSAPP_CANCEL_PAIRING: 'whatsapp:cancel-pairing',
  WHATSAPP_CLEAR_SESSION: 'whatsapp:clear-session',
  WHATSAPP_STATUS: 'whatsapp:status',
  WHATSAPP_SET_ALLOWLIST: 'whatsapp:set-allowlist',
  WHATSAPP_ENABLE: 'whatsapp:enable',
  WHATSAPP_DISABLE: 'whatsapp:disable',
  WHATSAPP_STATUS_CHANGED: 'whatsapp:status-changed',
  WHATSAPP_CONVERSATION_UPDATED: 'whatsapp:conversation-updated',

  // HubSpot CRM
  HUBSPOT_VERIFY: 'hubspot:verify',
  HUBSPOT_LIST_PIPELINES: 'hubspot:list-pipelines',
  HUBSPOT_STATUS: 'hubspot:status',
  HUBSPOT_SET_TOKEN: 'hubspot:set-token',
  HUBSPOT_CLEAR_TOKEN: 'hubspot:clear-token',
  HUBSPOT_SET_DEFAULTS: 'hubspot:set-defaults',

  // GoHighLevel CRM
  GHL_VERIFY: 'ghl:verify',
  GHL_STATUS: 'ghl:status',
  GHL_SET_CREDENTIALS: 'ghl:set-credentials',
  GHL_CLEAR_CREDENTIALS: 'ghl:clear-credentials',

  // GitHub
  GITHUB_VERIFY: 'github:verify',
  GITHUB_STATUS: 'github:status',
  GITHUB_SET_TOKEN: 'github:set-token',
  GITHUB_CLEAR_TOKEN: 'github:clear-token',
  GITHUB_LIST_REPOS: 'github:list-repos',
  GITHUB_LIST_WATCHED_REPOS: 'github:list-watched-repos',
  GITHUB_SET_WATCHED_REPOS: 'github:set-watched-repos',
  GITHUB_STATUS_CHANGED: 'github:status-changed',

  // App auto-updater (GitHub Releases)
  UPDATE_CHECK_NOW: 'update:check-now',
  /** Renderer → main: download the artifact to a persistent location.
   *  Does NOT install; the app keeps running until the user clicks Restart. */
  UPDATE_DOWNLOAD: 'update:download',
  /** Renderer → main: install the previously-downloaded artifact and
   *  restart. For Linux AppImage this replaces the running binary atomically
   *  with rollback if launch verification fails. Throws if the new version
   *  cannot start, leaving the current install untouched. */
  UPDATE_APPLY: 'update:apply',
  UPDATE_DISMISS: 'update:dismiss',
  /** Renderer → main: "I received UPDATE_AVAILABLE and showed the banner."
   *  Suppresses the 5s native-dialog fallback. */
  UPDATE_NOTIFIED: 'update:notified',
  UPDATE_OPEN_RELEASE_PAGE: 'update:open-release-page',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_DOWNLOAD_PROGRESS: 'update:download-progress',
  /** Main → renderer: artifact has been downloaded and is ready to install.
   *  The renderer should show a "Restart to apply" affordance — install does
   *  not happen automatically. */
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_ERROR: 'update:error',

  // Files (managed buckets at <userData>/files)
  FILES_PICK_FILES: 'files:pick-files',
  FILES_IMPORT_TO_BUCKET: 'files:import-to-bucket',
  FILES_IMPORT_TO_TASK: 'files:import-to-task',
  FILES_DELETE_MANAGED: 'files:delete-managed',
  FILES_DELETE_MANAGED_BATCH: 'files:delete-managed-batch',
  FILES_PREVIEW_URL: 'files:preview-url',
  FILES_COPY_MANAGED: 'files:copy-managed',
  FILES_REVEAL: 'files:reveal',
  FILES_OPEN: 'files:open',
  FILES_DOWNLOAD: 'files:download',
  FILES_READ_MANAGED_TEXT: 'files:read-managed-text',

  // Backup & restore (one-file export of all userData; one-click restore)
  BACKUP_PICK_EXPORT_PATH: 'backup:pick-export-path',
  BACKUP_PICK_IMPORT_FILE: 'backup:pick-import-file',
  BACKUP_APPLY_AND_RELAUNCH: 'backup:apply-and-relaunch',
  BACKUP_RELAUNCH: 'backup:relaunch',
  BACKUP_CONSUME_COMPLETION_FLAG: 'backup:consume-completion-flag',
  BACKUP_REVEAL_PATH: 'backup:reveal-path',
  BACKUP_APP_VERSION: 'backup:app-version',
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

export const QUALITY_TIERS = ['fast', 'medium', 'slow'] as const;
export type QualityTier = typeof QUALITY_TIERS[number];

export const RESPONSE_MODELS = ['haiku', 'sonnet', 'opus'] as const;
export type ResponseModel = typeof RESPONSE_MODELS[number];

export const TEAM_MEMBER_STATUSES = ['running', 'completed', 'error'] as const;
export type TeamMemberStatus = typeof TEAM_MEMBER_STATUSES[number];

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
  /** UI language code ("es"). Forwarded by ChatContext to drive the
   *  language directive appended to the system prompt. */
  language?: string;
  /** Quality vs. speed tier picked from the chat input chip. Drives default
   *  model + maxTurns and a system-prompt suffix that branches Cerebro vs
   *  expert behavior. Untouched explicit `model`/`maxTurns` overrides win. */
  qualityTier?: QualityTier;
}

/** Class hint set on `error` events so the chat UI can render a
 *  class-specific recovery affordance (e.g. an inline "Sign in to
 *  Claude Code" card for `auth`). Mirrors `AgentErrorClass` in
 *  `agents/types.ts`; duplicated here so renderer files don't need
 *  to reach into the agent-runtime types graph. */
export type AgentErrorClass =
  | 'auth'
  | 'max_turns'
  | 'context'
  | 'overload'
  | 'cancelled'
  | 'spawn'
  | 'session_missing'
  | 'unknown';

/** Parsed `<deliverable kind="…" title="…">BODY</deliverable>` block extracted
 * from a task run's final output. Attached to the `done` event so the renderer
 * can both persist it on the task row and render it in Vista previa. */
export interface ParsedDeliverable {
  kind: 'markdown' | 'code_app' | 'mixed';
  title: string;
  body: string;
}

/** Backend `/tasks/{id}/run-event` payload fragment carrying the parsed
 * deliverable. Built once and POSTed from both the renderer (TaskContext) and
 * the main-process backup path (finalizeRun) — keep the two call sites in
 * sync via this builder rather than open-coding the shape twice. */
export function buildDeliverablePayload(
  deliverable: ParsedDeliverable | null | undefined,
): { result_md: string; result_title: string | null; result_kind: ParsedDeliverable['kind'] } | Record<string, never> {
  if (!deliverable) return {};
  return {
    result_md: deliverable.body,
    result_title: deliverable.title || null,
    result_kind: deliverable.kind,
  };
}

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'system'; message: string; subtype?: string }
  | { type: 'done'; runId: string; messageContent: string; deliverable?: ParsedDeliverable | null }
  | { type: 'error'; runId: string; error: string; errorClass?: AgentErrorClass };

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

export interface ClaudeCodeInstallResult {
  /** True iff the script exited 0 AND post-install detection found `claude`. */
  ok: boolean;
  /** Process exit code (or -1 if killed). */
  exitCode: number;
  /** Last ~2 KB of combined stderr/stdout, useful for inline error display. */
  outputTail: string;
  /** Detection result run AFTER the install attempt. */
  info: ClaudeCodeInfo;
}

export interface ClaudeCodeProbeResult {
  ok: boolean;
  /** When ok=false, why we think the probe failed. Populated from stderr or
   *  a "timed out" sentinel — purely diagnostic. */
  reason?: string;
}

export interface ClaudeCodeAPI {
  detect(): Promise<ClaudeCodeInfo>;
  getStatus(): Promise<ClaudeCodeInfo>;
  /** Spawns Anthropic's official curl install script in a login bash shell.
   *  Streams output lines via `onLog` until the script exits, then resolves
   *  with the install result + a fresh detection. */
  install(onLog: (line: string) => void): Promise<ClaudeCodeInstallResult>;
  /** Sends SIGTERM to the running install (no-op if none in flight). */
  cancelInstall(): Promise<void>;
  /**
   * Runtime auth probe — distinct from `detect()`'s binary-availability
   * check. Spawns `claude -p ping --max-turns 1` with a hard 5s timeout.
   * If the CLI emits stream-json within the deadline, it's authenticated;
   * otherwise we surface a `reason` (stderr tail, "timed out", etc.) so
   * the validator can warn the user before they kick off a routine.
   * Result is cached in main-process memory for 60s to avoid spawning a
   * subprocess per click.
   */
  probeAuth(opts?: { force?: boolean }): Promise<ClaudeCodeProbeResult>;
  /**
   * Open a host terminal running `claude` so the user can complete the
   * sign-in flow (browser handshake) and come back. Called from the
   * chat's auth-error recovery card. The renderer should follow up
   * with a `probeAuth({ force: true })` once the user reports success.
   */
  openLogin(): Promise<{ ok: boolean; reason?: string }>;
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
  botUsername: string | null;
  /** True when a bot token is configured (without revealing the value). */
  hasToken: boolean;
  /** How the token is encrypted at rest. 'os-keychain' on macOS/Windows and
   *  Linux with libsecret; 'plaintext-fallback' otherwise. */
  tokenBackend: 'os-keychain' | 'plaintext-fallback';
}

export interface TelegramConversationUpdatedEvent {
  conversationId: string;
  /** 'created' when a new conversation is being established (first user message
   *  in a chat), 'message' for any subsequent persisted message. */
  kind: 'created' | 'message';
}

export interface TelegramAPI {
  verify(token: string): Promise<TelegramVerifyResponse>;
  enable(): Promise<{ ok: boolean; error?: string }>;
  disable(): Promise<void>;
  status(): Promise<TelegramStatusResponse>;
  reload(): Promise<{ ok: boolean; error?: string }>;
  setToken(token: string): Promise<{ ok: boolean; error?: string }>;
  clearToken(): Promise<{ ok: boolean; error?: string }>;
  /** Returns an unsubscribe function. */
  onConversationUpdated(callback: (event: TelegramConversationUpdatedEvent) => void): () => void;
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

export interface FilesImportToTaskArgs {
  sourcePath: string;     // absolute path on disk
  taskId: string;         // owning task (32-hex)
  fileId: string;         // pre-allocated id, becomes the on-disk basename
  destExt: string;        // lowercased ext (no dot), preserved on disk
}

export interface FilesAPI {
  /** Open a multi-select file picker. Returns absolute paths or empty array if cancelled. */
  pickFiles(): Promise<string[]>;
  /** Stream-copy a file from anywhere on disk into <userData>/files/<bucketId>/<fileId>.<ext>.
   *  Computes SHA-256 during the copy. Does NOT touch the database — caller follows
   *  up with POST /files/items. */
  importToBucket(args: FilesImportArgs): Promise<FilesImportResult>;
  /** Stream-copy a file into <userData>/files/task-attachments/<taskId>/<fileId>.<ext>.
   *  Same shape as importToBucket but without a bucket — used for files attached
   *  to a Kanban task. */
  importToTask(args: FilesImportToTaskArgs): Promise<FilesImportResult>;
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

// --- App auto-updater ---

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
  contentType: string;
}

export interface UpdateInfo {
  version: string;
  name: string;
  notes: string;
  htmlUrl: string;
  asset: UpdateAsset;
}

export interface UpdateDownloadProgress {
  transferred: number;
  total: number;
  percent: number;
}

export interface UpdateDownloadedEvent {
  path: string;
  asset: UpdateAsset;
}

export interface UpdaterAPI {
  checkNow(): Promise<UpdateInfo | null>;
  /** Download the asset to a persistent location (userData/updates/). Does
   *  not install. Rejects if the download fails. */
  download(asset: UpdateAsset): Promise<void>;
  /** Install the previously-downloaded asset and restart. For Linux AppImage
   *  this verifies the new version can launch before quitting the current
   *  process. If the launch verification fails the old install is rolled
   *  back and this rejects — the current app keeps running. */
  apply(asset: UpdateAsset): Promise<void>;
  dismiss(): Promise<void>;
  /** Renderer tells main "the banner is on screen" so the native
   *  dialog fallback doesn't fire. Fire-and-forget. */
  notified(): Promise<void>;
  openReleasePage(url: string): Promise<void>;
  onAvailable(callback: (info: UpdateInfo) => void): () => void;
  onProgress(callback: (progress: UpdateDownloadProgress) => void): () => void;
  onDownloaded(callback: (event: UpdateDownloadedEvent) => void): () => void;
  onError(callback: (message: string) => void): () => void;
}

// --- Preload API exposed on window.cerebro ---

export interface ChatActionCatalogEntry {
  type: string;
  label: string;
  description: string;
  examples: string[];
  availability: 'available' | 'not_connected' | 'unavailable';
  group: string;
  setupHref?: string;
  inputSchema: Record<string, unknown>;
}

export interface IntegrationProposalEventPayload {
  integrationId: string;
  reason?: string;
  /** Conversation the chat agent was running in. When omitted, the
   *  renderer falls back to the active conversation. */
  conversationId?: string;
}

export interface TeamRunAnnouncedMember {
  memberId: string;
  memberName: string;
  role: string;
}

export interface TeamRunAnnouncedEventPayload {
  teamId: string;
  teamName: string;
  strategy: string;
  members: TeamRunAnnouncedMember[];
  /** Conversation the chat agent was running in. When omitted, the
   *  renderer falls back to the active conversation. */
  conversationId?: string;
}

export interface TeamMemberUpdateEventPayload {
  teamId: string;
  memberId: string;
  status: TeamMemberStatus;
  /** Optional one-line message when status === 'error'. */
  errorMessage?: string;
  /** Conversation the chat agent was running in. When omitted, the
   *  renderer falls back to the active conversation. */
  conversationId?: string;
}

export interface ChatActionsAPI {
  /** Returns the chat-exposable action catalog with current availability.
   *  Lang controls localization of label/description/examples (en|es). */
  catalog(lang: 'en' | 'es'): Promise<ChatActionCatalogEntry[]>;
  /** Subscribe to integration-setup proposal events fired when the chat
   *  agent calls the propose-integration script. Returns an unsubscribe
   *  function. */
  onIntegrationProposal(
    callback: (payload: IntegrationProposalEventPayload) => void,
  ): () => void;
  /** Subscribe to team-run announcements emitted by Cerebro before it
   *  invokes a team via the Agent tool. Returns unsubscribe. */
  onTeamRunAnnounced(
    callback: (payload: TeamRunAnnouncedEventPayload) => void,
  ): () => void;
  /** Subscribe to per-member status updates emitted by the team
   *  coordinator. Returns unsubscribe. */
  onTeamMemberUpdate(
    callback: (payload: TeamMemberUpdateEventPayload) => void,
  ): () => void;
  /** Generate a short conversation title from the first user message and,
   *  optionally, the first assistant response. Resolves to a sanitised title
   *  string, or null if Claude Code is unavailable or the call fails. */
  generateTitle(args: {
    userMessage: string;
    assistantResponse?: string;
  }): Promise<string | null>;
}

export interface BackupCompletionFlag {
  rollback_id: string;
  applied_at: string;
  is_undo: boolean;
  contents: string[];
}

export interface BackupAPI {
  /** Open a save dialog filtered to `.cerebro-backup`. Returns the chosen path or null. */
  pickExportPath(defaultName: string): Promise<string | null>;
  /** Open a file dialog filtered to `.cerebro-backup`. Returns the picked path or null. */
  pickImportFile(): Promise<string | null>;
  /**
   * Tell the backend to snapshot current state, stage the backup, and write
   * the pending-restore marker. Then relaunch the app so the swap happens
   * with no live DB connection holding the file open.
   */
  applyAndRelaunch(backupPath: string): Promise<void>;
  /**
   * Relaunch with no backend round-trip. Used by the undo flow after
   * `/backup/undo` has already staged the rollback.
   */
  relaunch(): Promise<void>;
  /** Return + clear the one-shot "restore complete" flag set on the last boot. */
  consumeCompletionFlag(): Promise<BackupCompletionFlag | null>;
  /** Reveal a backup file in Finder/Explorer. Quietly no-ops on a stale path. */
  revealPath(filePath: string): Promise<void>;
  /** Cerebro version (from package.json) so the backend can stamp it into manifests. */
  appVersion(): Promise<string>;
}

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
  slack: SlackAPI;
  whatsapp: WhatsAppAPI;
  hubspot: HubSpotAPI;
  ghl: GHLAPI;
  github: GitHubAPI;
  chatActions: ChatActionsAPI;
  files: FilesAPI;
  updater: UpdaterAPI;
  backup: BackupAPI;
}

// --- Slack bridge (Bolt / Socket Mode) ---

export interface SlackVerifyResponse {
  ok: boolean;
  teamName?: string;
  teamId?: string;
  botUserId?: string;
  error?: string;
}

export interface SlackStatusResponse {
  running: boolean;
  /** ms timestamp of the last observed Slack event (any envelope). */
  lastEventAt: number | null;
  lastError: string | null;
  /** Slack workspace name reported by auth.test, when known. */
  teamName: string | null;
  /** Bot user id (`U…`) reported by auth.test. */
  botUserId: string | null;
  hasBotToken: boolean;
  hasAppToken: boolean;
  /** Configured-on flag. Independent of `running`. */
  enabled: boolean;
  allowlistChannels: string[];
  allowlistUsers: string[];
  tokenBackend: 'os-keychain' | 'plaintext-fallback';
}

export interface SlackConversationUpdatedEvent {
  conversationId: string;
  kind: 'created' | 'message';
}

export interface SlackAPI {
  verify(botToken: string, appToken: string): Promise<SlackVerifyResponse>;
  enable(): Promise<{ ok: boolean; error?: string }>;
  disable(): Promise<void>;
  status(): Promise<SlackStatusResponse>;
  reload(): Promise<{ ok: boolean; error?: string }>;
  setTokens(tokens: { botToken: string; appToken: string }): Promise<{ ok: boolean; error?: string }>;
  clearTokens(): Promise<{ ok: boolean; error?: string }>;
  setAllowlist(args: { channels: string[]; users: string[] }): Promise<{ ok: boolean; error?: string }>;
  /** Returns the shipped manifest YAML so the renderer can copy it to the
   *  clipboard or pipe it to api.slack.com's "create from manifest" URL. */
  getManifest(): Promise<{ ok: boolean; yaml?: string; error?: string }>;
  onConversationUpdated(callback: (event: SlackConversationUpdatedEvent) => void): () => void;
}

// --- WhatsApp bridge (Baileys) ---

export interface WhatsAppStatusResponse {
  state: 'off' | 'pairing' | 'connecting' | 'connected' | 'error';
  phoneNumber: string | null;
  pushName: string | null;
  qr: string | null;
  lastError: string | null;
  lastConnectedAt: number | null;
  credsBackend: 'os-keychain' | 'plaintext-fallback';
  hasCreds: boolean;
}

export interface WhatsAppConversationUpdatedEvent {
  conversationId: string;
  kind: 'created' | 'message';
}

export interface WhatsAppAPI {
  startPairing(): Promise<{ ok: boolean; error?: string }>;
  cancelPairing(): Promise<void>;
  clearSession(): Promise<{ ok: boolean; error?: string }>;
  status(): Promise<WhatsAppStatusResponse>;
  setAllowlist(list: string[]): Promise<{ ok: boolean; error?: string }>;
  enable(): Promise<{ ok: boolean; error?: string }>;
  disable(): Promise<void>;
  onStatusChanged(callback: (status: WhatsAppStatusResponse) => void): () => void;
  onConversationUpdated(callback: (event: WhatsAppConversationUpdatedEvent) => void): () => void;
}

// --- HubSpot CRM ---

export interface HubSpotPipelineSummary {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string; displayOrder: number }>;
}

export interface HubSpotStatusResponse {
  hasToken: boolean;
  portalId: string | null;
  defaultPipeline: string | null;
  defaultStage: string | null;
  tokenBackend: 'os-keychain' | 'plaintext-fallback';
}

export interface HubSpotVerifyResult {
  ok: boolean;
  portalId?: string | null;
  error?: string;
}

export interface HubSpotAPI {
  verify(token: string): Promise<HubSpotVerifyResult>;
  listPipelines(): Promise<{ ok: boolean; pipelines?: HubSpotPipelineSummary[]; error?: string }>;
  status(): Promise<HubSpotStatusResponse>;
  setToken(token: string): Promise<{ ok: boolean; error?: string }>;
  clearToken(): Promise<{ ok: boolean; error?: string }>;
  setDefaults(defaults: { pipeline: string | null; stage: string | null }): Promise<{ ok: boolean; error?: string }>;
}

// --- GoHighLevel CRM ---

export interface GHLStatusResponse {
  hasApiKey: boolean;
  locationId: string | null;
  tokenBackend: 'os-keychain' | 'plaintext-fallback';
}

export interface GHLVerifyResult {
  ok: boolean;
  locationId?: string | null;
  error?: string;
}

export interface GHLAPI {
  verify(apiKey: string, locationId: string): Promise<GHLVerifyResult>;
  status(): Promise<GHLStatusResponse>;
  setCredentials(apiKey: string, locationId: string): Promise<{ ok: boolean; error?: string }>;
  clearCredentials(): Promise<{ ok: boolean; error?: string }>;
}

// --- GitHub ---

export interface GitHubRepoSummary {
  /** "owner/repo" */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

export interface GitHubVerifyResult {
  ok: boolean;
  /** Authenticated user's login (e.g. "octocat"). Used to detect review-requested events. */
  login?: string | null;
  error?: string;
}

export interface GitHubStatusResponse {
  hasToken: boolean;
  login: string | null;
  watchedRepos: string[];
  /** Last successful poll timestamp (ms since epoch), null if never. */
  lastPollAt: number | null;
  /** Last poll error (if any). */
  lastError: string | null;
  /** GitHub primary rate-limit remaining from the last call. */
  rateLimitRemaining: number | null;
  tokenBackend: 'os-keychain' | 'plaintext-fallback';
}

export interface GitHubAPI {
  verify(token: string): Promise<GitHubVerifyResult>;
  status(): Promise<GitHubStatusResponse>;
  setToken(token: string): Promise<{ ok: boolean; error?: string }>;
  clearToken(): Promise<{ ok: boolean; error?: string }>;
  /** Enumerate repos the current token can see (for the watched-repo picker). */
  listRepos(): Promise<{ ok: boolean; repos?: GitHubRepoSummary[]; error?: string }>;
  /** Read the user's persisted watched-repo allowlist ("owner/repo" entries). */
  listWatchedRepos(): Promise<{ ok: boolean; repos?: string[]; error?: string }>;
  /** Replace the watched-repo allowlist. */
  setWatchedRepos(repos: string[]): Promise<{ ok: boolean; error?: string }>;
  onStatusChanged(callback: (status: GitHubStatusResponse) => void): () => void;
}

export interface ShellStatResult {
  exists: boolean;
  isDirectory: boolean;
  size: number;
}

export interface ShellAPI {
  openPath(filePath: string): Promise<void>;
  /** Open an http/https URL in the user's default browser (NOT a new
   *  Electron window). Refuses non-http(s) schemes. */
  openExternal(url: string): Promise<void>;
  revealPath(filePath: string): Promise<void>;
  statPath(filePath: string): Promise<ShellStatResult>;
  /** Copy a regular file to the user's OS Downloads folder, deduping on collision.
   *  Returns the final destination path. Throws if source is missing or a directory. */
  downloadToDownloads(filePath: string): Promise<string>;
  /** Read a UTF-8 text file from disk. Refuses files larger than the main-process
   *  size guard (currently 2 MB) so the renderer can surface a friendly toast. */
  readTextFile(filePath: string): Promise<string>;
  /** Build a `cerebro-chat://path/<base64url>` URL for an arbitrary absolute path.
   *  The protocol handler re-validates the path against a SAFE-ROOTS allowlist
   *  (userData / downloads / documents / desktop / tmp). Throws 'outside-safe-roots'
   *  for anything outside; 'not-absolute' if the input isn't absolute. */
  previewUrlForPath(absolutePath: string): Promise<string>;
  /** True when the absolute path lives inside the chat-preview SAFE-ROOTS list.
   *  Used to pick the binary fallback before issuing a forbidden fetch. */
  isPathPreviewable(absolutePath: string): Promise<boolean>;
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

  /**
   * Create an isolated workspace directory for a task. Returns absolute path.
   * `taskId` is the raw 32-hex DB id (used to detect any pre-migration folder
   * to rename in place); `workspaceDir` is the human-readable on-disk name.
   */
  createWorkspace(args: { taskId: string; workspaceDir: string }): Promise<string>;
  /** Return derived workspace path without creating it. */
  getWorkspacePath(workspaceDir: string): Promise<string>;
  /** Recursively list files in the workspace as a tree. Pass an explicit path to list an external project folder. */
  listFiles(workspaceDir: string, overridePath?: string): Promise<WorkspaceFileNode[]>;
  /** Read a file from the workspace as text (1MB cap). */
  readFile(workspaceDir: string, relativePath: string): Promise<string | null>;
  /** Remove the workspace directory when a task is deleted. */
  removeWorkspace(workspaceDir: string): Promise<void>;

  /**
   * Spawn a plain login shell (zsh/bash) PTY that streams/accepts input on the
   * shared TASK_TERMINAL_DATA/INPUT/RESIZE channels keyed by `sessionKey`.
   * Used by the task drawer's "Hard reset" flow so the user lands in a real
   * terminal inside the task's workspace and can paste `claude --resume <id>`.
   */
  startShellSession(sessionKey: string, cwd: string, cols: number, rows: number): Promise<void>;
  /** Kill the shell session spawned by startShellSession. Safe to call if already stopped. */
  stopShellSession(sessionKey: string): Promise<void>;
}

export interface WorkspaceFileNode {
  name: string;
  path: string; // relative to workspace root
  type: 'dir' | 'file';
  size?: number;
  mtime?: number;
  children?: WorkspaceFileNode[];
}
