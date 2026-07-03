/**
 * N8nManager — owns the Cerebro-managed local n8n instance end to end:
 *
 *   install   npm-installs the pinned n8n version into <userData>/n8n-app
 *             (streamed log lines, same UX as the Claude Code installer)
 *   start     spawns `node .../bin/n8n start` bound to 127.0.0.1, health-polls
 *             /healthz, then provisions owner + API key on first run
 *   stop      SIGTERM → 3s → SIGKILL, mirroring stopPythonBackend()
 *
 * It doubles as the N8nChannel for engine actions (getApiKey / baseUrl /
 * isConnected), like HubSpotHolder does for HubSpot.
 *
 * n8n is NOT bundled with Cerebro — it is downloaded from npm onto the
 * user's machine at first use and runs unmodified (Sustainable Use License:
 * the user operates their own instance; Cerebro never distributes n8n).
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { session, type WebContents } from 'electron';
import {
  encryptForStorage,
  decryptFromStorage,
  backend as secureTokenBackend,
} from '../secure-token';
import { backendGetSetting, backendPutSetting } from '../shared/backend-settings';
import { IPC_CHANNELS, type N8nStatusResponse } from '../types/ipc';
import {
  N8N_DEFAULT_PORT,
  N8N_MIN_NODE_MAJOR,
  N8N_PINNED_VERSION,
  N8N_SETTING_KEYS,
  N8N_ZOD_OVERRIDE_VERSION,
  type N8nPhase,
  type N8nRuntimeInfo,
} from './types';
import {
  createApiKey,
  generateOwnerPassword,
  login,
  setupOwner,
  type N8nSessionCookie,
} from './provisioning';

const MAX_RESTARTS = 3;
const HEALTH_TIMEOUT_MS = 180_000; // first boot runs DB migrations — be generous
const HEALTH_INTERVAL_MS = 500;
// n8n session cookies live 7 days (Max-Age=604800); refresh with a margin so
// an embedded editor opened near the end of the window never gets a dead one.
const SESSION_COOKIE_MAX_REUSE_MS = 6 * 24 * 60 * 60 * 1_000;

interface ManagerDeps {
  backendPort: number;
  dataDir: string;
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/** Common node install locations, since Electron launched from Finder doesn't
 *  inherit the user's shell PATH (same problem detector.ts solves for claude). */
function nodeFallbackDirs(): string[] {
  const home = os.homedir();
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin')];
  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const dir of fs.readdirSync(nvmVersionsDir)) {
      dirs.push(path.join(nvmVersionsDir, dir, 'bin'));
    }
  } catch {
    // nvm not installed — skip
  }
  return dirs;
}

