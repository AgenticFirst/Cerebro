import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import started from 'electron-squirrel-startup';

// Enable remote debugging for E2E tests (Playwright connects via CDP)
if (process.env.CEREBRO_E2E_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CEREBRO_E2E_DEBUG_PORT);
}
import { IPC_CHANNELS } from './types/ipc';
import type {
  BackendRequest,
  BackendResponse,
  BackendStatus,
  StreamRequest,
  StreamEvent,
} from './types/ipc';
import { AgentRuntime } from './agents';
import type { AgentRunRequest } from './agents';
import { ExecutionEngine } from './engine/engine';
import type { EngineRunRequest } from './engine/dag/types';
import { RoutineScheduler } from './scheduler/scheduler';
import { TaskReconciler } from './scheduler/task-reconciler';
import { detectClaudeCode, getCachedClaudeCodeInfo } from './claude-code/detector';
import {
  installAll,
  installExpert,
  removeExpert,
  writeRuntimeInfo,
  migrateLegacyContextFiles,
} from './claude-code/installer';
import { setClaudeCodeCwd } from './claude-code/single-shot';
import { VoiceSessionManager } from './voice/session';
import { TelegramBridge } from './telegram/bridge';
import { registerChannelSender, unregisterChannelSender } from './engine/actions/channel';
import { initializeSandbox } from './sandbox/initialize';
import { getCachedSandboxConfig, setCachedSandboxConfig } from './sandbox/config-cache';
import { generateProfile } from './sandbox/profile-generator';
import type { SandboxConfig } from './sandbox/types';

// Voice session manager (initialized after backend is healthy)
let voiceSession: VoiceSessionManager | null = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Register privileged schemes BEFORE app is ready.
// - cerebro-workspace:// serves files from per-task workspaces for live preview.
// - cerebro-files://     serves managed bucket files (image thumbnails, html previews).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cerebro-workspace',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'cerebro-files',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Helper: resolve the base directory for a task's workspace
function getTaskWorkspaceDir(taskId: string): string {
  return path.join(app.getPath('userData'), 'task-workspaces', taskId);
}

// Helper: root directory holding all managed bucket files
function getFilesRoot(): string {
  return path.join(app.getPath('userData'), 'files');
}

