/**
 * SlackBridge — wraps a @slack/bolt App in Socket Mode, dispatches inbound
 * events (DMs, channel mentions, slash commands) to AgentRuntime, and
 * exposes an outbound surface for engine actions (send_slack_message, …).
 *
 * Architecture invariants (mirror Telegram):
 *  - Allowlist gate (channel AND user IDs) before any inference.
 *  - Each Slack thread is one Cerebro conversation (threadKey).
 *  - One in-flight run per thread — duplicate messages reply with a
 *    "still working" note instead of stacking subprocesses.
 *  - Token plaintext stays in the main process; the renderer only sees
 *    `hasBotToken` / `hasAppToken` booleans.
 *  - All outbound chat.update edits are debounced — never stream
 *    token-by-token (Slack's 1/sec/channel limit will throttle us).
 *  - Watchdog reclaims runs idle for 3 min so a stuck Claude Code
 *    subprocess can't block a Slack thread forever.
 */

import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { App, LogLevel } from '@slack/bolt';
import type { WebContents } from 'electron';
import type { AgentRuntime, AgentEventSink, AgentRunRequest, RendererAgentEvent } from '../agents';
import type { ExecutionEvent } from '../engine/events/types';
import { ENGINE_EVENT, type EngineEventContext } from '../engine/events/emitter';
import type { ExecutionEngine } from '../engine/engine';
import type { SlackChannel } from '../engine/actions/slack-channel';
import { IPC_CHANNELS } from '../types/ipc';
import {
  encryptForStorage,
  decryptFromStorage,
  isStoredPlaintext,
  backend as secureTokenBackend,
} from '../secure-token';
import { SlackApi, SlackApiError, scrubTokenish } from './api';
import { SlackStreamSink } from './SlackStreamSink';
import { markdownToMrkdwn } from './mrkdwn';
import { pickApprovalRun } from '../utils/approval-routing';
import { getLoginOrchestrator, type LoginSnapshot } from '../claude-code/login-orchestrator';
import {
  threadKey,
  EventDedupe,
  SlidingWindowLimiter,
  parseSlashCommandText,
  parseSlackTriggerRoutine,
  matchSlackRoutineTriggers,
  stripBotMention,
  redactSlackPayload,
  chunkSlackText,
  type SlackTriggerRoutine,
  type BackendRoutineRecord,
} from './helpers';
import {
  SLACK_SETTING_KEYS,
  type SlackSettings,
  type SlackInboundContext,
} from './types';
import type { SlackStatusResponse } from '../types/ipc';

// ── Tunables ──────────────────────────────────────────────────────

const AUTHORIZED_RATE_LIMIT_PER_MIN = 20;
const PROACTIVE_RATE_LIMIT_PER_HOUR = 30;
const ROUTINE_CACHE_TTL_MS = 30_000;
const RUN_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const RUN_WATCHDOG_INTERVAL_MS = 30_000;
// If no events arrive for IDLE_WATCHDOG_MS while we expect activity, bounce
// the Bolt app. Production fallback for the rare Socket Mode silent-stall.
const IDLE_WATCHDOG_MS = 5 * 60_000;
const IDLE_WATCHDOG_INTERVAL_MS = 60_000;

// ── Helpers ───────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  console.log('[Slack]', ...args.map((a) => (typeof a === 'string' ? scrubTokenish(a) : a)));
}

function logError(...args: unknown[]): void {
  console.error('[Slack]', ...args.map((a) => (typeof a === 'string' ? scrubTokenish(a) : a)));
}

// ── Settings via the backend /settings/{key} API ──────────────────

