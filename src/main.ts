import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import started from 'electron-squirrel-startup';
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
import { detectClaudeCode, getCachedClaudeCodeInfo } from './claude-code/detector';
import {
  installAll,
  installExpert,
  removeExpert,
  writeRuntimeInfo,
  migrateLegacyContextFiles,
} from './claude-code/installer';
import { setClaudeCodeCwd } from './claude-code/single-shot';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
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

  agentRuntime = new AgentRuntime(port, dataDir);
  executionEngine = new ExecutionEngine(port, agentRuntime);
  routineScheduler = new RoutineScheduler(executionEngine, port);

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
      installExpert({ dataDir, backendPort }, res.data);
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
app.on('ready', async () => {
  // Set Dock icon on macOS (needed during dev — packaged builds use packagerConfig.icon)
  if (process.platform === 'darwin') {
    const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }

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
  await stopPythonBackend();
});

// Safety net: ensure Python process is killed when the Node process exits
process.on('exit', () => {
  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.kill('SIGKILL');
  }
});
