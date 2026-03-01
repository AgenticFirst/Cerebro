import { app, BrowserWindow, ipcMain } from 'electron';
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

  // Read HF token from credential store to pass as env var at startup
  const spawnEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  const hfToken = getCredential('huggingface', 'api_key');
  if (hfToken) {
    spawnEnv.HF_TOKEN = hfToken;
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
    if (result.ok && request.service === 'huggingface') {
      pushCredentialToBackend('HF_TOKEN', 'huggingface', 'api_key').catch((err) => {
        console.error('[Cerebro] Failed to push HF token to backend:', err);
      });
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_HAS, async (_event, request: CredentialIdentifier) => {
    return hasCredential(request.service, request.key);
  });

  ipcMain.handle(IPC_CHANNELS.CREDENTIAL_DELETE, async (_event, request: CredentialIdentifier) => {
    const result = deleteCredential(request.service, request.key);
    if (result.ok && request.service === 'huggingface') {
      pushCredentialToBackend('HF_TOKEN', 'huggingface', 'api_key').catch((err) => {
        console.error('[Cerebro] Failed to clear HF token on backend:', err);
      });
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
}

// --- Window creation ---

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Cerebro',
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

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  initCredentialStore();
  registerIpcHandlers();
  createWindow();
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
  await stopPythonBackend();
});

// Safety net: ensure Python process is killed when the Node process exits
process.on('exit', () => {
  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.kill('SIGKILL');
  }
});
