import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import started from 'electron-squirrel-startup';
import { IPC_CHANNELS } from './types/ipc';
import type {
  BackendRequest,
  BackendResponse,
  BackendStatus,
  StreamRequest,
  StreamEvent,
  CredentialSetRequest,
  CredentialIdentifier,
} from './types/ipc';
import {
  initCredentialStore,
  setCredential,
  getCredential,
  hasCredential,
  deleteCredential,
  clearCredentials,
  listCredentials,
} from './credentials';
import { AgentRuntime } from './agents';
import type { AgentRunRequest } from './agents';
import { ExecutionEngine } from './engine/engine';
import type { EngineRunRequest } from './engine/dag/types';
import { RoutineScheduler } from './scheduler/scheduler';
import { detectClaudeCode, getCachedClaudeCodeInfo } from './claude-code/detector';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Mapping of provider service names → backend env credential keys
const CREDENTIAL_ENV_KEYS: Record<string, string> = {
  huggingface: 'HF_TOKEN',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

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

async function pushCredentialToBackend(envKey: string, service: string, credKey: string): Promise<void> {
  const value = getCredential(service, credKey);
  await makeBackendRequest({
    method: 'POST',
    path: '/credentials',
    body: { key: envKey, value },
  });
}

async function startPythonBackend(): Promise<void> {
  const port = await getFreePort();
  const pythonPath = resolvePythonPath();
  const scriptPath = path.join(app.getAppPath(), 'backend', 'main.py');
  const dbPath = path.join(app.getPath('userData'), 'cerebro.db');

  backendStatus = 'starting';
  console.log(`[Cerebro] Starting Python backend on port ${port}...`);
  console.log(`[Cerebro] Python path: ${pythonPath}`);
  console.log(`[Cerebro] Database path: ${dbPath}`);

  const modelsDir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(modelsDir, { recursive: true });

  // Pass all stored provider keys as env vars at startup
  const spawnEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [service, envKey] of Object.entries(CREDENTIAL_ENV_KEYS)) {
    const value = getCredential(service, 'api_key');
    if (value) {
      spawnEnv[envKey] = value;
    }
  }

  const proc = spawn(
    pythonPath,
    [scriptPath, '--port', String(port), '--db-path', dbPath, '--models-dir', modelsDir],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.join(app.getAppPath(), 'backend'),
      env: spawnEnv,
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
  agentRuntime = new AgentRuntime(port);
  executionEngine = new ExecutionEngine(port, agentRuntime);
  agentRuntime.setExecutionEngine(executionEngine);
  routineScheduler = new RoutineScheduler(executionEngine, port);

  // Recover stale runs from previous session
  makeBackendRequest({ method: 'POST', path: '/engine/runs/recover-stale' }).catch(console.error);

  // Set webContents if window already exists
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    routineScheduler.setWebContents(windows[0].webContents);
  }

  // Initial scheduler sync + start periodic re-sync
  routineScheduler.sync().then(() => {
    routineScheduler!.startPeriodicSync();
  }).catch((err) => {
    console.error('[Cerebro] Initial scheduler sync failed:', err);
    // Start periodic sync anyway so it can self-heal
    routineScheduler!.startPeriodicSync();
  });

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

  // --- Credential storage ---

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_SET, async (_event, request: CredentialSetRequest) => {
    const result = setCredential(request.service, request.key, request.value, request.label);
    if (result.ok && request.key === 'api_key') {
      const envKey = CREDENTIAL_ENV_KEYS[request.service];
      if (envKey) {
        pushCredentialToBackend(envKey, request.service, 'api_key').catch((err) => {
          console.error(`[Cerebro] Failed to push ${request.service} key to backend:`, err);
        });
      }
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_HAS, async (_event, request: CredentialIdentifier) => {
    return hasCredential(request.service, request.key);
  });

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_DELETE, async (_event, request: CredentialIdentifier) => {
    const result = deleteCredential(request.service, request.key);
    if (result.ok && request.key === 'api_key') {
      const envKey = CREDENTIAL_ENV_KEYS[request.service];
      if (envKey) {
        pushCredentialToBackend(envKey, request.service, 'api_key').catch((err) => {
          console.error(`[Cerebro] Failed to clear ${request.service} key on backend:`, err);
        });
      }
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_CLEAR, async (_event, service?: string) => {
    return clearCredentials(service);
  });

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_LIST, async (_event, service?: string) => {
    return listCredentials(service);
  });

  // --- Models ---

  ipcMain.handle(IPC_CHANNELS.MODELS_GET_DIR, async () => {
    return path.join(app.getPath('userData'), 'models');
  });

  ipcMain.handle(IPC_CHANNELS.MODELS_DISK_SPACE, async () => {
    const modelsDir = path.join(app.getPath('userData'), 'models');
    const stats = fs.statfsSync(modelsDir);
    return {
      free: stats.bfree * stats.bsize,
      total: stats.blocks * stats.bsize,
    };
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // Set webContents on scheduler if available
  if (routineScheduler) {
    routineScheduler.setWebContents(mainWindow.webContents);
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  // Set Dock icon on macOS (needed during dev — packaged builds use packagerConfig.icon)
  if (process.platform === 'darwin') {
    const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

  initCredentialStore();
  registerIpcHandlers();
  createWindow();
  startPythonBackend().catch((err) => {
    console.error('[Cerebro] Failed to start Python backend:', err);
  });

  // Detect Claude Code CLI availability
  detectClaudeCode().then((info) => {
    console.log(`[Cerebro] Claude Code detection: ${info.status}${info.version ? ` v${info.version}` : ''}${info.path ? ` (${info.path})` : ''}`);
  }).catch((err) => {
    console.error('[Cerebro] Claude Code detection failed:', err);
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
  await stopPythonBackend();
});

// Safety net: ensure Python process is killed when the Node process exits
process.on('exit', () => {
  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.kill('SIGKILL');
  }
});