function parseNodeMajor(version: string): number {
  const match = version.match(/v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

export class N8nManager {
  private phase: N8nPhase = 'not_installed';
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private ownerEmail: string | null = null;
  private ownerPassword: string | null = null;
  private encryptionKey: string | null = null;
  private installedVersion: string | null = null;
  private lastError: string | null = null;
  private sessionCookie: N8nSessionCookie | null = null;
  private sessionCookieMintedAt = 0;
  /** Origin the embedded-editor webRequest hooks are currently scoped to. */
  private hookedOrigin: string | null = null;
  /** "n8n-auth=<jwt>" header value injected into embedded-editor requests. */
  private authCookieHeader: string | null = null;
  private restartCount = 0;
  private intentionalStop = false;
  private runtime: N8nRuntimeInfo | null = null;
  private installChild: ChildProcess | null = null;
  private webContents: WebContents | null = null;
  private startPromise: Promise<{ ok: boolean; error?: string }> | null = null;

  constructor(private deps: ManagerDeps) {}

  // --- N8nChannel surface (engine actions) ---

  getApiKey(): string | null {
    return this.apiKey;
  }

  getEditorBaseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  isConnected(): boolean {
    return this.phase === 'running' && Boolean(this.apiKey);
  }

  // --- lifecycle ---

  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  private installDir(): string {
    return path.join(this.deps.dataDir, 'n8n-app');
  }

  private userFolder(): string {
    return path.join(this.deps.dataDir, 'n8n-data');
  }

  private n8nBinPath(): string {
    return path.join(this.installDir(), 'node_modules', 'n8n', 'bin', 'n8n');
  }

  isInstalled(): boolean {
    return fs.existsSync(this.n8nBinPath());
  }

  private setPhase(phase: N8nPhase, error?: string | null): void {
    this.phase = phase;
    if (error !== undefined) this.lastError = error;
    if (this.webContents && !this.webContents.isDestroyed()) {
      this.webContents.send(IPC_CHANNELS.N8N_STATUS_CHANGED, this.status());
    }
  }

  status(): N8nStatusResponse {
    return {
      phase: this.phase,
      port: this.phase === 'running' ? this.port : null,
      version: this.installedVersion,
      editorUrl: this.phase === 'running' ? this.getEditorBaseUrl() : null,
      hasApiKey: Boolean(this.apiKey),
      lastError: this.lastError,
      tokenBackend: secureTokenBackend(),
    };
  }

  /** Load persisted credentials + install state. Does NOT spawn anything. */
  async init(): Promise<void> {
    const port = this.deps.backendPort;
    const [encApiKey, encEncKey, ownerEmail, encOwnerPw, installedVersion] = await Promise.all([
      backendGetSetting<string>(port, N8N_SETTING_KEYS.apiKey),
      backendGetSetting<string>(port, N8N_SETTING_KEYS.encryptionKey),
      backendGetSetting<string>(port, N8N_SETTING_KEYS.ownerEmail),
      backendGetSetting<string>(port, N8N_SETTING_KEYS.ownerPassword),
      backendGetSetting<string>(port, N8N_SETTING_KEYS.installedVersion),
    ]);
    this.apiKey = decryptFromStorage(encApiKey ?? null);
    this.encryptionKey = decryptFromStorage(encEncKey ?? null);
    this.ownerEmail = typeof ownerEmail === 'string' && ownerEmail ? ownerEmail : null;
    this.ownerPassword = decryptFromStorage(encOwnerPw ?? null);
    this.installedVersion =
      typeof installedVersion === 'string' && installedVersion ? installedVersion : null;
    this.phase = this.isInstalled() ? 'stopped' : 'not_installed';
  }

  /** Auto-start on app launch only if the user completed setup before. */
  async startIfEnabled(): Promise<void> {
    const enabled = await backendGetSetting<boolean>(
      this.deps.backendPort,
      N8N_SETTING_KEYS.enabled,
    );
    if (enabled === true && this.isInstalled()) {
      const res = await this.start();
      if (!res.ok) console.error('[n8n] auto-start failed:', res.error);
    }
  }

  /**
   * Finds a Node >= 22 runtime. Cached after first success. n8n needs a real
   * Node (it spawns its own task-runner children), so unlike `claude` there
   * is no curl-installable standalone binary to fall back on.
   */
  async resolveNodeRuntime(): Promise<N8nRuntimeInfo | null> {
    if (this.runtime) return this.runtime;
    const isWin = process.platform === 'win32';
    const nodeName = isWin ? 'node.exe' : 'node';
    const npmName = isWin ? 'npm.cmd' : 'npm';

    const candidates: string[] = [];
    try {
      const whichCmd = isWin ? 'where' : 'which';
      const found = await runCommand(whichCmd, ['node']);
      // `where` can return multiple lines; take them all.
      candidates.push(
        ...found
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
    } catch {
      // PATH miss — fall through to well-known locations.
    }
    for (const dir of nodeFallbackDirs()) {
      candidates.push(path.join(dir, nodeName));
    }

    for (const nodePath of candidates) {
      if (!fs.existsSync(nodePath)) continue;
      try {
        const version = await runCommand(nodePath, ['--version']);
        if (parseNodeMajor(version) < N8N_MIN_NODE_MAJOR) continue;
        const npmPath = path.join(path.dirname(nodePath), npmName);
        if (!fs.existsSync(npmPath)) continue;
        this.runtime = { nodePath, npmPath, nodeVersion: version };
        return this.runtime;
      } catch {
        // Broken binary — try the next candidate.
      }
    }
    return null;
  }

  /**
   * npm-installs the pinned n8n into <userData>/n8n-app, streaming each
   * output line to the renderer over N8N_INSTALL_LOG (same shape as the
   * Claude Code installer).
   */
  async install(sender: WebContents): Promise<{ ok: boolean; error?: string }> {
    if (this.installChild) return { ok: false, error: 'Install already in progress.' };
    if (this.phase === 'running' || this.phase === 'starting' || this.phase === 'provisioning') {
      return { ok: false, error: 'n8n is already running.' };
    }
    const runtime = await this.resolveNodeRuntime();
    if (!runtime) {
      this.setPhase('node_required', `Node.js ${N8N_MIN_NODE_MAJOR}+ not found`);
      return { ok: false, error: `Node.js ${N8N_MIN_NODE_MAJOR}+ is required to run n8n.` };
    }

    fs.mkdirSync(this.installDir(), { recursive: true });
    // Install through a manifest (not `npm install n8n@x`) so npm `overrides`
    // apply — see N8N_ZOD_OVERRIDE_VERSION for why n8n won't boot without it.
    fs.writeFileSync(
      path.join(this.installDir(), 'package.json'),
      JSON.stringify(
        {
          name: 'cerebro-n8n',
          private: true,
          dependencies: { n8n: N8N_PINNED_VERSION },
          overrides: { zod: N8N_ZOD_OVERRIDE_VERSION },
        },
        null,
        2,
      ),
    );
    this.setPhase('installing', null);

    const sendLine = (line: string) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.N8N_INSTALL_LOG, line);
    };
    sendLine(`Installing n8n@${N8N_PINNED_VERSION} (using Node ${runtime.nodeVersion})...`);

    // Spawn npm directly with the resolved Node's dir FIRST in PATH. A login
    // shell (`bash -lc`, like the Claude Code installer uses) is wrong here:
    // the user's rc files can put an old Node first, and node-gyp then builds
    // n8n's native deps (isolated-vm, sqlite) against a runtime n8n can't use.
    const child = spawn(
      runtime.npmPath,
      ['install', '--prefix', this.installDir(), '--no-audit', '--no-fund', '--loglevel', 'info'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.installDir(),
        env: {
          ...process.env,
          PATH: `${path.dirname(runtime.nodePath)}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );
    this.installChild = child;

    let outputTail = '';
    const onData = (data: string) => {
      outputTail = (outputTail + data).slice(-2048);
      for (const line of data.split('\n')) {
        if (line.length > 0) sendLine(line);
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code, signal) =>
        resolve(typeof code === 'number' ? code : signal ? -1 : 0),
      );
      child.on('error', (err) => {
        onData(`spawn error: ${err.message}`);
        resolve(-1);
      });
    });
    this.installChild = null;

    if (exitCode !== 0 || !this.isInstalled()) {
      this.setPhase(
        'not_installed',
        `Install failed (exit ${exitCode}): ${outputTail.slice(-300)}`,
      );
      return { ok: false, error: this.lastError ?? 'Install failed' };
    }

    this.installedVersion = N8N_PINNED_VERSION;
    await backendPutSetting(
      this.deps.backendPort,
      N8N_SETTING_KEYS.installedVersion,
      N8N_PINNED_VERSION,
    );
    this.setPhase('stopped', null);
    return { ok: true };
  }

  cancelInstall(): void {
    const child = this.installChild;
    if (!child) return;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 2000);
  }

  /** Fixed port with linear probing so the iframe origin stays stable. */
  private async resolvePort(): Promise<number> {
    for (let candidate = N8N_DEFAULT_PORT; candidate < N8N_DEFAULT_PORT + 20; candidate++) {
      const free = await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
      });
      if (free) return candidate;
    }
    throw new Error(`No free port near ${N8N_DEFAULT_PORT}`);
  }

  /**
   * True only when the REST layer is actually serving. n8n answers 200 with a
   * text/html "n8n is starting up. Please wait" placeholder on every route
   * (including /healthz) while it boots, so a status check alone lies —
   * /rest/settings returning parseable JSON is the reliable readiness signal
   * (verified against 2.28.5).
   */
  private checkHealth(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/rest/settings`, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        let body = '';
        res.on('data', (c: Buffer) => {
          body += c.toString();
          if (body.length > 65536) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(typeof JSON.parse(body) === 'object');
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async waitForHealth(port: number): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (this.intentionalStop) throw new Error('Stopped during startup');
      if (await this.checkHealth(port)) return;
      if (Date.now() - start > HEALTH_TIMEOUT_MS) {
        throw new Error(`n8n did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
    }
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    // Collapse concurrent start() calls (Flows screen + Integrations card).
    if (this.startPromise) return this.startPromise;
    if (this.phase === 'running') return { ok: true };
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isInstalled()) {
      this.setPhase('not_installed');
      return { ok: false, error: 'n8n is not installed yet.' };
    }
    const runtime = await this.resolveNodeRuntime();
    if (!runtime) {
      this.setPhase('node_required', `Node.js ${N8N_MIN_NODE_MAJOR}+ not found`);
      return { ok: false, error: `Node.js ${N8N_MIN_NODE_MAJOR}+ is required to run n8n.` };
    }

    this.intentionalStop = false;
    this.setPhase('starting', null);

    try {
      const port = await this.resolvePort();
      await this.ensureEncryptionKey();
      fs.mkdirSync(this.userFolder(), { recursive: true });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // n8n spawns task-runner children that need `node` on PATH.
        PATH: `${path.dirname(runtime.nodePath)}${path.delimiter}${process.env.PATH ?? ''}`,
        N8N_PORT: String(port),
        N8N_LISTEN_ADDRESS: '127.0.0.1',
        N8N_USER_FOLDER: this.userFolder(),
        // Editor session over plain-http localhost needs non-secure cookies.
        N8N_SECURE_COOKIE: 'false',
        // Pinned once forever — rotating it bricks n8n's own credential store.
        N8N_ENCRYPTION_KEY: this.encryptionKey!,
        N8N_DIAGNOSTICS_ENABLED: 'false',
        N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
        N8N_PERSONALIZATION_ENABLED: 'false',
        N8N_RUNNERS_ENABLED: 'true',
      };

      const proc = spawn(runtime.nodePath, [this.n8nBinPath(), 'start'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.installDir(),
        env,
      });
      proc.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().trim().split('\n')) console.log(`[n8n] ${line}`);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().trim().split('\n')) console.log(`[n8n] ${line}`);
      });
      this.proc = proc;
      this.port = port;
      this.attachCrashHandler(proc);

      await this.waitForHealth(port);

      if (!this.apiKey) {
        this.setPhase('provisioning');
        await this.provision();
      }

      this.restartCount = 0;
      this.setPhase('running', null);
      await backendPutSetting(this.deps.backendPort, N8N_SETTING_KEYS.enabled, true);
      console.log(`[Cerebro] n8n ready on port ${port}`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Cerebro] n8n start failed:', msg);
      if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
      this.proc = null;
      this.setPhase('crashed', msg);
      return { ok: false, error: msg };
    }
  }

  private attachCrashHandler(proc: ChildProcess): void {
    proc.once('exit', (code, signal) => {
      if (this.proc !== proc) return; // superseded by a newer spawn
      this.proc = null;
      if (this.intentionalStop) return;
      console.log(`[Cerebro] n8n exited unexpectedly (code=${code}, signal=${signal})`);
      if (this.restartCount < MAX_RESTARTS) {
        this.restartCount++;
        console.log(`[Cerebro] Restarting n8n (attempt ${this.restartCount}/${MAX_RESTARTS})...`);
        this.doStart().catch((err) => console.error('[Cerebro] n8n restart failed:', err));
      } else {
        this.setPhase('crashed', 'n8n crashed repeatedly; not restarting.');
      }
    });
  }

  private async ensureEncryptionKey(): Promise<void> {
    if (this.encryptionKey) return;
    this.encryptionKey = crypto.randomBytes(24).toString('hex');
    await backendPutSetting(
      this.deps.backendPort,
      N8N_SETTING_KEYS.encryptionKey,
      encryptForStorage(this.encryptionKey),
    );
  }

  /** First-run: create the synthetic owner, log in, mint the public API key. */
  private async provision(): Promise<void> {
    const baseUrl = this.getEditorBaseUrl();
    if (!baseUrl) throw new Error('n8n base URL unavailable during provisioning');

    if (!this.ownerEmail || !this.ownerPassword) {
      this.ownerEmail = `cerebro-owner-${crypto.randomBytes(4).toString('hex')}@cerebro.local`;
      this.ownerPassword = generateOwnerPassword(crypto.randomBytes(16).toString('hex'));
      await Promise.all([
        backendPutSetting(this.deps.backendPort, N8N_SETTING_KEYS.ownerEmail, this.ownerEmail),
        backendPutSetting(
          this.deps.backendPort,
          N8N_SETTING_KEYS.ownerPassword,
          encryptForStorage(this.ownerPassword),
        ),
      ]);
    }
    const owner = { email: this.ownerEmail, password: this.ownerPassword };

    const setup = await setupOwner(baseUrl, owner);
    if (!setup.ok) throw new Error(`n8n owner setup failed: ${setup.error}`);

    const auth = await login(baseUrl, owner);
    if (!auth.ok || !auth.cookie) throw new Error(`n8n login failed: ${auth.error}`);
    this.setSessionCookie(auth.cookie);

    const key = await createApiKey(baseUrl, auth.cookie);
    if (!key.ok || !key.apiKey) throw new Error(`n8n API key creation failed: ${key.error}`);
    this.apiKey = key.apiKey;
    await backendPutSetting(
      this.deps.backendPort,
      N8N_SETTING_KEYS.apiKey,
      encryptForStorage(this.apiKey),
    );
  }

  private setSessionCookie(cookie: N8nSessionCookie): void {
    this.sessionCookie = cookie;
    this.sessionCookieMintedAt = Date.now();
  }

  /**
   * Returns an editor session cookie, reusing the cached one while it's
   * comfortably inside n8n's 7-day session window — logins verify the
   * password server-side (deliberately slow), so re-logging-in on every
   * editor open would add pure latency.
   */
  private async getSessionCookie(): Promise<N8nSessionCookie | null> {
    const baseUrl = this.getEditorBaseUrl();
    if (!baseUrl || this.phase !== 'running') return null;
    if (
      this.sessionCookie &&
      Date.now() - this.sessionCookieMintedAt < SESSION_COOKIE_MAX_REUSE_MS
    ) {
      return this.sessionCookie;
    }
    if (!this.ownerEmail || !this.ownerPassword) return this.sessionCookie;
    const auth = await login(baseUrl, {
      email: this.ownerEmail,
      password: this.ownerPassword,
    });
    if (auth.ok && auth.cookie) {
      this.setSessionCookie(auth.cookie);
      return auth.cookie;
    }
    return this.sessionCookie;
  }

  /**
   * Prepares the embedded editor and returns the URL to iframe:
   *   - scopes webRequest hooks to the n8n origin that (a) strip
   *     frame-blocking headers and (b) inject the auth cookie into every
   *     request. Injection at the request layer is required: a planted
   *     SameSite=Lax cookie is never sent into a cross-site iframe (the app
   *     is localhost:<vite/app>, n8n is 127.0.0.1:<n8n>), and SameSite=None
   *     needs Secure, which plain-http localhost can't satisfy.
   *   - hands out the one-shot canvas deep-link target when chat touched a
   *     workflow while the Flows screen wasn't mounted.
   */
  async prepareEmbeddedEditor(): Promise<{
    ok: boolean;
    editorUrl?: string;
    workflowId?: string;
    error?: string;
  }> {
    const editorUrl = this.getEditorBaseUrl();
    if (!editorUrl || !this.isConnected()) {
      return { ok: false, error: 'n8n is not running' };
    }

    try {
      const cookie = await this.getSessionCookie();
      if (cookie) this.authCookieHeader = `${cookie.name}=${cookie.value}`;
    } catch (err) {
      // Best-effort — worst case the iframe shows n8n's own login screen
      // instead of a broken canvas.
      console.error('[Cerebro] n8n session cookie refresh failed:', err);
    }

    if (this.hookedOrigin !== editorUrl) {
      // Re-registering replaces the previous filters — keep them scoped to
      // exactly the n8n origin; never touch headers app-wide.
      session.defaultSession.webRequest.onHeadersReceived(
        { urls: [`${editorUrl}/*`] },
        (details, callback) => {
          const headers = { ...details.responseHeaders };
          for (const key of Object.keys(headers)) {
            const lower = key.toLowerCase();
            if (lower === 'x-frame-options') delete headers[key];
            if (lower === 'content-security-policy') {
              headers[key] = headers[key].map((v) => v.replace(/frame-ancestors[^;]*(;|$)/gi, ''));
            }
          }
          callback({ responseHeaders: headers });
        },
      );
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`${editorUrl}/*`] },
        (details, callback) => {
          const requestHeaders = { ...details.requestHeaders };
          if (this.authCookieHeader && !String(requestHeaders.Cookie ?? '').includes('n8n-auth=')) {
            requestHeaders.Cookie = requestHeaders.Cookie
              ? `${requestHeaders.Cookie}; ${this.authCookieHeader}`
              : this.authCookieHeader;
          }
          callback({ requestHeaders });
        },
      );
      this.hookedOrigin = editorUrl;
    }

    const workflowId = this.consumeCanvasTarget();
    return { ok: true, editorUrl, ...(workflowId ? { workflowId } : {}) };
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.cancelInstall();
    const proc = this.proc;
    if (!proc || proc.killed) {
      if (this.phase !== 'not_installed') this.setPhase('stopped');
      return;
    }
    await new Promise<void>((resolve) => {
      const killTimeout = setTimeout(() => {
        if (!proc.killed) {
          console.log('[Cerebro] Force-killing n8n (SIGKILL)');
          proc.kill('SIGKILL');
        }
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(killTimeout);
        resolve();
      });
      proc.kill('SIGTERM');
    });
    this.proc = null;
    this.setPhase('stopped');
    console.log('[Cerebro] n8n stopped');
  }

  /** Synchronous last-resort kill for the process-exit safety net. */
  killNow(): void {
    this.intentionalStop = true;
    if (this.proc && !this.proc.killed) this.proc.kill('SIGKILL');
  }

  /** N8nChannel: lets the Flows screen follow chat-created/edited workflows. */
  notifyWorkflowTouched(workflowId: string): void {
    // Also remember it: if the Flows screen isn't mounted right now (user is
    // on Chat/Approvals), the push event is lost — openEditor hands the
    // pending target out once so the canvas still lands on the new workflow.
    this.pendingCanvasTarget = workflowId;
    if (this.webContents && !this.webContents.isDestroyed()) {
      this.webContents.send(IPC_CHANNELS.N8N_WORKFLOW_TOUCHED, { workflowId });
    }
  }

  private pendingCanvasTarget: string | null = null;

  /** One-shot read of the most recently touched workflow id. */
  private consumeCanvasTarget(): string | null {
    const target = this.pendingCanvasTarget;
    this.pendingCanvasTarget = null;
    return target;
  }
}