async function backendGetSetting<T>(port: number, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/settings/${key}`, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as { value: string };
          resolve(JSON.parse(parsed.value) as T);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5_000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function backendPutSetting(port: number, key: string, value: unknown): Promise<void> {
  await backendRequest(port, 'PUT', `/settings/${key}`, { value: JSON.stringify(value) });
}

function backendRequest<T = unknown>(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  return new Promise((resolve) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          let parsed: T | null = null;
          try { parsed = JSON.parse(data) as T; } catch { parsed = null; }
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode ?? 0,
            data: parsed,
          });
        });
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: null }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sanitizeUserExpertAccess(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [userId, expertIds] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(expertIds)) continue;
    const cleaned = expertIds
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out[userId] = Array.from(new Set(cleaned));
  }
  return out;
}

function sanitizeExpertIdList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const cleaned = raw
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(cleaned));
}

function emptySettings(): SlackSettings {
  return {
    botToken: null,
    appToken: null,
    enabled: false,
    allowlistChannels: [],
    allowlistUsers: [],
    threadConversationMap: {},
    threadExpertMap: {},
    userDisplayNames: {},
    defaultExpertAccess: null,
    userExpertAccess: {},
    teamName: null,
    botUserId: null,
    operatorUserId: null,
  };
}

// ── Active-run tracking per thread ────────────────────────────────

interface ActiveSlackRun {
  runId: string;
  conversationId: string;
  sink: SlackStreamSink;
  threadKey: string;
  channel: string;
  /** Undefined for top-level replies (DMs and top-level @mentions). */
  threadTs: string | undefined;
  startedAt: number;
  lastActivityAt: number;
}

// ── Constructor deps ──────────────────────────────────────────────

export interface SlackBridgeDeps {
  backendPort: number;
  agentRuntime: AgentRuntime;
  dataDir: string;
  engineEventBus: EventEmitter;
  executionEngine?: ExecutionEngine;
}

// ── Verify / status response types (local convenience) ─────────────

export interface SlackVerifyResult {
  ok: boolean;
  teamName?: string;
  teamId?: string;
  botUserId?: string;
  error?: string;
}

// ── SlackBridge ───────────────────────────────────────────────────

export class SlackBridge implements SlackChannel {
  private deps: SlackBridgeDeps;
  private settings: SlackSettings = emptySettings();

  /** Bolt App instance (Socket Mode). Null when not running. */
  private app: App | null = null;
  /** Web API client for outbound action sends. Built from the bot token. */
  private api: SlackApi | null = null;

  private running = false;
  private starting = false; // guards against re-entrancy during restart
  private lastError: string | null = null;
  private lastEventAt: number | null = null;

  private dedupe = new EventDedupe(10_000, 10 * 60_000);
  private authorizedRateLimiter = new SlidingWindowLimiter(AUTHORIZED_RATE_LIMIT_PER_MIN, 60_000);
  private proactiveRateLimiter = new SlidingWindowLimiter(PROACTIVE_RATE_LIMIT_PER_HOUR, 60 * 60 * 1_000);
  private unknownLastReply = new Map<string, number>(); // userId → ms

  private activeRuns = new Map<string, ActiveSlackRun>(); // threadKey → run
  private runWatchdogTimer: NodeJS.Timeout | null = null;
  private idleWatchdogTimer: NodeJS.Timeout | null = null;

  /**
   * In-flight Claude Code re-authentication. When the bundled CLI's session
   * expires, we route the sign-in to the configured operator via a DM and
   * accept the paste-back code from their next reply. While `pendingLogin`
   * is set, an inbound DM from `operatorUserId` is intercepted as the code
   * instead of being dispatched to the runner. Settled when the
   * orchestrator emits success/failure or when the timeout fires.
   */
  private pendingLogin: {
    loginId: string;
    operatorUserId: string;
    operatorDmChannel: string;
    /** Original inbound that triggered the auth failure — resent on success. */
    originalCtx: SlackInboundContext;
    originalText: string;
    /** Timer guards against operators who never reply. */
    timeoutTimer: NodeJS.Timeout;
    /** Unsubscribe from the orchestrator. */
    unsubscribe: () => void;
  } | null = null;

  private routineCache: { fetchedAt: number; routines: SlackTriggerRoutine[] } | null = null;

  /** approvalId → { channel, threadTs } so the engine listener can reply
   *  in the originating Slack thread once an approval resolves. threadTs
   *  is undefined when the run was a top-level reply. */
  private approvalThreadMap = new Map<string, { channel: string; threadTs: string | undefined }>();
  private engineListener: ((event: ExecutionEvent, ctx: EngineEventContext) => void) | null = null;

  private webContents: WebContents | null = null;

  constructor(deps: SlackBridgeDeps) {
    this.deps = deps;
  }

  setExecutionEngine(engine: ExecutionEngine): void {
    this.deps.executionEngine = engine;
  }

  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  // ── Public lifecycle ────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      await this.loadSettings();

      if (!this.settings.enabled || !this.settings.botToken || !this.settings.appToken) {
        const reason = !this.settings.botToken || !this.settings.appToken
          ? 'Bot token and/or app-level token not configured.'
          : 'Slack bridge is disabled.';
        this.lastError = reason;
        log(`bridge not started: ${reason}`);
        return;
      }

      // Probe the bot token before we open the socket so a bad token surfaces
      // immediately in the UI rather than hidden in a Bolt log line.
      this.api = new SlackApi(this.settings.botToken);
      let auth;
      try {
        auth = await this.api.authTest();
        this.settings.teamName = auth.team ?? null;
        this.settings.botUserId = auth.user_id ?? null;
        await this.persistTeamMetadata();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logError('auth.test failed —', this.lastError);
        this.api = null;
        return;
      }

      // Spin up Bolt in Socket Mode.
      this.app = new App({
        token: this.settings.botToken,
        appToken: this.settings.appToken,
        socketMode: true,
        logLevel: LogLevel.INFO,
        // Bolt's WebClient retries on 429 automatically; we don't need to
        // configure retryConfig here.
      });

      this.wireBoltHandlers();

      try {
        await this.app.start();
        this.running = true;
        this.lastError = null;
        this.lastEventAt = Date.now();
        this.subscribeToEngineEvents();
        this.startRunWatchdog();
        this.startIdleWatchdog();
        log(`bridge started as ${auth.user} on team "${auth.team}" (${auth.team_id})`);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        logError('app.start() failed —', this.lastError);
        this.app = null;
        this.api = null;
      }
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.engineListener) {
      this.deps.engineEventBus.off(ENGINE_EVENT, this.engineListener);
      this.engineListener = null;
    }
    if (this.runWatchdogTimer) {
      clearInterval(this.runWatchdogTimer);
      this.runWatchdogTimer = null;
    }
    if (this.idleWatchdogTimer) {
      clearInterval(this.idleWatchdogTimer);
      this.idleWatchdogTimer = null;
    }

    // Cancel in-flight runs.
    for (const [, run] of this.activeRuns) {
      try { this.deps.agentRuntime.cancelRun(run.runId); } catch { /* ignore */ }
    }
    this.activeRuns.clear();
    this.approvalThreadMap.clear();

    if (this.app) {
      try { await this.app.stop(); } catch (err) {
        logError('app.stop() threw:', err instanceof Error ? err.message : String(err));
      }
      this.app = null;
    }
    this.api = null;
    log('bridge stopped');
  }

  async reloadSettings(): Promise<{ ok: boolean; error?: string }> {
    try {
      const prevBot = this.settings.botToken;
      const prevApp = this.settings.appToken;
      await this.loadSettings();
      this.routineCache = null;
      if (this.running && (this.settings.botToken !== prevBot || this.settings.appToken !== prevApp)) {
        return { ok: false, error: 'Tokens changed — disable and re-enable Slack to apply.' };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('reloadSettings failed', msg);
      return { ok: false, error: msg };
    }
  }

  /** Probe a candidate (botToken, appToken) pair without persisting. */
  async verifyTokens(botToken: string, appToken: string): Promise<SlackVerifyResult> {
    try {
      const probe = new SlackApi(botToken);
      const info = await probe.authTest();
      // app-level token round-trip: open() + immediately drop the URL.
      if (appToken) {
        await probe.appsConnectionsOpen(appToken);
      }
      return {
        ok: true,
        teamName: info.team,
        teamId: info.team_id,
        botUserId: info.user_id,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrubTokenish(msg) };
    }
  }

  status(): SlackStatusResponse {
    return {
      running: this.running,
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      teamName: this.settings.teamName,
      botUserId: this.settings.botUserId,
      hasBotToken: Boolean(this.settings.botToken),
      hasAppToken: Boolean(this.settings.appToken),
      tokenBackend: secureTokenBackend(),
      enabled: this.settings.enabled,
      allowlistChannels: [...this.settings.allowlistChannels],
      allowlistUsers: [...this.settings.allowlistUsers],
      operatorUserId: this.settings.operatorUserId,
    };
  }

  /**
   * Persist the bot+app token pair (or clear them). Encrypts before writing.
   * If a clear is requested (both null), the bridge is stopped and stays off.
   */
  async setTokens(args: { botToken: string | null; appToken: string | null }): Promise<{ ok: boolean; error?: string }> {
    try {
      const port = this.deps.backendPort;
      const wasRunning = this.running;

      const botVal = args.botToken ? encryptForStorage(args.botToken) : '';
      const appVal = args.appToken ? encryptForStorage(args.appToken) : '';

      // Replacing tokens (both present) on a live bridge must NOT hot-restart.
      // We persist the new pair so a later disable→enable picks it up, but we
      // leave the running bridge — and its in-memory tokens — untouched and ask
      // the operator to re-enable. Otherwise the bridge would silently bounce,
      // dropping in-flight Socket Mode runs.
      const isReplacement = Boolean(args.botToken && args.appToken);
      if (wasRunning && isReplacement) {
        const changed = args.botToken !== this.settings.botToken
          || args.appToken !== this.settings.appToken;
        if (changed) {
          await backendPutSetting(port, SLACK_SETTING_KEYS.botToken, botVal);
          await backendPutSetting(port, SLACK_SETTING_KEYS.appToken, appVal);
          return { ok: false, error: 'Tokens changed — disable and re-enable Slack to apply.' };
        }
        return { ok: true };
      }

      await backendPutSetting(port, SLACK_SETTING_KEYS.botToken, botVal);
      await backendPutSetting(port, SLACK_SETTING_KEYS.appToken, appVal);

      this.settings.botToken = args.botToken;
      this.settings.appToken = args.appToken;

      // Remaining live cases (clearing tokens, or a partial pair) stop the
      // bridge and stay off — the bridge can't run without a full token pair.
      if (wasRunning) {
        await this.stop();
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('setTokens failed', msg);
      return { ok: false, error: msg };
    }
  }

  async clearTokens(): Promise<{ ok: boolean; error?: string }> {
    return this.setTokens({ botToken: null, appToken: null });
  }

  async setAllowlist(args: { channels: string[]; users: string[] }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.settings.allowlistChannels = [...new Set(args.channels)];
      this.settings.allowlistUsers = [...new Set(args.users)];
      await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.allowlistChannels, this.settings.allowlistChannels);
      await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.allowlistUsers, this.settings.allowlistUsers);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  getOperatorUserId(): string | null {
    return this.settings.operatorUserId;
  }

  async setOperatorUserId(userId: string | null): Promise<{ ok: boolean; error?: string }> {
    try {
      const trimmed = (userId ?? '').trim() || null;
      this.settings.operatorUserId = trimmed;
      await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.operatorUserId, trimmed ?? '');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Snapshot of expert access for the renderer:
   *   - `defaultExpertAccess`: `null` = unrestricted workspace, `string[]` = baseline.
   *   - `exceptions`: per-user overrides. `expertIds: ['*']` means full access.
   * Display names come from `userDisplayNames`; the UI refreshes missing
   * ones via the `listWorkspaceUsers` IPC.
   */
  getExpertAccessConfig(): {
    defaultExpertAccess: string[] | null;
    exceptions: Array<{ userId: string; displayName: string | null; expertIds: string[] }>;
  } {
    const exceptions = Object.entries(this.settings.userExpertAccess).map(([userId, expertIds]) => ({
      userId,
      displayName: this.settings.userDisplayNames[userId] ?? null,
      expertIds: Array.isArray(expertIds) ? [...expertIds] : [],
    }));
    return {
      defaultExpertAccess: this.settings.defaultExpertAccess === null ? null : [...this.settings.defaultExpertAccess],
      exceptions,
    };
  }

  async setExpertAccessConfig(
    args: {
      defaultExpertAccess: string[] | null;
      exceptions: Array<{ userId: string; expertIds: string[] }>;
    },
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const def = args.defaultExpertAccess === null
        ? null
        : Array.from(new Set(
          (args.defaultExpertAccess ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0),
        ));

      const nextExceptions: Record<string, string[]> = {};
      for (const { userId, expertIds } of args.exceptions ?? []) {
        if (!userId || typeof userId !== 'string') continue;
        if (!Array.isArray(expertIds)) continue;
        nextExceptions[userId] = Array.from(new Set(
          expertIds.filter((s): s is string => typeof s === 'string' && s.length > 0),
        ));
      }

      this.settings.defaultExpertAccess = def;
      this.settings.userExpertAccess = nextExceptions;
      await Promise.all([
        this.persistDefaultExpertAccess(),
        this.persistUserExpertAccess(),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Fetch the visible workspace user directory (humans only). Used by the
   * Settings UI to render the "add person" picker without ever exposing
   * Slack user IDs to operators.
   */
  async listWorkspaceUsers(): Promise<{
    ok: boolean;
    users?: Array<{ id: string; name: string; email?: string; avatarUrl?: string }>;
    error?: string;
  }> {
    if (!this.api || !this.running) {
      return { ok: false, error: 'Slack bridge not running' };
    }
    try {
      const users = await this.api.usersList();
      // Cache display names so subsequent UI loads + bridge log lines have them.
      let dirty = false;
      for (const u of users) {
        if (u.name && !this.settings.userDisplayNames[u.id]) {
          this.settings.userDisplayNames[u.id] = u.name;
          dirty = true;
        }
      }
      if (dirty) void this.persistUserDisplayNames();
      return { ok: true, users };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrubTokenish(msg) };
    }
  }

  /** Read the shipped manifest YAML so the renderer can offer "Copy manifest". */
  async getManifestYaml(): Promise<string> {
    // The manifest lives next to this file. In production builds it's bundled
    // by Vite into the asar — read it with fs at runtime so updates work.
    try {
      const here = path.join(this.deps.dataDir, '..', 'app', 'slack-manifest.yaml');
      if (fs.existsSync(here)) return fs.readFileSync(here, 'utf8');
    } catch { /* fall through */ }
    // Fallback: read from the source path (dev mode).
    try {
      const dev = path.join(__dirname, 'manifest.yaml');
      if (fs.existsSync(dev)) return fs.readFileSync(dev, 'utf8');
    } catch { /* fall through */ }
    // Last resort: inline manifest (matches src/slack/manifest.yaml).
    return INLINE_MANIFEST;
  }

  // ── SlackChannel implementation (engine outbound surface) ───────

  isConnected(): boolean {
    return this.running && this.api !== null && this.settings.enabled === true;
  }

  isAllowlisted(channelId: string, userId?: string): boolean {
    const channels = this.settings.allowlistChannels;
    const users = this.settings.allowlistUsers;
    // Closed-by-default: both lists empty means nothing is allowed (mirrors
    // Telegram's "no allowlist = nothing happens"). Operators must explicitly
    // opt in their workspace.
    if (channels.length === 0 && users.length === 0) return false;
    const channelOk = channels.length === 0 || channels.includes('*') || channels.includes(channelId);
    const userOk = users.length === 0 || (userId !== undefined && (users.includes('*') || users.includes(userId)));
    if (channels.length > 0 && users.length > 0) return channelOk && userOk;
    if (channels.length > 0) return channelOk;
    return userOk;
  }

  async sendActionMessage(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ messageTs: string | null; channelId: string | null; error: string | null }> {
    if (!this.api || !this.running) {
      return { messageTs: null, channelId: null, error: 'Slack bridge not running' };
    }
    if (!this.isAllowlisted(channel)) {
      return { messageTs: null, channelId: null, error: `channel ${channel} not in allowlist` };
    }
    if (!this.proactiveRateLimiter.allow(channel)) {
      return { messageTs: null, channelId: null, error: `channel ${channel} rate-limited` };
    }
    const safeText = markdownToMrkdwn(scrubTokenish(text));
    const chunks = chunkSlackText(safeText, 3500);
    let firstTs: string | null = null;
    let lastChannel: string | null = null;
    try {
      for (const chunk of chunks) {
        const res = await this.api.chatPostMessage({
          channel,
          text: chunk,
          thread_ts: threadTs,
        });
        if (firstTs === null) firstTs = res.ts;
        lastChannel = res.channel;
      }
      return { messageTs: firstTs, channelId: lastChannel, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { messageTs: firstTs, channelId: lastChannel, error: scrubTokenish(msg) };
    }
  }

  async sendFileActionMessage(
    channel: string,
    filePath: string,
    options?: { comment?: string; threadTs?: string; fileName?: string },
  ): Promise<{ fileId: string | null; error: string | null }> {
    if (!this.api || !this.running) {
      return { fileId: null, error: 'Slack bridge not running' };
    }
    if (!this.isAllowlisted(channel)) {
      return { fileId: null, error: `channel ${channel} not in allowlist` };
    }
    if (!this.proactiveRateLimiter.allow(channel)) {
      return { fileId: null, error: `channel ${channel} rate-limited` };
    }
    if (!fs.existsSync(filePath)) {
      return { fileId: null, error: `file not found: ${filePath}` };
    }
    try {
      const res = await this.api.filesUpload({
        channelId: channel,
        filePath,
        threadTs: options?.threadTs,
        initialComment: options?.comment ? scrubTokenish(options.comment) : undefined,
        fileName: options?.fileName,
      });
      return { fileId: res.fileId ?? null, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { fileId: null, error: scrubTokenish(msg) };
    }
  }

  async listChannels(): Promise<{ ok: boolean; channels?: Array<{ id: string; name: string; is_private: boolean }>; error?: string }> {
    if (!this.api || !this.running) {
      return { ok: false, error: 'Slack bridge not running' };
    }
    try {
      const list = await this.api.conversationsList();
      return {
        ok: true,
        channels: list
          .filter((c) => !c.is_im && !c.is_archived)
          .map((c) => ({ id: c.id, name: c.name, is_private: c.is_private })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: scrubTokenish(msg) };
    }
  }

  // ── Bolt handler wiring ─────────────────────────────────────────

  private wireBoltHandlers(): void {
    if (!this.app) return;
    const app = this.app;

    // Global error handler — never let an exception kill the bridge.
    app.error(async (err) => {
      logError('Bolt error:', err instanceof Error ? err.message : String(err));
    });

    // @cerebro in a channel.
    app.event('app_mention', async ({ event, body, client, logger }) => {
      this.lastEventAt = Date.now();
      try {
        if (!this.dedupe.observe(body.event_id ?? `${event.channel}:${event.ts}`)) return;
        // event.text contains the mention prefix; strip our bot id.
        const stripped = stripBotMention(event.text ?? '', this.settings.botUserId);
        const ctx: SlackInboundContext = {
          eventId: body.event_id ?? `${event.channel}:${event.ts}`,
          teamId: body.team_id ?? this.settings.botUserId ?? '',
          channel: event.channel,
          channelType: 'channel',
          userId: event.user ?? '',
          ts: event.ts,
          // Only set when Slack actually delivered a thread_ts (i.e. the
          // mention was inside an existing thread). Leaving it undefined
          // makes our reply land at the channel top level.
          threadTs: event.thread_ts,
          text: stripped,
          surface: 'app_mention',
        };
        await this.handleInbound(ctx);
      } catch (err) {
        logger.error?.(scrubTokenish(err instanceof Error ? err.message : String(err)));
        await this.safeReplyError(event.channel, event.thread_ts ?? event.ts, err);
      }
    });

    // DM to the bot.
    app.event('message', async ({ event, body, logger }) => {
      this.lastEventAt = Date.now();
      // Type-narrow the event union — we only care about user-typed text DMs.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = event as any;
      if (m.channel_type !== 'im') return;
      if (m.subtype) return; // skip edits, bot_messages, joins, etc.
      if (m.bot_id || m.user === this.settings.botUserId) return;
      try {
        const eid = body.event_id ?? `${m.channel}:${m.ts}`;
        if (!this.dedupe.observe(eid)) return;
        const ctx: SlackInboundContext = {
          eventId: eid,
          teamId: body.team_id ?? '',
          channel: m.channel,
          channelType: 'im',
          userId: m.user,
          ts: m.ts,
          // DMs almost never carry a thread_ts; when they don't, our reply
          // lands at the top of the DM channel (no thread side panel).
          threadTs: m.thread_ts,
          text: m.text ?? '',
          surface: 'message_im',
        };
        await this.handleInbound(ctx);
      } catch (err) {
        logger.error?.(scrubTokenish(err instanceof Error ? err.message : String(err)));
        await this.safeReplyError(m.channel, m.thread_ts ?? m.ts, err);
      }
    });

    // /cerebro slash command.
    app.command('/cerebro', async ({ command, ack, respond, client }) => {
      // ACK within 3s before doing anything else.
      await ack();
      this.lastEventAt = Date.now();
      try {
        await this.handleSlashCommand(command, respond);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError('slash command handler threw:', msg);
        try {
          await respond({
            response_type: 'ephemeral',
            text: `:warning: Cerebro hit an error: ${scrubTokenish(msg)}`,
          });
        } catch { /* ignore */ }
      }
    });

    // App Home — render the welcome view.
    app.event('app_home_opened', async ({ event, client }) => {
      this.lastEventAt = Date.now();
      try {
        await client.views.publish({
          user_id: event.user,
          view: this.buildHomeTabView(),
        });
      } catch (err) {
        logError('views.publish failed:', err instanceof Error ? err.message : String(err));
      }
    });
  }

  // ── Inbound dispatch ────────────────────────────────────────────

  private async handleInbound(ctx: SlackInboundContext): Promise<void> {
    if (!this.api) return;
    if (!ctx.userId) return;

    // 0. Auth paste-back intercept. If the bundled Claude Code CLI is
    //    re-authenticating and this DM is the operator replying with the
    //    code, route it to the orchestrator instead of dispatching to the
    //    runner (which would just hit the same auth failure again).
    if (
      this.pendingLogin
      && ctx.channelType === 'im'
      && ctx.userId === this.pendingLogin.operatorUserId
    ) {
      await this.handleOperatorAuthCode(ctx.text ?? '');
      return;
    }

    // 1. Allowlist gate — same check as outbound, but for inbound we let the
    //    user know their ID if they're not on the list (rate-limited).
    if (!this.isAllowlisted(ctx.channel, ctx.userId)) {
      const last = this.unknownLastReply.get(ctx.userId) ?? 0;
      if (Date.now() - last > 60 * 60_000) {
        this.unknownLastReply.set(ctx.userId, Date.now());
        try {
          await this.api.chatPostEphemeral({
            channel: ctx.channel,
            user: ctx.userId,
            thread_ts: ctx.threadTs,
            text: `Not authorised. Your Slack ID is ${ctx.userId}. Ask the Cerebro operator to add you to the allowlist.`,
          });
        } catch { /* ignore */ }
      }
      return;
    }

    // 2. Rate limit per user.
    if (!this.authorizedRateLimiter.allow(ctx.userId)) {
      try {
        await this.api.chatPostEphemeral({
          channel: ctx.channel,
          user: ctx.userId,
          thread_ts: ctx.threadTs,
          text: 'Rate limit exceeded. Try again in a minute.',
        });
      } catch { /* ignore */ }
      return;
    }

    // 3. Inline expert commands ("expert list", "expert <slug>", "expert clear")
    //    work in DMs and channel threads as plain text too — parity with Telegram.
    const trimmed = (ctx.text ?? '').trim();
    if (/^expert(\s|$)/i.test(trimmed)) {
      await this.handleInlineExpertCommand(ctx, trimmed);
      return;
    }

    const key = threadKey({ teamId: ctx.teamId, channel: ctx.channel, ts: ctx.ts, threadTs: ctx.threadTs });
    // Captured before ensureConversation creates one: tells the runtime whether
    // to --resume an existing Claude Code session or --session-id a fresh one.
    const conversationExisted = !!this.settings.threadConversationMap[key];
    let conversationId = await this.ensureConversation(key, ctx);

    // 4. Persist the inbound user message.
    conversationId = await this.postUserMessageWithRecovery(conversationId, ctx);
    this.emitConversationUpdated(conversationId, 'message');

    // 5. Routine trigger dispatch — if any match, fire and skip the AI reply.
    const matchedRoutines = await this.matchSlackTriggers(ctx);
    if (matchedRoutines.length > 0) {
      const displayName = await this.resolveDisplayName(ctx.userId);
      for (const routine of matchedRoutines) {
        await this.dispatchRoutine(routine, {
          channel: ctx.channel,
          channel_type: ctx.channelType ?? null,
          user_id: ctx.userId,
          user_name: displayName ?? null,
          thread_ts: ctx.threadTs ?? ctx.ts,
          ts: ctx.ts,
          message_text: trimmed,
          received_at: new Date(Number(ctx.ts.split('.')[0]) * 1000).toISOString(),
          conversation_id: conversationId,
        });
      }
      return;
    }

    // 6. Skip empty bodies.
    if (!trimmed) return;

    // 7. Concurrency: one in-flight run per thread.
    const existing = this.activeRuns.get(key);
    if (existing) {
      const elapsedSec = Math.round((Date.now() - existing.startedAt) / 1000);
      const elapsedLabel = elapsedSec < 60
        ? `${elapsedSec}s`
        : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
      try {
        await this.api.chatPostMessage({
          channel: ctx.channel,
          thread_ts: ctx.threadTs ?? ctx.ts,
          text: `:hourglass_flowing_sand: Still working on your last message (${elapsedLabel} so far). One thing at a time per thread.`,
        });
      } catch { /* ignore */ }
      return;
    }

    // 8. Start the agent run. Reply lands at the channel/DM top level unless
    //    the inbound message was already inside an existing thread — keeps
    //    Cerebro from forcing users to open a thread side panel for every
    //    DM or top-level @mention.
    const threadTsForReply = ctx.threadTs;
    const bumpActivity = () => {
      const r = this.activeRuns.get(key);
      if (r) r.lastActivityAt = Date.now();
    };

    const sink = new SlackStreamSink({
      api: this.api,
      channel: ctx.channel,
      threadTs: threadTsForReply,
      placeholder: '_Cerebro is thinking…_',
      onDone: async (finalText, err) => {
        try {
          if (!err) {
            await backendRequest(this.deps.backendPort, 'POST', `/conversations/${conversationId}/messages`, {
              id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
              role: 'assistant',
              content: finalText,
              metadata: {
                source: 'slack',
                slack_channel: ctx.channel,
                slack_thread_ts: threadTsForReply,
                slack_team_id: ctx.teamId,
              },
            });
            this.emitConversationUpdated(conversationId, 'message');
          }
        } finally {
          this.activeRuns.delete(key);
        }
      },
      onActivity: bumpActivity,
      onAuthFailure: async () => this.handleAuthFailure(ctx, trimmed),
    });

    const accessibleExpertIds = this.getAccessibleExpertIds(ctx.userId);
    let expertId = this.settings.threadExpertMap[key] ?? null;
    if (expertId && accessibleExpertIds !== null && !accessibleExpertIds.includes(expertId)) {
      // The user has lost access to the pinned expert since it was set. Drop
      // the pin and fall back to the default Cerebro agent (which will itself
      // honour accessibleExpertIds for any delegation).
      log(`pinned expert ${expertId} no longer accessible to user ${ctx.userId}; falling back to default agent`);
      delete this.settings.threadExpertMap[key];
      void this.persistThreadExpertMap();
      expertId = null;
    }

    const runRequest: AgentRunRequest = {
      conversationId,
      content: trimmed,
      expertId,
      // The bridge doesn't ship a transcript — Claude Code's own --resume
      // carries history — so hint the create-vs-resume decision explicitly.
      resume: conversationExisted,
      source: { kind: 'slack', channel: ctx.channel, threadTs: threadTsForReply, teamId: ctx.teamId },
      accessibleExpertIds,
    };

    try {
      const runId = await this.deps.agentRuntime.startRun(sink, runRequest);
      const now = Date.now();
      this.activeRuns.set(key, {
        runId,
        conversationId,
        sink,
        threadKey: key,
        channel: ctx.channel,
        threadTs: threadTsForReply,
        startedAt: now,
        lastActivityAt: now,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Runtime-level single-flight: another run on this thread is already in
      // flight (a race past the early-peek gate above). Surface the same
      // "still working" UX instead of leaking the raw internal error.
      if (err instanceof Error && err.name === 'ConversationBusyError') {
        try {
          await this.api.chatPostMessage({
            channel: ctx.channel,
            thread_ts: threadTsForReply,
            text: ':hourglass_flowing_sand: Still working on your last message — I’ll reply here when it’s done.',
          });
        } catch { /* ignore */ }
        return;
      }
      logError('startRun failed', errMsg);
      try {
        await this.api.chatPostMessage({
          channel: ctx.channel,
          thread_ts: threadTsForReply,
          text: ':warning: Something went wrong starting that. Please try again in a moment.',
        });
      } catch { /* ignore */ }
    }
  }

  private async handleInlineExpertCommand(ctx: SlackInboundContext, raw: string): Promise<void> {
    if (!this.api) return;
    const args = raw.replace(/^expert\s*/i, '').trim();
    const key = threadKey({ teamId: ctx.teamId, channel: ctx.channel, ts: ctx.ts, threadTs: ctx.threadTs });
    if (!args || args.toLowerCase() === 'list') {
      await this.replyExpertsList(ctx.channel, ctx.threadTs ?? ctx.ts, ctx.userId, key);
      return;
    }
    if (args.toLowerCase() === 'clear' || args.toLowerCase() === 'reset' || args.toLowerCase() === 'off') {
      delete this.settings.threadExpertMap[key];
      await this.persistThreadExpertMap();
      try {
        await this.api.chatPostEphemeral({
          channel: ctx.channel, user: ctx.userId, thread_ts: ctx.threadTs ?? ctx.ts,
          text: ':white_check_mark: Expert cleared. This thread now uses the default Cerebro agent.',
        });
      } catch { /* ignore */ }
      return;
    }
    await this.setThreadExpert(ctx.channel, ctx.threadTs ?? ctx.ts, ctx.userId, key, args);
  }

  // ── Slash command handler ──────────────────────────────────────

  private async handleSlashCommand(
    command: { command: string; text: string; channel_id: string; user_id: string; team_id: string; response_url: string; trigger_id: string },
    respond: (msg: { response_type?: 'ephemeral' | 'in_channel'; text: string }) => Promise<unknown>,
  ): Promise<void> {
    // Allowlist check: even for slash commands, fall through if the user can't talk to Cerebro here.
    if (!this.isAllowlisted(command.channel_id, command.user_id)) {
      await respond({
        response_type: 'ephemeral',
        text: `Not authorised. Your Slack ID is ${command.user_id}. Ask the Cerebro operator to add you to the allowlist.`,
      });
      return;
    }
    if (!this.authorizedRateLimiter.allow(command.user_id)) {
      await respond({ response_type: 'ephemeral', text: 'Rate limit exceeded. Try again in a minute.' });
      return;
    }

    const parsed = parseSlashCommandText(command.text ?? '');
    if (parsed.verb === 'help' || parsed.verb === 'empty') {
      await respond({ response_type: 'ephemeral', text: this.helpMenuText() });
      return;
    }
    if (parsed.verb === 'status') {
      const s = this.status();
      const lines = [
        `*Cerebro Slack bridge*`,
        `• Running: ${s.running ? ':white_check_mark:' : ':no_entry_sign:'}`,
        s.teamName ? `• Workspace: ${s.teamName}` : null,
        s.lastEventAt ? `• Last event: <!date^${Math.floor(s.lastEventAt / 1000)}^{date_short_pretty} {time}|recently>` : null,
        s.lastError ? `• Last error: \`${scrubTokenish(s.lastError)}\`` : null,
      ].filter(Boolean) as string[];
      await respond({ response_type: 'ephemeral', text: lines.join('\n') });
      return;
    }
    if (parsed.verb === 'experts') {
      const list = await this.fetchExperts();
      if (list.length === 0) {
        await respond({ response_type: 'ephemeral', text: 'No experts configured yet.' });
        return;
      }
      const lines = list.map((e) => `• \`${e.slug ?? e.id}\` — ${e.name}`);
      await respond({
        response_type: 'ephemeral',
        text: `*Available experts*\n${lines.join('\n')}\n\nPin one to this conversation with \`/cerebro expert <slug>\`.`,
      });
      return;
    }
    if (parsed.verb === 'expert') {
      // Slash commands are top-level — they don't carry a thread_ts. Pin the
      // expert to the per-channel DM thread (we use the channel id as the
      // thread root when there isn't one).
      const key = `${command.team_id}:${command.channel_id}:slash`;
      if (parsed.sub === 'list' || !parsed.slug) {
        await this.replyExpertsList(command.channel_id, undefined, command.user_id, key, respond);
        return;
      }
      if (parsed.sub === 'clear') {
        delete this.settings.threadExpertMap[key];
        await this.persistThreadExpertMap();
        await respond({ response_type: 'ephemeral', text: ':white_check_mark: Expert cleared.' });
        return;
      }
      await this.setThreadExpert(command.channel_id, undefined, command.user_id, key, parsed.slug, respond);
      return;
    }
    if (parsed.verb === 'ask') {
      // Inference takes longer than the 3-second ack window — respond now,
      // post the real reply via the loopback `response_url` once it's ready.
      await respond({ response_type: 'ephemeral', text: '_Cerebro is thinking…_' });
      await this.runSlashCommandQuery(command, parsed.text);
      return;
    }
    await respond({
      response_type: 'ephemeral',
      text: 'I didn\'t understand that. Try `/cerebro help`.',
    });
  }

  private async runSlashCommandQuery(
    command: { command: string; text: string; channel_id: string; user_id: string; team_id: string; response_url: string; trigger_id: string },
    text: string,
  ): Promise<void> {
    // Build a fresh conversation rooted in the slash command — slash commands
    // are stateless from Slack's POV, so each fires a one-shot exchange.
    const key = `${command.team_id}:${command.channel_id}:slash:${Date.now()}`;
    const ctx: SlackInboundContext = {
      eventId: key,
      teamId: command.team_id,
      channel: command.channel_id,
      channelType: 'channel',
      userId: command.user_id,
      ts: String(Date.now() / 1000),
      threadTs: undefined,
      text,
      surface: 'slash_command',
      slashCommand: {
        command: command.command,
        text,
        responseUrl: command.response_url,
        triggerId: command.trigger_id,
      },
    };

    const conversationId = await this.ensureConversation(key, ctx);
    await this.postUserMessageWithRecovery(conversationId, ctx);
    this.emitConversationUpdated(conversationId, 'message');

    // Collect the response into a single buffer; respond ephemerally when done.
    let buffer = '';
    const sink: AgentEventSink = {
      send: (_channel: string, ...args: unknown[]) => {
        const event = args[0] as RendererAgentEvent | undefined;
        if (!event) return;
        if (event.type === 'text_delta' && 'delta' in event) buffer += event.delta;
        if (event.type === 'done' && 'messageContent' in event) {
          buffer = event.messageContent || buffer;
          void this.respondLate(command.response_url, buffer);
        }
        if (event.type === 'error' && 'error' in event) {
          void this.respondLate(command.response_url, `:warning: ${scrubTokenish(event.error)}`);
        }
      },
      isDestroyed: () => false,
    };
    const accessibleExpertIds = this.getAccessibleExpertIds(command.user_id);
    let slashExpertId = this.settings.threadExpertMap[`${command.team_id}:${command.channel_id}:slash`] ?? null;
    if (slashExpertId && accessibleExpertIds !== null && !accessibleExpertIds.includes(slashExpertId)) {
      slashExpertId = null;
    }
    try {
      await this.deps.agentRuntime.startRun(sink, {
        conversationId,
        content: text,
        expertId: slashExpertId,
        source: { kind: 'slack', channel: command.channel_id, threadTs: undefined, teamId: command.team_id },
        accessibleExpertIds,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void this.respondLate(command.response_url, `:warning: ${scrubTokenish(msg)}`);
    }
  }

  /** Late-respond using the slash command's `response_url`. */
  private async respondLate(responseUrl: string, text: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.respondToSlashCommand({ responseUrl, text, inChannel: false, replace: true });
    } catch (err) {
      logError('respondLate failed', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Conversation persistence ───────────────────────────────────

  private async ensureConversation(key: string, ctx: SlackInboundContext): Promise<string> {
    const existing = this.settings.threadConversationMap[key];
    if (existing) return existing;
    return this.createConversation(key, ctx);
  }

  private async createConversation(key: string, ctx: SlackInboundContext): Promise<string> {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const username = (await this.resolveDisplayName(ctx.userId)) ?? ctx.userId;
    const channelLabel = ctx.channelType === 'im' ? `DM with ${username}` : `Slack #${ctx.channel}`;
    await backendRequest(this.deps.backendPort, 'POST', '/conversations', {
      id,
      title: channelLabel,
      source: 'slack',
      external_chat_id: key,
    });
    this.settings.threadConversationMap[key] = id;
    await this.persistThreadConversationMap();
    return id;
  }

  private async postUserMessageWithRecovery(conversationId: string, ctx: SlackInboundContext): Promise<string> {
    const body = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
      role: 'user' as const,
      content: ctx.text || '(empty message)',
      metadata: {
        source: 'slack',
        slack_channel: ctx.channel,
        slack_user_id: ctx.userId,
        slack_thread_ts: ctx.threadTs ?? ctx.ts,
        slack_team_id: ctx.teamId,
        slack_event_id: ctx.eventId,
      },
    };
    const res = await backendRequest(this.deps.backendPort, 'POST', `/conversations/${conversationId}/messages`, body);
    if (res.status !== 404) return conversationId;
    // Stale mapping → recreate.
    const key = threadKey({ teamId: ctx.teamId, channel: ctx.channel, ts: ctx.ts, threadTs: ctx.threadTs });
    delete this.settings.threadConversationMap[key];
    const fresh = await this.createConversation(key, ctx);
    await backendRequest(this.deps.backendPort, 'POST', `/conversations/${fresh}/messages`, {
      ...body,
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 32),
    });
    return fresh;
  }

  private emitConversationUpdated(conversationId: string, kind: 'created' | 'message'): void {
    if (!this.webContents) return;
    try {
      this.webContents.send(IPC_CHANNELS.SLACK_CONVERSATION_UPDATED, { conversationId, kind });
    } catch { /* ignore */ }
  }

  // ── Expert resolution ──────────────────────────────────────────

  private async fetchExperts(): Promise<Array<{ id: string; slug: string | null; name: string }>> {
    const res = await backendRequest<{ experts: Array<{ id: string; slug: string | null; name: string }> }>(
      this.deps.backendPort, 'GET', '/experts',
    );
    return res.data?.experts ?? [];
  }

  /**
   * Resolve the effective expert allowlist for a Slack user.
   *
   * Returns `null` for "unrestricted — every expert is allowed". Returns a
   * `string[]` for a curated set (possibly empty = no experts allowed).
   *
   * Resolution order:
   *  1. Per-user override (`userExpertAccess[userId]`) wins when present.
   *     The sentinel value `'*'` in the override array means "full access"
   *     (used to grant admins everything when the workspace default is
   *     restrictive). Otherwise the listed ids are the only ones allowed.
   *  2. Workspace default (`defaultExpertAccess`) — `null` = unrestricted,
   *     `string[]` = baseline for everyone without a per-user entry.
   */
  private getAccessibleExpertIds(userId: string | undefined): string[] | null {
    if (!userId) return this.settings.defaultExpertAccess;
    const entry = this.settings.userExpertAccess?.[userId];
    if (Array.isArray(entry)) {
      if (entry.includes('*')) return null;
      return entry;
    }
    return this.settings.defaultExpertAccess;
  }

  private filterExpertsForUser<E extends { id: string }>(experts: E[], userId: string | undefined): E[] {
    const allow = this.getAccessibleExpertIds(userId);
    if (allow === null) return experts;
    const set = new Set(allow);
    return experts.filter((e) => set.has(e.id));
  }

  private async replyExpertsList(
    channel: string,
    threadTs: string | undefined,
    user: string,
    key: string,
    respond?: (msg: { response_type?: 'ephemeral' | 'in_channel'; text: string }) => Promise<unknown>,
  ): Promise<void> {
    const all = await this.fetchExperts();
    if (all.length === 0) {
      const txt = 'No experts configured yet.';
      if (respond) await respond({ response_type: 'ephemeral', text: txt });
      else if (this.api) await this.api.chatPostEphemeral({ channel, user, thread_ts: threadTs, text: txt });
      return;
    }
    const experts = this.filterExpertsForUser(all, user);
    if (experts.length === 0) {
      const txt = 'No experts have been assigned to you yet. Ask your Cerebro operator.';
      if (respond) await respond({ response_type: 'ephemeral', text: txt });
      else if (this.api) await this.api.chatPostEphemeral({ channel, user, thread_ts: threadTs, text: txt });
      return;
    }
    const lines = experts.map((e) => `• \`${e.slug ?? e.id}\` — ${e.name}`);
    const current = this.settings.threadExpertMap[key];
    const currentLine = current ? `\n\nCurrent: \`${current}\`` : '\n\n(using default Cerebro agent)';
    const txt = `*Available experts*\n${lines.join('\n')}${currentLine}`;
    if (respond) await respond({ response_type: 'ephemeral', text: txt });
    else if (this.api) await this.api.chatPostEphemeral({ channel, user, thread_ts: threadTs, text: txt });
  }

  private async setThreadExpert(
    channel: string,
    threadTs: string | undefined,
    user: string,
    key: string,
    slug: string,
    respond?: (msg: { response_type?: 'ephemeral' | 'in_channel'; text: string }) => Promise<unknown>,
  ): Promise<void> {
    const experts = await this.fetchExperts();
    const match = experts.find(
      (e) => e.slug?.toLowerCase() === slug.toLowerCase() || e.id.toLowerCase().startsWith(slug.toLowerCase()),
    );
    if (!match) {
      const txt = `No expert matched "${slug}". Try \`/cerebro experts\` to see options.`;
      if (respond) await respond({ response_type: 'ephemeral', text: txt });
      else if (this.api) await this.api.chatPostEphemeral({ channel, user, thread_ts: threadTs, text: txt });
      return;
    }
    const allow = this.getAccessibleExpertIds(user);
    if (allow !== null && !allow.includes(match.id)) {
      const txt = `You don't have access to *${match.name}*. Try \`/cerebro experts\` to see what you can use.`;
      if (respond) await respond({ response_type: 'ephemeral', text: txt });
      else if (this.api) await this.api.chatPostEphemeral({ channel, user, thread_ts: threadTs, text: txt });
      return;
    }
    this.settings.threadExpertMap[key] = match.id;
    await this.persistThreadExpertMap();
    const txt = `:white_check_mark: Pinned this conversation to *${match.name}*.`;
    if (respond) await respond({ response_type: 'ephemeral', text: txt });
    else if (this.api) await this.api.chatPostEphemeral({ channel, user, thread_ts: threadTs, text: txt });
  }

  // ── User-name cache ─────────────────────────────────────────────

  private async resolveDisplayName(userId: string): Promise<string | null> {
    if (!userId || !this.api) return null;
    if (this.settings.userDisplayNames[userId]) return this.settings.userDisplayNames[userId];
    try {
      const info = await this.api.usersInfo(userId);
      const name =
        info?.profile?.display_name?.trim()
        || info?.profile?.real_name?.trim()
        || info?.real_name?.trim()
        || info?.name?.trim()
        || null;
      if (name) {
        this.settings.userDisplayNames[userId] = name;
        await this.persistUserDisplayNames();
      }
      return name;
    } catch {
      return null;
    }
  }

  // ── Routine trigger dispatch ────────────────────────────────────

  private async matchSlackTriggers(ctx: SlackInboundContext): Promise<SlackTriggerRoutine[]> {
    const routines = await this.cachedTriggerRoutines();
    return matchSlackRoutineTriggers(routines, {
      channel: ctx.channel,
      userId: ctx.userId,
      surface: ctx.surface === 'slash_command' ? 'message_im' : ctx.surface,
      text: ctx.text,
    });
  }

  private async cachedTriggerRoutines(): Promise<SlackTriggerRoutine[]> {
    const now = Date.now();
    if (this.routineCache && now - this.routineCache.fetchedAt < ROUTINE_CACHE_TTL_MS) {
      return this.routineCache.routines;
    }
    const res = await backendRequest<{ routines: BackendRoutineRecord[] }>(
      this.deps.backendPort, 'GET', '/routines?trigger_type=slack_message',
    );
    const list = (res.data?.routines ?? [])
      .filter((r) => r.is_enabled)
      .map((r) => parseSlackTriggerRoutine(r))
      .filter((r): r is SlackTriggerRoutine => r !== null);
    this.routineCache = { fetchedAt: now, routines: list };
    return list;
  }

  private async dispatchRoutine(
    routine: SlackTriggerRoutine,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const engine = this.deps.executionEngine;
    if (!engine) return;
    if (!this.webContents || this.webContents.isDestroyed()) {
      logError(`routine "${routine.name}" not dispatched: main window not available`);
      return;
    }
    try {
      backendRequest(this.deps.backendPort, 'POST', `/routines/${routine.id}/run`).catch(() => { /* ignore */ });
      const runId = await engine.startRun(this.webContents, {
        dag: routine.dag,
        routineId: routine.id,
        triggerSource: 'slack_message',
        triggerPayload: payload,
      });
      log(`dispatched routine "${routine.name}" (${routine.id}) from ${payload.channel} → run ${runId}`);
    } catch (err) {
      logError(`routine ${routine.name} dispatch failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  // ── Approval bridge: surface engine approval events in the thread ──

  private subscribeToEngineEvents(): void {
    const listener = (event: ExecutionEvent, ctx: EngineEventContext): void => {
      if (event.type === 'approval_requested' && 'approvalId' in event) {
        void this.handleApprovalRequested(event, ctx);
        return;
      }
      if ((event.type === 'approval_granted' || event.type === 'approval_denied') && 'approvalId' in event) {
        void this.handleApprovalResolved(event);
        return;
      }
    };
    this.engineListener = listener;
    this.deps.engineEventBus.on(ENGINE_EVENT, listener);
  }

  /**
   * Pick the Slack thread an approval should be announced in. Prefers an
   * exact conversationId match; otherwise falls back per pickApprovalRun.
   * Returns null only when no run can be attributed.
   */
  private resolveApprovalTarget(
    conversationId: string | undefined,
  ): { channel: string; threadTs: string | undefined } | null {
    const run = pickApprovalRun(
      [...this.activeRuns.values()].map((r) => ({ id: r, conversationId: r.conversationId, startedAt: r.startedAt })),
      conversationId,
    );
    if (!run) return null;
    return { channel: run.channel, threadTs: run.threadTs };
  }

  private async handleApprovalRequested(
    event: Extract<ExecutionEvent, { type: 'approval_requested' }>,
    ctx: EngineEventContext,
  ): Promise<void> {
    if (!this.api) return;
    // Route the approval back to the thread that triggered it. The chat-action
    // engine run carries the originating conversationId (stamped by
    // run-chat-action.sh), so we match it precisely against our active runs —
    // this works even when several runs are in flight at once. When the id is
    // missing or doesn't match a live run, fall back to the most recently
    // started run rather than dropping the approval (a silently-dropped
    // approval leaves the engine paused forever).
    const target = this.resolveApprovalTarget(ctx.conversationId);
    if (!target) return;
    const { channel, threadTs } = target;
    const summary = scrubTokenish(event.summary || `Step "${event.stepId}" needs approval`);
    try {
      await this.api.chatPostMessage({
        channel,
        thread_ts: threadTs,
        text: `:lock: *Approval pending* — I'll follow up here once the Cerebro operator approves.\n\n> ${summary}`,
      });
      this.approvalThreadMap.set(event.approvalId, { channel, threadTs });
    } catch (err) {
      logError('approval announce failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private async handleApprovalResolved(
    event: Extract<ExecutionEvent, { type: 'approval_granted' | 'approval_denied' }>,
  ): Promise<void> {
    if (!this.api) return;
    const target = this.approvalThreadMap.get(event.approvalId);
    if (!target) return;
    this.approvalThreadMap.delete(event.approvalId);
    const text = event.type === 'approval_granted'
      ? ':white_check_mark: Operator approved — continuing.'
      : `:no_entry_sign: Operator denied${('reason' in event && event.reason) ? `: ${scrubTokenish(String(event.reason))}` : ''}.`;
    try {
      await this.api.chatPostMessage({
        channel: target.channel,
        thread_ts: target.threadTs,
        text,
      });
    } catch (err) {
      logError('approval resolve announce failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Settings persistence ───────────────────────────────────────

  private async loadSettings(): Promise<void> {
    const port = this.deps.backendPort;
    const [storedBotToken, storedAppToken, enabled, allowChans, allowUsers, threadMap, expertMap, displayNames, defaultExpertAccess, userExpertAccess, teamName, botUserId, operatorUserId] = await Promise.all([
      backendGetSetting<string>(port, SLACK_SETTING_KEYS.botToken),
      backendGetSetting<string>(port, SLACK_SETTING_KEYS.appToken),
      backendGetSetting<boolean>(port, SLACK_SETTING_KEYS.enabled),
      backendGetSetting<string[]>(port, SLACK_SETTING_KEYS.allowlistChannels),
      backendGetSetting<string[]>(port, SLACK_SETTING_KEYS.allowlistUsers),
      backendGetSetting<Record<string, string>>(port, SLACK_SETTING_KEYS.threadConversationMap),
      backendGetSetting<Record<string, string>>(port, SLACK_SETTING_KEYS.threadExpertMap),
      backendGetSetting<Record<string, string>>(port, SLACK_SETTING_KEYS.userDisplayNames),
      backendGetSetting<string[] | null>(port, SLACK_SETTING_KEYS.defaultExpertAccess),
      backendGetSetting<Record<string, string[]>>(port, SLACK_SETTING_KEYS.userExpertAccess),
      backendGetSetting<string>(port, SLACK_SETTING_KEYS.teamName),
      backendGetSetting<string>(port, SLACK_SETTING_KEYS.botUserId),
      backendGetSetting<string>(port, SLACK_SETTING_KEYS.operatorUserId),
    ]);

    const botToken = decryptFromStorage(storedBotToken);
    const appToken = decryptFromStorage(storedAppToken);

    if (botToken && isStoredPlaintext(storedBotToken) && secureTokenBackend() === 'os-keychain') {
      const re = encryptForStorage(botToken);
      await backendPutSetting(port, SLACK_SETTING_KEYS.botToken, re).catch(() => { /* retry next load */ });
    }
    if (appToken && isStoredPlaintext(storedAppToken) && secureTokenBackend() === 'os-keychain') {
      const re = encryptForStorage(appToken);
      await backendPutSetting(port, SLACK_SETTING_KEYS.appToken, re).catch(() => { /* retry next load */ });
    }

    this.settings = {
      botToken,
      appToken,
      enabled: enabled ?? false,
      allowlistChannels: Array.isArray(allowChans) ? allowChans : [],
      allowlistUsers: Array.isArray(allowUsers) ? allowUsers : [],
      threadConversationMap: threadMap ?? {},
      threadExpertMap: expertMap ?? {},
      userDisplayNames: displayNames ?? {},
      defaultExpertAccess: sanitizeExpertIdList(defaultExpertAccess),
      userExpertAccess: sanitizeUserExpertAccess(userExpertAccess),
      teamName: typeof teamName === 'string' ? teamName : null,
      botUserId: typeof botUserId === 'string' ? botUserId : null,
      operatorUserId: typeof operatorUserId === 'string' && operatorUserId ? operatorUserId : null,
    };
  }

  private async persistThreadConversationMap(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.threadConversationMap, this.settings.threadConversationMap);
  }
  private async persistThreadExpertMap(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.threadExpertMap, this.settings.threadExpertMap);
  }
  private async persistUserDisplayNames(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.userDisplayNames, this.settings.userDisplayNames);
  }
  private async persistUserExpertAccess(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.userExpertAccess, this.settings.userExpertAccess);
  }
  private async persistDefaultExpertAccess(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.defaultExpertAccess, this.settings.defaultExpertAccess);
  }
  private async persistTeamMetadata(): Promise<void> {
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.teamName, this.settings.teamName ?? '');
    await backendPutSetting(this.deps.backendPort, SLACK_SETTING_KEYS.botUserId, this.settings.botUserId ?? '');
  }

  // ── Watchdogs ─────────────────────────────────────────────────

  private startRunWatchdog(): void {
    if (this.runWatchdogTimer) return;
    this.runWatchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, run] of this.activeRuns) {
        if (now - run.lastActivityAt < RUN_IDLE_TIMEOUT_MS) continue;
        log(`watchdog: reclaiming stuck run ${run.runId} for thread ${key}`);
        try { this.deps.agentRuntime.cancelRun(run.runId); } catch { /* ignore */ }
        this.activeRuns.delete(key);
        if (this.api) {
          this.api.chatPostMessage({
            channel: run.channel,
            thread_ts: run.threadTs,
            text: ':warning: The previous request stopped responding and was cancelled. Send a new message to try again.',
          }).catch(() => { /* ignore */ });
        }
      }
    }, RUN_WATCHDOG_INTERVAL_MS);
    if (typeof this.runWatchdogTimer.unref === 'function') this.runWatchdogTimer.unref();
  }

  private startIdleWatchdog(): void {
    if (this.idleWatchdogTimer) return;
    this.idleWatchdogTimer = setInterval(() => {
      if (!this.running || !this.lastEventAt) return;
      if (Date.now() - this.lastEventAt < IDLE_WATCHDOG_MS) return;
      log('idle-watchdog: no events for 5 min, bouncing the bridge');
      void this.bounce();
    }, IDLE_WATCHDOG_INTERVAL_MS);
    if (typeof this.idleWatchdogTimer.unref === 'function') this.idleWatchdogTimer.unref();
  }

  private async bounce(): Promise<void> {
    if (this.starting) return;
    await this.stop();
    await this.start();
  }

  // ── Claude Code re-auth (operator paste-back) ───────────────────

  /**
   * Resolve the Slack user id we should DM when Claude Code needs to be
   * re-authenticated. Prefers the explicit `operatorUserId` setting; falls
   * back to the first concrete entry in `allowlistUsers` so existing
   * deployments don't need a fresh setting to get the recovery flow. The
   * `'*'` wildcard is skipped — we need a real user id to open a DM.
   */
  private resolveOperatorUserId(): string | null {
    const explicit = this.settings.operatorUserId;
    if (explicit && explicit !== '*') return explicit;
    const fromAllowlist = this.settings.allowlistUsers.find((u) => u && u !== '*');
    return fromAllowlist ?? null;
  }

  /**
   * Invoked by SlackStreamSink when a run errors with `errorClass: 'auth'`.
   * Kicks off `claude setup-token` via the login orchestrator, DMs the
   * operator the captured URL with paste-back instructions, and arms an
   * intercept on the operator's next DM. Returns true when handled so the
   * sink suppresses the raw error string in the requesting user's thread.
   *
   * Returns false (let the sink post the default :warning:) when no
   * operator can be resolved — better than silently swallowing the error.
   */
  private async handleAuthFailure(ctx: SlackInboundContext, originalText: string): Promise<boolean> {
    if (!this.api) return false;
    if (this.pendingLogin) {
      // Another auth attempt is already in flight. Don't double-DM; the
      // operator's reply will retry the queued original message and any
      // other auth-failed threads will eventually resolve on the next
      // turn (the cached probe will be valid by then).
      return true;
    }
    const operatorUserId = this.resolveOperatorUserId();
    if (!operatorUserId) {
      logError('auth failure: no operator user id configured — falling back to default error post');
      return false;
    }

    let operatorDmChannel: string;
    try {
      operatorDmChannel = await this.api.conversationsOpen(operatorUserId);
    } catch (err) {
      logError('auth failure: conversations.open failed', err instanceof Error ? err.message : String(err));
      return false;
    }

    const orchestrator = getLoginOrchestrator();
    if (orchestrator.current()) {
      // A login is already in flight from another surface (e.g. the
      // renderer card). Don't try to take it over — just let the sink
      // post the default warning so the user has *something*.
      return false;
    }

    let snap: LoginSnapshot;
    try {
      snap = await orchestrator.start('setup-token');
    } catch (err) {
      logError('auth failure: login start failed', err instanceof Error ? err.message : String(err));
      return false;
    }

    if (!snap.url) {
      logError('auth failure: login orchestrator returned no URL');
      orchestrator.cancel(snap.loginId);
      return false;
    }

    try {
      await this.api.chatPostMessage({
        channel: operatorDmChannel,
        text:
          ':key: *Cerebro needs you to re-authenticate Claude.*\n\n'
          + `1. Open this link in your browser: ${snap.url}\n`
          + '2. Complete the sign-in.\n'
          + '3. Reply to this DM with the code shown on the page.\n\n'
          + '_I’ll resume the original request automatically once you reply._',
      });
    } catch (err) {
      logError('auth failure: operator DM post failed', err instanceof Error ? err.message : String(err));
      orchestrator.cancel(snap.loginId);
      return false;
    }

    // Re-broadcast orchestrator updates so the operator sees verification
    // succeed/fail without us having to poll. Settled state is also
    // handled in handleOperatorAuthCode below.
    const update = (s: LoginSnapshot): void => {
      if (s.loginId !== snap.loginId) return;
      if (s.status === 'success') {
        void this.completeAuthRecovery();
      } else if (s.status === 'failure' || s.status === 'cancelled') {
        void this.failAuthRecovery(s.reason ?? 'Sign-in failed.');
      }
    };
    orchestrator.on('update', update);
    const unsubscribe = (): void => { orchestrator.off('update', update); };

    const timeoutTimer = setTimeout(() => {
      void this.failAuthRecovery('Sign-in timed out after 10 minutes.');
    }, 10 * 60_000);

    this.pendingLogin = {
      loginId: snap.loginId,
      operatorUserId,
      operatorDmChannel,
      originalCtx: ctx,
      originalText,
      timeoutTimer,
      unsubscribe,
    };

    return true;
  }

  /**
   * The operator replied to the auth DM with the paste-back code. Forward
   * it to the orchestrator. Errors here surface back through orchestrator
   * 'update' events.
   */
  private async handleOperatorAuthCode(code: string): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    const trimmed = (code ?? '').trim();
    if (!trimmed) return;
    try {
      await getLoginOrchestrator().submitCode(pending.loginId, trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.api) {
        try {
          await this.api.chatPostMessage({
            channel: pending.operatorDmChannel,
            text: `:warning: Couldn’t verify that code: ${scrubTokenish(msg)}\n\nPaste the code again, or open the link again to start over.`,
          });
        } catch { /* ignore */ }
      }
    }
  }

  /** Resolve a pending auth recovery — operator successfully re-authed. */
  private async completeAuthRecovery(): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    this.pendingLogin = null;
    clearTimeout(pending.timeoutTimer);
    pending.unsubscribe();

    if (this.api) {
      try {
        await this.api.chatPostMessage({
          channel: pending.operatorDmChannel,
          text: ':white_check_mark: Reconnected to Claude. Resuming the original request now.',
        });
      } catch { /* ignore */ }
    }

    // Re-dispatch the original inbound so the requesting user finally gets
    // their answer. The dedupe layer would normally reject a replay of the
    // same event id, so synthesize a fresh one for the retry.
    const replayCtx: SlackInboundContext = {
      ...pending.originalCtx,
      eventId: `${pending.originalCtx.eventId}::auth-retry::${Date.now()}`,
      text: pending.originalText,
    };
    try {
      await this.handleInbound(replayCtx);
    } catch (err) {
      logError('auth recovery replay failed', err instanceof Error ? err.message : String(err));
    }
  }

  /** Resolve a pending auth recovery — sign-in failed or timed out. */
  private async failAuthRecovery(reason: string): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    this.pendingLogin = null;
    clearTimeout(pending.timeoutTimer);
    pending.unsubscribe();
    try { getLoginOrchestrator().cancel(pending.loginId); } catch { /* noop */ }

    if (this.api) {
      try {
        await this.api.chatPostMessage({
          channel: pending.operatorDmChannel,
          text: `:warning: Claude sign-in didn’t complete: ${scrubTokenish(reason)}`,
        });
      } catch { /* ignore */ }
      // Tell the original requesting user we gave up.
      try {
        await this.api.chatPostMessage({
          channel: pending.originalCtx.channel,
          thread_ts: pending.originalCtx.threadTs,
          text: ':warning: Couldn’t reconnect to Claude. The operator has been notified.',
        });
      } catch { /* ignore */ }
    }
  }

  // ── Error helpers ─────────────────────────────────────────────

  private async safeReplyError(channel: string, threadTs: string | undefined, err: unknown): Promise<void> {
    if (!this.api) return;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await this.api.chatPostMessage({
        channel,
        thread_ts: threadTs,
        text: `:warning: Cerebro hit an error: ${scrubTokenish(msg)}`,
      });
    } catch { /* ignore */ }
  }

  // ── Home tab view ─────────────────────────────────────────────

  private buildHomeTabView(): object {
    return {
      type: 'home',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Cerebro', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'I\'m Cerebro — your team\'s AI brain.\n\n*How to talk to me:*\n• :speech_balloon: DM me directly\n• :mega: Mention `@Cerebro` in any channel and I\'ll reply in a thread\n• :keyboard: Use `/cerebro <question>` for an ephemeral one-shot',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Commands*\n`/cerebro help` — show all commands\n`/cerebro experts` — list available experts\n`/cerebro expert <slug>` — pin this conversation to an expert\n`/cerebro expert clear` — go back to the default\n`/cerebro status` — connection health',
          },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: 'Each Slack thread is its own conversation. Need to configure me? Talk to whoever runs the Cerebro desktop app.' },
          ],
        },
      ],
    };
  }

  private helpMenuText(): string {
    return [
      ':wave: *Cerebro* — your team\'s AI brain.',
      '',
      '*How to talk to me*',
      '• DM me directly — private 1:1 conversation',
      '• Mention `@Cerebro` in any channel — I reply in a thread the whole channel can read',
      '• Use `/cerebro <question>` for a quick ephemeral answer',
      '',
      '*Commands*',
      '• `/cerebro help` — show this menu',
      '• `/cerebro experts` — list available experts',
      '• `/cerebro expert <slug>` — pin this conversation to a specific expert',
      '• `/cerebro expert clear` — go back to the default Cerebro agent',
      '• `/cerebro status` — show connection health',
      '• `/cerebro <question>` — ask Cerebro anything',
      '',
      '_Each Slack thread is its own conversation. DMs are one rolling conversation per person._',
    ].join('\n');
  }
}

// Embedded fallback manifest YAML (also exists as src/slack/manifest.yaml).
const INLINE_MANIFEST = `_metadata:
  major_version: 1
  minor_version: 1

display_information:
  name: Cerebro
  description: Your team's AI brain - chat with Cerebro from Slack.
  background_color: "#0B1220"

features:
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
  bot_user:
    display_name: Cerebro
    always_online: true
  slash_commands:
    - command: /cerebro
      description: Ask Cerebro, list experts, or check status.
      usage_hint: "[help | experts | status | <question>]"
      url: https://example.com/slack/commands
      should_escape: false

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - chat:write.customize
      - commands
      - im:history
      - im:read
      - im:write
      - users:read
      - reactions:write
      - files:write

settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.im
      - app_home_opened
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
`;