// Resolve a managed file's relative path to an absolute path, refusing
// any traversal that would escape the files root.
function resolveManagedPath(relPath: string): string {
  const root = getFilesRoot();
  const abs = path.normalize(path.join(root, relPath));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Refusing path outside files root: ${relPath}`);
  }
  return abs;
}

// Minimal MIME-type map for files served via cerebro-workspace://
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.avif': 'image/avif',
};
function mimeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// --- Python backend state ---
let pythonProcess: ChildProcess | null = null;
let backendPort: number | null = null;
let backendStatus: BackendStatus = 'stopped';
let isIntentionalShutdown = false;
let restartCount = 0;
const MAX_RESTARTS = 3;

// Active SSE streams (streamId → http.ClientRequest)
const activeStreams = new Map<string, http.ClientRequest>();

// Agent runtime (initialized after backend is healthy)
let agentRuntime: AgentRuntime | null = null;

// Execution engine (initialized after backend is healthy)
let executionEngine: ExecutionEngine | null = null;

// Routine scheduler (initialized after execution engine)
let routineScheduler: RoutineScheduler | null = null;
let taskReconciler: TaskReconciler | null = null;

// Shared event bus for cross-subsystem engine events (Telegram bridge subscribes).
const engineEventBus = new EventEmitter();
engineEventBus.setMaxListeners(50);

// Telegram bridge (initialized after backend is healthy)
let telegramBridge: TelegramBridge | null = null;

// --- Utility functions ---

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to get free port')));
      }
    });
    server.on('error', reject);
  });
}

function resolvePythonPath(): string {
  const isWin = process.platform === 'win32';
  const venvPython = isWin
    ? path.join(app.getAppPath(), 'backend', 'venv', 'Scripts', 'python.exe')
    : path.join(app.getAppPath(), 'backend', 'venv', 'bin', 'python');

  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  // Fall back to system Python
  return isWin ? 'python' : 'python3';
}

function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForHealthCheck(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = 15_000;
    const interval = 200;
    const start = Date.now();

    const poll = async () => {
      if (Date.now() - start > timeout) {
        reject(new Error('Backend health check timed out after 15s'));
        return;
      }
      const healthy = await checkHealth(port);
      if (healthy) {
        resolve();
      } else {
        setTimeout(poll, interval);
      }
    };

    poll();
  });
}

async function startPythonBackend(): Promise<void> {
  const port = await getFreePort();
  const pythonPath = resolvePythonPath();
  const scriptPath = path.join(app.getAppPath(), 'backend', 'main.py');
  const dataDir = app.getPath('userData');
  const dbPath = path.join(dataDir, 'cerebro.db');
  const agentMemoryDir = path.join(dataDir, 'agent-memory');
  // Voice models are bundled with the app (extraResource in forge config)
  const voiceModelsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'voice-models')
    : path.join(app.getAppPath(), 'voice-models');

  backendStatus = 'starting';
  console.log(`[Cerebro] Starting Python backend on port ${port}...`);
  console.log(`[Cerebro] Python path: ${pythonPath}`);
  console.log(`[Cerebro] Database path: ${dbPath}`);

  const proc = spawn(
    pythonPath,
    [
      scriptPath,
      '--port', String(port),
      '--db-path', dbPath,
      '--agent-memory-dir', agentMemoryDir,
      '--voice-models-dir', voiceModelsDir,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(app.getAppPath(), 'backend'),
      env: process.env,
    },
  );

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line: string) => console.log(`[Python] ${line}`));
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line: string) => console.log(`[Python] ${line}`));
  });

  pythonProcess = proc;
  backendPort = port;

  attachCrashHandler();

  await waitForHealthCheck(port);
  backendStatus = 'healthy';

  // Seed the sandbox config cache before anything that might spawn `claude`.
  // wrap-spawn reads from this cache synchronously — if it's empty the sandbox
  // is off for that run.
  await initializeSandbox({
    cerebroDataDir: dataDir,
    fetchConfig: async () => {
      const res = await makeBackendRequest<SandboxConfig>({ method: 'GET', path: '/sandbox/config' });
      return res.ok ? res.data : null;
    },
  });

  agentRuntime = new AgentRuntime(port, dataDir);
  executionEngine = new ExecutionEngine(port, agentRuntime, engineEventBus);
  routineScheduler = new RoutineScheduler(executionEngine, port);
  taskReconciler = new TaskReconciler(agentRuntime, port);
  voiceSession = new VoiceSessionManager(port, dataDir);

  // Telegram bridge — starts only if the user has configured + enabled it.
  telegramBridge = new TelegramBridge({
    backendPort: port,
    agentRuntime,
    dataDir,
    engineEventBus,
  });
  registerChannelSender('telegram', telegramBridge);
  telegramBridge.start().catch((err) => {
    console.error('[Cerebro] Telegram bridge start failed:', err);
  });

  // Tell singleShotClaudeCode where to spawn `claude` from so it picks up
  // Cerebro's project-scoped subagents and skills.
  setClaudeCodeCwd(dataDir);

  // Refresh the runtime info file (skill scripts read this for the port).
  writeRuntimeInfo(dataDir, port);

  // Sync project-scoped subagents and skills under <dataDir>/.claude/.
  // Requires Claude Code detection to have run first (handled in `app.on('ready')`).
  installAll({ dataDir, backendPort: port })
    .then(() => migrateLegacyContextFiles({ dataDir, backendPort: port }))
    .catch((err) => {
      console.error('[Cerebro] Failed to install Claude Code agents/skills:', err);
    });

  // Recover stale runs from previous session
  makeBackendRequest({ method: 'POST', path: '/engine/runs/recover-stale' }).catch(console.error);

  // Set webContents if window already exists
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    routineScheduler.setWebContents(windows[0].webContents);
    voiceSession.setWebContents(windows[0].webContents);
  }

  // Initial scheduler sync + start periodic re-sync
  routineScheduler.sync().then(() => {
    routineScheduler!.startPeriodicSync();
  }).catch((err) => {
    console.error('[Cerebro] Initial scheduler sync failed:', err);
    // Start periodic sync anyway so it can self-heal
    routineScheduler!.startPeriodicSync();
  });

  // Start the live task reconciler: catches tasks stranded at in_progress
  // when the renderer-mediated run-event POST is dropped (destroyed window,
  // IPC hiccup, renderer crash).
  taskReconciler.start();

  console.log(`[Cerebro] Python backend is ready on port ${port}`);
}

function stopPythonBackend(): Promise<void> {
  return new Promise((resolve) => {
    if (!pythonProcess || pythonProcess.killed) {
      resolve();
      return;
    }

    const proc = pythonProcess;
    const killTimeout = setTimeout(() => {
      if (!proc.killed) {
        console.log('[Cerebro] Force-killing Python backend (SIGKILL)');
        proc.kill('SIGKILL');
      }
    }, 3000);

    proc.once('exit', () => {
      clearTimeout(killTimeout);
      backendStatus = 'stopped';
      console.log('[Cerebro] Python backend stopped');
      resolve();
    });

    proc.kill('SIGTERM');
  });
}

function attachCrashHandler(): void {
  if (!pythonProcess) return;

  pythonProcess.once('exit', (code, signal) => {
    if (isIntentionalShutdown) return;

    backendStatus = 'unhealthy';
    console.log(`[Cerebro] Python backend exited unexpectedly (code=${code}, signal=${signal})`);

    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      console.log(
        `[Cerebro] Restarting Python backend (attempt ${restartCount}/${MAX_RESTARTS})...`,
      );
      startPythonBackend().catch((err) => {
        console.error('[Cerebro] Failed to restart Python backend:', err);
      });
    } else {
      console.error(
        '[Cerebro] Max restart attempts reached. Python backend will not be restarted.',
      );
    }
  });
}

// --- IPC Bridge ---

function makeBackendRequest<T = unknown>(request: BackendRequest): Promise<BackendResponse<T>> {
  return new Promise((resolve) => {
    if (backendPort === null || backendStatus !== 'healthy') {
      resolve({ ok: false, status: 0, data: { error: 'Backend not available' } as T });
      return;
    }

    const url = `http://127.0.0.1:${backendPort}${request.path}`;
    const parsedUrl = new URL(url);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...request.headers,
    };

    const bodyStr = request.body != null ? JSON.stringify(request.body) : undefined;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: request.method,
      headers,
      timeout: request.timeout ?? 30_000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        let parsed: T;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data as T;
        }
        resolve({
          ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode ?? 0,
          data: parsed,
        });
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, status: 0, data: { error: err.message } as T });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, data: { error: 'Request timed out' } as T });
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

