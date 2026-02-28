import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// --- Python backend state ---
let pythonProcess: ChildProcess | null = null;
let backendPort: number | null = null;
let isIntentionalShutdown = false;
let restartCount = 0;
const MAX_RESTARTS = 3;

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
  const dbPath = path.join(app.getPath('userData'), 'cerebro.db');

  console.log(`[Cerebro] Starting Python backend on port ${port}...`);
  console.log(`[Cerebro] Python path: ${pythonPath}`);
  console.log(`[Cerebro] Database path: ${dbPath}`);

  const proc = spawn(pythonPath, [scriptPath, '--port', String(port), '--db-path', dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(app.getAppPath(), 'backend'),
  });

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

    console.log(`[Cerebro] Python backend exited unexpectedly (code=${code}, signal=${signal})`);

    if (restartCount < MAX_RESTARTS) {
      restartCount++;
      console.log(`[Cerebro] Restarting Python backend (attempt ${restartCount}/${MAX_RESTARTS})...`);
      startPythonBackend().catch((err) => {
        console.error('[Cerebro] Failed to restart Python backend:', err);
      });
    } else {
      console.error('[Cerebro] Max restart attempts reached. Python backend will not be restarted.');
    }
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
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
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