function registerIpcHandlers(): void {
  // Generic backend request proxy
  ipcMain.handle(IPC_CHANNELS.BACKEND_REQUEST, async (_event, request: BackendRequest) => {
    return makeBackendRequest(request);
  });

  // Backend status check
  ipcMain.handle(IPC_CHANNELS.BACKEND_STATUS, async () => {
    return backendStatus;
  });

  // Start SSE stream
  ipcMain.handle(IPC_CHANNELS.STREAM_START, async (event, request: StreamRequest) => {
    const streamId = crypto.randomUUID();
    const webContents = event.sender;
    const channel = IPC_CHANNELS.streamEvent(streamId);

    if (backendPort === null || backendStatus !== 'healthy') {
      webContents.send(channel, { event: 'error', data: 'Backend not available' } as StreamEvent);
      webContents.send(channel, { event: 'end', data: '' } as StreamEvent);
      return streamId;
    }

    const url = `http://127.0.0.1:${backendPort}${request.path}`;
    const parsedUrl = new URL(url);

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    };

    const bodyStr = request.body != null ? JSON.stringify(request.body) : undefined;
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: request.method,
      headers,
    };

    const req = http.request(options, (res) => {
      // If the backend returned an HTTP error, collect the body and emit an error event
      if (res.statusCode && res.statusCode >= 400) {
        let errorBody = '';
        res.on('data', (chunk: Buffer) => {
          errorBody += chunk.toString();
        });
        res.on('end', () => {
          activeStreams.delete(streamId);
          if (!webContents.isDestroyed()) {
            let errorMsg = `Backend error (${res.statusCode})`;
            try {
              const parsed = JSON.parse(errorBody);
              if (parsed.detail) errorMsg = parsed.detail;
            } catch {
              // use default message
            }
            webContents.send(channel, { event: 'error', data: errorMsg } as StreamEvent);
            webContents.send(channel, { event: 'end', data: '' } as StreamEvent);
          }
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // Parse SSE lines
        const lines = buffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') continue;

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);
            if (!webContents.isDestroyed()) {
              webContents.send(channel, { event: 'data', data } as StreamEvent);
            }
          }
        }
      });

      res.on('end', () => {
        activeStreams.delete(streamId);
        if (!webContents.isDestroyed()) {
          webContents.send(channel, { event: 'end', data: '' } as StreamEvent);
        }
      });

      res.on('error', (err) => {
        activeStreams.delete(streamId);
        if (!webContents.isDestroyed()) {
          webContents.send(channel, { event: 'error', data: err.message } as StreamEvent);
          webContents.send(channel, { event: 'end', data: '' } as StreamEvent);
        }
      });
    });

    req.on('error', (err) => {
      activeStreams.delete(streamId);
      if (!webContents.isDestroyed()) {
        webContents.send(channel, { event: 'error', data: err.message } as StreamEvent);
        webContents.send(channel, { event: 'end', data: '' } as StreamEvent);
      }
    });

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();

    activeStreams.set(streamId, req);
    return streamId;
  });

  // Cancel SSE stream
  ipcMain.handle(IPC_CHANNELS.STREAM_CANCEL, async (_event, streamId: string) => {
    const req = activeStreams.get(streamId);
    if (req) {
      req.destroy();
      activeStreams.delete(streamId);
    }
  });

  // --- Agent System ---

  ipcMain.handle(IPC_CHANNELS.AGENT_RUN, async (event, request: AgentRunRequest) => {
    if (!agentRuntime) {
      throw new Error('Agent runtime not initialized');
    }
    return agentRuntime.startRun(event.sender, request);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, async (_event, runId: string) => {
    if (!agentRuntime) return false;
    return agentRuntime.cancelRun(runId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ACTIVE_RUNS, async () => {
    if (!agentRuntime) return [];
    return agentRuntime.getActiveRuns();
  });

  // Read persisted terminal buffer from disk (for post-restart replay)
  ipcMain.handle(IPC_CHANNELS.TASK_TERMINAL_READ_BUFFER, async (_event, runId: string) => {
    if (!agentRuntime) return null;
    return agentRuntime.terminalBufferStore.read(runId);
  });

  // Remove persisted terminal buffer (called when a task is deleted)
  ipcMain.handle(IPC_CHANNELS.TASK_TERMINAL_REMOVE_BUFFER, async (_event, runId: string) => {
    if (!agentRuntime) return;
    agentRuntime.terminalBufferStore.remove(runId);
  });

  // --- Task Workspace (per-task isolated directory) ---

  // Create the workspace directory and symlink .claude from parent dataDir
  ipcMain.handle(IPC_CHANNELS.TASK_WORKSPACE_CREATE, async (_event, taskId: string): Promise<string> => {
    if (!/^[a-z0-9]{32}$/i.test(taskId)) {
      throw new Error(`Invalid taskId: ${taskId}`);
    }
    const dataDir = app.getPath('userData');
    const workspacePath = getTaskWorkspaceDir(taskId);
    fs.mkdirSync(workspacePath, { recursive: true });
    // Symlink .claude/ from parent so skills/agents are discoverable
    const claudeSrc = path.join(dataDir, '.claude');
    const claudeDst = path.join(workspacePath, '.claude');
    if (fs.existsSync(claudeSrc) && !fs.existsSync(claudeDst)) {
      try {
        fs.symlinkSync(claudeSrc, claudeDst, 'dir');
      } catch (err) {
        console.warn('[workspace] Failed to symlink .claude:', err);
      }
    }
    return workspacePath;
  });

  // Return the derived workspace path without creating it
  ipcMain.handle(IPC_CHANNELS.TASK_WORKSPACE_PATH, async (_event, taskId: string): Promise<string> => {
    return getTaskWorkspaceDir(taskId);
  });

  // List files in the workspace as a nested tree (excluding .claude symlink and node_modules).
  // `overridePath` (optional) routes the listing to an external project folder; the backend
  // sandbox validator already canonicalized and vetted the path at task create/update time.
  ipcMain.handle(IPC_CHANNELS.TASK_WORKSPACE_LIST_FILES, async (_event, taskId: string, overridePath?: string) => {
    const baseDir = overridePath && overridePath.trim() && path.isAbsolute(overridePath)
      ? overridePath
      : getTaskWorkspaceDir(taskId);
    if (!fs.existsSync(baseDir)) return [];

    const SKIP_DIRS = new Set(['.claude', 'node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__']);
    const MAX_DEPTH = 6;

    function walk(dir: string, depth: number): Array<{ name: string; path: string; type: 'dir' | 'file'; size?: number; mtime?: number; children?: unknown[] }> {
      if (depth > MAX_DEPTH) return [];
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const results: Array<{ name: string; path: string; type: 'dir' | 'file'; size?: number; mtime?: number; children?: unknown[] }> = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          results.push({
            name: entry.name,
            path: relPath,
            type: 'dir',
            children: walk(fullPath, depth + 1),
          });
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            results.push({
              name: entry.name,
              path: relPath,
              type: 'file',
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          } catch {
            // skip
          }
        }
      }
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return results;
    }

    return walk(baseDir, 0);
  });

  // Read a file from the workspace as text (1MB cap)
  ipcMain.handle(IPC_CHANNELS.TASK_WORKSPACE_READ_FILE, async (_event, taskId: string, relativePath: string): Promise<string | null> => {
    const baseDir = getTaskWorkspaceDir(taskId);
    const filePath = path.normalize(path.join(baseDir, relativePath));
    if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) return null;
    if (!fs.existsSync(filePath)) return null;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 1024 * 1024) return '[file too large to display]';
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  });

  // Remove the workspace directory (on task deletion)
  ipcMain.handle(IPC_CHANNELS.TASK_WORKSPACE_REMOVE, async (_event, taskId: string): Promise<void> => {
    const baseDir = getTaskWorkspaceDir(taskId);
    if (fs.existsSync(baseDir)) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  // --- Execution Engine ---

  ipcMain.handle(IPC_CHANNELS.ENGINE_RUN, async (event, request: EngineRunRequest) => {
    if (!executionEngine) {
      throw new Error('Execution engine not initialized');
    }
    return executionEngine.startRun(event.sender, request);
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_CANCEL, async (_event, runId: string) => {
    if (!executionEngine) return false;
    return executionEngine.cancelRun(runId);
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_ACTIVE_RUNS, async () => {
    if (!executionEngine) return [];
    return executionEngine.getActiveRuns();
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_GET_EVENTS, async (_event, runId: string) => {
    if (!executionEngine) return [];
    return executionEngine.getBufferedEvents(runId);
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_APPROVE, async (_event, approvalId: string) => {
    if (!executionEngine) return false;
    return executionEngine.resolveApproval(approvalId, true);
  });

  ipcMain.handle(IPC_CHANNELS.ENGINE_DENY, async (_event, approvalId: string, reason?: string) => {
    if (!executionEngine) return false;
    return executionEngine.resolveApproval(approvalId, false, reason);
  });

  // --- Scheduler ---

  ipcMain.handle(IPC_CHANNELS.SCHEDULER_SYNC, async () => {
    if (!routineScheduler) {
      throw new Error('Scheduler not initialized');
    }
    await routineScheduler.sync();
  });

  // --- Claude Code ---

  ipcMain.handle(IPC_CHANNELS.CLAUDE_CODE_DETECT, async () => {
    return detectClaudeCode();
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_CODE_STATUS, async () => {
    return getCachedClaudeCodeInfo();
  });

  // --- Installer sync (called by renderer after expert CRUD) ---

  ipcMain.handle(IPC_CHANNELS.INSTALLER_SYNC_EXPERT, async (_event, expertId: string) => {
    if (backendPort === null) return { ok: false, error: 'Backend not ready' };
    const dataDir = app.getPath('userData');
    try {
      const res = await makeBackendRequest<{
        id: string; name: string; slug: string | null; description: string;
        system_prompt: string | null; is_enabled: boolean;
      }>({ method: 'GET', path: `/experts/${expertId}` });
      if (!res.ok || !res.data) {
        return { ok: false, error: 'Expert not found' };
      }
      await installExpert({ dataDir, backendPort }, res.data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INSTALLER_REMOVE_EXPERT, async (_event, expertId: string) => {
    if (backendPort === null) return { ok: false, error: 'Backend not ready' };
    const dataDir = app.getPath('userData');
    removeExpert({ dataDir, backendPort }, expertId);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.INSTALLER_SYNC_ALL, async () => {
    if (backendPort === null) return { ok: false, error: 'Backend not ready' };
    const dataDir = app.getPath('userData');
    await installAll({ dataDir, backendPort });
    return { ok: true };
  });

  // --- Voice ---

  ipcMain.handle(
    IPC_CHANNELS.VOICE_START,
    async (_event, expertId: string, conversationId: string) => {
      if (!voiceSession) throw new Error('Voice session not initialized');
      return voiceSession.start(expertId, conversationId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.VOICE_STOP, async (_event, sessionId: string) => {
    if (!voiceSession) return;
    await voiceSession.stop();
  });

  ipcMain.handle(
    IPC_CHANNELS.VOICE_AUDIO_CHUNK,
    async (_event, sessionId: string, chunk: ArrayBuffer) => {
      if (!voiceSession) return;
      await voiceSession.processAudioChunk(sessionId, Buffer.from(chunk));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.VOICE_DONE_SPEAKING,
    async (_event, sessionId: string) => {
      if (!voiceSession) return;
      await voiceSession.doneSpeaking(sessionId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.VOICE_MODEL_STATUS, async () => {
    if (!voiceSession) return null;
    return voiceSession.getModelStatus();
  });

  // --- Sandbox ---

  ipcMain.handle(IPC_CHANNELS.SANDBOX_PICK_DIRECTORY, async () => {
    const [parent] = BrowserWindow.getAllWindows();
    const result = await dialog.showOpenDialog(parent, {
      title: 'Link a project directory',
      ...(process.platform === 'darwin' ? { message: 'Cerebro will grant its agents access to this directory.' } : {}),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    IPC_CHANNELS.SANDBOX_REVEAL_WORKSPACE,
    async (_event, workspacePath: string) => {
      // Create on demand so the Finder reveal never hits a missing dir.
      try {
        fs.mkdirSync(workspacePath, { recursive: true });
      } catch {
        /* fall through — showItemInFolder will just focus the parent */
      }
      shell.showItemInFolder(workspacePath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_OPEN_PATH,
    async (_event, filePath: string) => {
      await shell.openPath(filePath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_REVEAL_PATH,
    async (_event, filePath: string) => {
      shell.showItemInFolder(filePath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_STAT_PATH,
    async (_event, filePath: string) => {
      try {
        const stat = await fs.promises.stat(filePath);
        return {
          exists: true,
          isDirectory: stat.isDirectory(),
          size: stat.isDirectory() ? 0 : stat.size,
        };
      } catch {
        return { exists: false, isDirectory: false, size: 0 };
      }
    },
  );

  // 2 MB limit keeps the renderer responsive — anything bigger should be
  // opened externally via SHELL_OPEN_PATH instead.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_READ_TEXT_FILE,
    async (_event, filePath: string) => {
      const content = await fs.promises.readFile(filePath, 'utf8');
      if (content.length > 2 * 1024 * 1024) {
        throw new Error('File too large to preview (>2 MB)');
      }
      return content;
    },
  );

  // Copy a file emitted by an expert into the user's OS Downloads folder,
  // auto-deduping the destination name on collision. Returns the final path.
  ipcMain.handle(
    IPC_CHANNELS.SHELL_DOWNLOAD_TO_DOWNLOADS,
    async (_event, sourcePath: string) => {
      const src = await fs.promises.stat(sourcePath).catch(() => null);
      if (!src || src.isDirectory()) {
        throw new Error('Source is not a regular file');
      }
      const downloads = app.getPath('downloads');
      await fs.promises.mkdir(downloads, { recursive: true });
      const base = path.basename(sourcePath);
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let dest = path.join(downloads, base);
      let counter = 1;
      while (true) {
        try {
          await fs.promises.access(dest);
          dest = path.join(downloads, `${stem}-${counter}${ext}`);
          counter++;
        } catch {
          break;
        }
      }
      await fs.promises.copyFile(sourcePath, dest);
      return dest;
    },
  );

  ipcMain.handle(IPC_CHANNELS.SANDBOX_GET_PROFILE, async () => {
    const config = getCachedSandboxConfig();
    if (!config) return '';
    try {
      return generateProfile({
        workspacePath: config.workspace_path,
        cerebroDataDir: app.getPath('userData'),
        linkedProjects: config.linked_projects,
        forbiddenHomeSubpaths: config.forbidden_home_subpaths,
      });
    } catch (err) {
      return `;; Error generating profile: ${err instanceof Error ? err.message : String(err)}\n`;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SANDBOX_SET_CACHE, async (_event, config: SandboxConfig) => {
    setCachedSandboxConfig(config);
  });

  // --- Files (managed buckets) ---

  ipcMain.handle(IPC_CHANNELS.FILES_PICK_FILES, async () => {
    const [parent] = BrowserWindow.getAllWindows();
    const result = await dialog.showOpenDialog(parent, {
      title: 'Add files to Cerebro',
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle(
    IPC_CHANNELS.FILES_IMPORT_TO_BUCKET,
    async (_event, args: { sourcePath: string; bucketId: string; fileId: string; destExt: string }) => {
      const { sourcePath, bucketId, fileId, destExt } = args;
      if (!path.isAbsolute(sourcePath)) {
        throw new Error('Source path must be absolute');
      }
      if (!/^[a-z0-9]{32}$/i.test(bucketId)) {
        throw new Error(`Invalid bucketId: ${bucketId}`);
      }
      if (!/^[a-z0-9]{32}$/i.test(fileId)) {
        throw new Error(`Invalid fileId: ${fileId}`);
      }
      const cleanExt = (destExt || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
      const baseName = cleanExt ? `${fileId}.${cleanExt}` : fileId;
      const destDir = path.join(getFilesRoot(), bucketId);
      const destAbs = path.join(destDir, baseName);
      await fs.promises.mkdir(destDir, { recursive: true });

      const srcStat = await fs.promises.stat(sourcePath);
      if (srcStat.isDirectory()) throw new Error('Source is a directory');

      const hash = crypto.createHash('sha256');
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        const reader = fs.createReadStream(sourcePath);
        const writer = fs.createWriteStream(destAbs);
        reader.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          hash.update(buf);
          bytes += buf.length;
        });
        reader.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        reader.pipe(writer);
      });

      const destRelPath = path.posix.join(bucketId, baseName);
      return {
        destRelPath,
        sha256: hash.digest('hex'),
        sizeBytes: bytes,
        mime: mimeFor(destAbs).split(';')[0] || null,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_COPY_MANAGED,
    async (_event, args: { srcRelPath: string; destBucketId: string; destFileId: string; destExt: string }) => {
      const srcAbs = resolveManagedPath(args.srcRelPath);
      if (!/^[a-z0-9]{32}$/i.test(args.destBucketId)) {
        throw new Error(`Invalid destBucketId: ${args.destBucketId}`);
      }
      if (!/^[a-z0-9]{32}$/i.test(args.destFileId)) {
        throw new Error(`Invalid destFileId: ${args.destFileId}`);
      }
      const cleanExt = (args.destExt || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
      const baseName = cleanExt ? `${args.destFileId}.${cleanExt}` : args.destFileId;
      const destDir = path.join(getFilesRoot(), args.destBucketId);
      const destAbs = path.join(destDir, baseName);
      await fs.promises.mkdir(destDir, { recursive: true });

      const hash = crypto.createHash('sha256');
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        const reader = fs.createReadStream(srcAbs);
        const writer = fs.createWriteStream(destAbs);
        reader.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          hash.update(buf);
          bytes += buf.length;
        });
        reader.on('error', reject);
        writer.on('error', reject);
        writer.on('finish', resolve);
        reader.pipe(writer);
      });

      const destRelPath = path.posix.join(args.destBucketId, baseName);
      return {
        destRelPath,
        sha256: hash.digest('hex'),
        sizeBytes: bytes,
        mime: mimeFor(destAbs).split(';')[0] || null,
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.FILES_DELETE_MANAGED, async (_event, relPath: string) => {
    const abs = resolveManagedPath(relPath);
    try {
      await fs.promises.unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILES_DELETE_MANAGED_BATCH, async (_event, relPaths: string[]) => {
    for (const rel of relPaths) {
      try {
        const abs = resolveManagedPath(rel);
        await fs.promises.unlink(abs).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        });
      } catch (err) {
        console.warn(`[files] delete batch skipped ${rel}:`, err);
      }
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.FILES_PREVIEW_URL,
    async (_event, args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }) => {
      if (args.storageKind === 'managed') {
        const segments = args.storagePath.split('/').filter(Boolean).map((s) => encodeURIComponent(s));
        return `cerebro-files://local/${segments.join('/')}`;
      }
      // workspace
      if (!args.taskId) throw new Error('taskId required for workspace previews');
      const segments = args.storagePath.split('/').filter(Boolean).map((s) => encodeURIComponent(s));
      return `cerebro-workspace://${args.taskId}/${segments.join('/')}`;
    },
  );

  // For workspace files we accept either a relative path (resolved against the
  // task workspace dir) or an absolute path (an external project folder linked
  // to the task — already vetted by the sandbox validator at task create time).
  function resolveStoragePath(args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }): string {
    if (args.storageKind === 'managed') {
      return resolveManagedPath(args.storagePath);
    }
    if (path.isAbsolute(args.storagePath)) return args.storagePath;
    if (!args.taskId) throw new Error('taskId required for workspace files');
    return path.join(getTaskWorkspaceDir(args.taskId), args.storagePath);
  }

  ipcMain.handle(
    IPC_CHANNELS.FILES_REVEAL,
    async (_event, args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }) => {
      const abs = resolveStoragePath(args);
      shell.showItemInFolder(abs);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_OPEN,
    async (_event, args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }) => {
      const abs = resolveStoragePath(args);
      await shell.openPath(abs);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_DOWNLOAD,
    async (_event, args: { storageKind: 'managed' | 'workspace'; storagePath: string; taskId?: string | null }) => {
      const abs = resolveStoragePath(args);
      const src = await fs.promises.stat(abs).catch(() => null);
      if (!src || src.isDirectory()) throw new Error('Source is not a regular file');
      const downloads = app.getPath('downloads');
      await fs.promises.mkdir(downloads, { recursive: true });
      const base = path.basename(abs);
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let dest = path.join(downloads, base);
      let counter = 1;
      while (true) {
        try {
          await fs.promises.access(dest);
          dest = path.join(downloads, `${stem}-${counter}${ext}`);
          counter++;
        } catch {
          break;
        }
      }
      await fs.promises.copyFile(abs, dest);
      return dest;
    },
  );

  ipcMain.handle(IPC_CHANNELS.FILES_READ_MANAGED_TEXT, async (_event, relPath: string) => {
    const abs = resolveManagedPath(relPath);
    const content = await fs.promises.readFile(abs, 'utf8');
    if (content.length > 2 * 1024 * 1024) {
      throw new Error('File too large to preview (>2 MB)');
    }
    return content;
  });

  // --- Telegram bridge ---

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_VERIFY, async (_event, token: string) => {
    if (!telegramBridge) return { ok: false, error: 'Bridge not initialized' };
    return telegramBridge.verifyToken(token);
  });

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_ENABLE, async () => {
    if (!telegramBridge) return { ok: false, error: 'Bridge not initialized' };
    try {
      await telegramBridge.stop(); // stop first so a restart picks up fresh settings
      await telegramBridge.start();
      const status = telegramBridge.status();
      return { ok: status.running, error: status.running ? undefined : status.lastError ?? 'Failed to start' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_DISABLE, async () => {
    if (!telegramBridge) return;
    await telegramBridge.stop();
  });

  ipcMain.handle(IPC_CHANNELS.TELEGRAM_STATUS, async () => {
    if (!telegramBridge) {
      return { running: false, lastPollAt: null, lastError: 'Bridge not initialized', unknownLastAttempt: {} };
    }
    return telegramBridge.status();
  });
}

// --- Window creation ---

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Cerebro',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 12 },
    } : {}),
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.maximize();

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Set webContents on scheduler and voice session if available
  if (routineScheduler) {
    routineScheduler.setWebContents(mainWindow.webContents);
  }
  if (voiceSession) {
    voiceSession.setWebContents(mainWindow.webContents);
  }

  // Open DevTools in dev mode — but never in E2E mode, where an extra
  // DevTools WebContents exposes itself over CDP and Playwright can bind to
  // it instead of the actual renderer (the failing screenshots show only
  // DevTools with a blank left pane).
  if (!process.env.CEREBRO_E2E_DEBUG_PORT) {
    mainWindow.webContents.openDevTools();
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  // Set Dock icon on macOS (needed during dev — packaged builds use packagerConfig.icon)
  if (process.platform === 'darwin') {
    const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

  // Serve task-workspace files via custom protocol so iframes can render live previews
  protocol.handle('cerebro-workspace', async (request) => {
    let filePath = '<unresolved>';
    try {
      const url = new URL(request.url);
      const taskId = url.hostname;
      if (!taskId || !/^[a-z0-9]{32}$/i.test(taskId)) {
        return new Response('Invalid task id', { status: 400 });
      }
      const baseDir = getTaskWorkspaceDir(taskId);
      let relPath = decodeURIComponent(url.pathname || '/');
      if (relPath === '/' || relPath === '') relPath = '/index.html';
      filePath = path.normalize(path.join(baseDir, relPath));
      if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
        return new Response('Forbidden', { status: 403 });
      }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return new Response(`Not found: ${path.basename(filePath)}`, {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          return new Response('No index.html in directory', {
            status: 404,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      }
      const data = await fs.promises.readFile(filePath);
      // Convert Buffer → Uint8Array (Response constructor accepts both, but be explicit)
      const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mimeFor(filePath) },
      });
    } catch (err) {
      console.error(`[cerebro-workspace] handler error for ${filePath}:`, err);
      return new Response(`Error: ${(err as Error).message ?? err}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  });

  // Serve managed bucket files via cerebro-files://<bucketId>/<fileId>.<ext>
  protocol.handle('cerebro-files', async (request) => {
    let filePath = '<unresolved>';
    try {
      const url = new URL(request.url);
      // Path = "/<bucketId>/<fileId>.<ext>"; hostname is empty for opaque hosts.
      const parts = decodeURIComponent(url.pathname || '/').split('/').filter(Boolean);
      // Some Chromium variants stuff the first segment into url.hostname for non-standard schemes.
      if (url.hostname) parts.unshift(url.hostname);
      const relPath = parts.join('/');
      if (!relPath) return new Response('Missing path', { status: 400 });
      try {
        filePath = resolveManagedPath(relPath);
      } catch {
        return new Response('Forbidden', { status: 403 });
      }
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return new Response(`Not found: ${path.basename(filePath)}`, {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      if (stat.isDirectory()) {
        return new Response('Is a directory', { status: 400 });
      }
      const data = await fs.promises.readFile(filePath);
      const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mimeFor(filePath) },
      });
    } catch (err) {
      console.error(`[cerebro-files] handler error for ${filePath}:`, err);
      return new Response(`Error: ${(err as Error).message ?? err}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  });

  registerIpcHandlers();
  createWindow();

  // Detect Claude Code BEFORE starting the backend so the binary path is
  // cached and the installer/runtime can spawn `claude` immediately on startup.
  try {
    const info = await detectClaudeCode();
    console.log(`[Cerebro] Claude Code detection: ${info.status}${info.version ? ` v${info.version}` : ''}${info.path ? ` (${info.path})` : ''}`);
  } catch (err) {
    console.error('[Cerebro] Claude Code detection failed:', err);
  }

  startPythonBackend().catch((err) => {
    console.error('[Cerebro] Failed to start Python backend:', err);
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  isIntentionalShutdown = true;
  if (routineScheduler) {
    routineScheduler.stopAll();
  }
  if (taskReconciler) {
    taskReconciler.stop();
  }
  if (telegramBridge) {
    try { await telegramBridge.stop(); } catch { /* ignore */ }
    unregisterChannelSender('telegram');
  }
  await stopPythonBackend();
});

// Safety net: ensure Python process is killed when the Node process exits
process.on('exit', () => {
  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.kill('SIGKILL');
  }
});
