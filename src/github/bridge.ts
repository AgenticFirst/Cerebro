/**
 * GitHubBridge — credential holder + per-repo poller + routine dispatch.
 *
 * Combines the HubSpot holder pattern (encrypted token persistence, verify
 * against /user) with the Telegram bridge pattern (long-lived polling loop
 * that fans out trigger payloads into engine.startRun for each matching
 * routine).
 *
 * GitHub uses HTTP polling rather than webhooks because Cerebro is a local
 * desktop app with no public URL. Polling cadence is 60s by default with
 * ETag/If-None-Match on every endpoint and exponential backoff when the
 * primary rate limit (5000 req/hr authenticated) is exhausted.
 *
 * Triggers fire only for repos in the user's watched-repo allowlist (set
 * from the Settings UI). Outbound chat-action invocations may target any
 * repo the token can reach — the user is the human in the loop via the
 * approval gate.
 */

import type { WebContents } from 'electron';
import type { ExecutionEngine } from '../engine/engine';
import type { GitHubChannel } from '../engine/actions/github-channel';
import type { GitHubStatusResponse, GitHubVerifyResult, GitHubRepoSummary } from '../types/ipc';
import { IPC_CHANNELS } from '../types/ipc';
import {
  encryptForStorage,
  decryptFromStorage,
  backend as secureTokenBackend,
} from '../secure-token';
import { backendGetSetting, backendPutSetting, backendJsonRequest } from '../shared/backend-settings';
import { callGitHubApi, parseRepoFullName } from './api';
import {
  GITHUB_SETTING_KEYS,
  type GitHubCursorMap,
  type GitHubRepoCursor,
  type GitHubTriggerPayload,
  type GitHubEventType,
} from './types';
import {
  parseGitHubTriggerRoutine,
  matchRoutineTriggers,
  isValidRepoFullName,
  type BackendRoutineRecord,
  type GitHubTriggerRoutine,
} from './helpers';

const POLL_INTERVAL_MS = 60_000;
const ROUTINE_CACHE_TTL_MS = 30_000;
const RATE_LIMIT_LOW_WATERMARK = 100;
const RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1_000;
/** Cap on per-repo "seen ID" lists so they don't grow without bound. */
const SEEN_RING_BUFFER_SIZE = 200;

function log(...args: unknown[]): void {
  console.log('[GitHub]', ...args);
}
function logError(...args: unknown[]): void {
  console.error('[GitHub]', ...args);
}

interface GitHubApiUser {
  login: string;
  id: number;
}

interface GitHubApiIssue {
  number: number;
  title: string;
  body: string | null;
  user?: { login?: string };
  html_url: string;
  pull_request?: unknown;
  labels?: Array<{ name?: string }>;
  created_at: string;
  updated_at: string;
}

interface GitHubApiPull {
  number: number;
  title: string;
  body: string | null;
  user?: { login?: string };
  html_url: string;
  requested_reviewers?: Array<{ login?: string }>;
  labels?: Array<{ name?: string }>;
  updated_at: string;
}

interface GitHubApiRepo {
  full_name: string;
  owner: { login: string };
  name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
}

export interface GitHubBridgeDeps {
  backendPort: number;
  /** Optional engine ref so polled events can dispatch routine triggers. */
  executionEngine?: ExecutionEngine;
}

export class GitHubBridge implements GitHubChannel {
  private accessToken: string | null = null;
  private login: string | null = null;
  private watchedRepos: string[] = [];
  private cursors: GitHubCursorMap = {};

  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private rateLimitRemaining: number | null = null;
  private rateLimitBackoffUntil = 0;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;

  private webContents: WebContents | null = null;
  private routineCache: { fetchedAt: number; routines: GitHubTriggerRoutine[] } | null = null;
  private statusListeners = new Set<(status: GitHubStatusResponse) => void>();

  constructor(private deps: GitHubBridgeDeps) {}

  // ── Channel interface ───────────────────────────────────────────

  getAccessToken(): string | null { return this.accessToken; }
  getLogin(): string | null { return this.login; }
  getWatchedRepos(): string[] { return [...this.watchedRepos]; }
  isConnected(): boolean { return Boolean(this.accessToken); }

  // ── Wiring ──────────────────────────────────────────────────────

  setExecutionEngine(engine: ExecutionEngine): void {
    this.deps.executionEngine = engine;
  }

  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  onStatusChange(listener: (status: GitHubStatusResponse) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Load persisted state from settings. Idempotent. */
  async init(): Promise<void> {
    const [encToken, login, watchedRaw, cursorsRaw] = await Promise.all([
      backendGetSetting<string>(this.deps.backendPort, GITHUB_SETTING_KEYS.token),
      backendGetSetting<string>(this.deps.backendPort, GITHUB_SETTING_KEYS.login),
      backendGetSetting<string[]>(this.deps.backendPort, GITHUB_SETTING_KEYS.watchedRepos),
      backendGetSetting<GitHubCursorMap>(this.deps.backendPort, GITHUB_SETTING_KEYS.cursors),
    ]);
    if (typeof encToken === 'string' && encToken) {
      this.accessToken = decryptFromStorage(encToken);
    }
    this.login = typeof login === 'string' ? login : null;
    this.watchedRepos = Array.isArray(watchedRaw)
      ? watchedRaw.filter((r) => typeof r === 'string' && isValidRepoFullName(r))
      : [];
    this.cursors = (cursorsRaw && typeof cursorsRaw === 'object') ? cursorsRaw : {};
  }

  /** Start polling if a token is configured. Safe to call repeatedly. */
  start(): void {
    if (this.polling) return;
    if (!this.accessToken) {
      log('not started: no token configured');
      return;
    }
    this.polling = true;
    log(`polling started (every ${POLL_INTERVAL_MS / 1000}s for ${this.watchedRepos.length} watched repo(s))`);
    // Run a poll immediately, then schedule.
    void this.runPollCycle();
    this.pollTimer = setInterval(() => { void this.runPollCycle(); }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    log('polling stopped');
  }

  // ── Credential management ───────────────────────────────────────

  async verify(token: string): Promise<GitHubVerifyResult> {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'Empty token' };
    const res = await callGitHubApi<GitHubApiUser>(trimmed, '/user');
    if (!res.ok) return { ok: false, error: res.error ?? 'Verification failed' };
    return { ok: true, login: res.data?.login ?? null };
  }

  async setToken(token: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'Empty token' };
    const verify = await this.verify(trimmed);
    if (!verify.ok) return { ok: false, error: verify.error ?? 'Verification failed' };
    this.accessToken = trimmed;
    this.login = verify.login ?? null;
    const enc = encryptForStorage(trimmed);
    await Promise.all([
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.token, enc),
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.login, this.login ?? ''),
    ]);
    if (!this.polling) this.start();
    this.notifyStatus();
    return { ok: true };
  }

  async clearToken(): Promise<{ ok: boolean; error?: string }> {
    this.stop();
    this.accessToken = null;
    this.login = null;
    this.cursors = {};
    await Promise.all([
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.token, ''),
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.login, ''),
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.cursors, {}),
    ]);
    this.notifyStatus();
    return { ok: true };
  }

  // ── Watched repos ───────────────────────────────────────────────

  async setWatchedRepos(repos: string[]): Promise<{ ok: boolean; error?: string }> {
    const cleaned = Array.from(new Set(
      repos.map((r) => r.trim()).filter((r) => isValidRepoFullName(r)),
    )).sort();
    this.watchedRepos = cleaned;
    // Drop cursors for repos that are no longer watched.
    const next: GitHubCursorMap = {};
    for (const repo of cleaned) {
      if (this.cursors[repo]) next[repo] = this.cursors[repo];
    }
    this.cursors = next;
    await Promise.all([
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.watchedRepos, cleaned),
      backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.cursors, next),
    ]);
    this.routineCache = null;
    this.notifyStatus();
    return { ok: true };
  }

  /** Enumerate repos the current token can see, sorted by recent activity. */
  async listAccessibleRepos(): Promise<{ ok: boolean; repos?: GitHubRepoSummary[]; error?: string }> {
    if (!this.accessToken) return { ok: false, error: 'No token configured' };
    const res = await callGitHubApi<GitHubApiRepo[]>(this.accessToken, '/user/repos', {
      query: { per_page: 100, sort: 'pushed', direction: 'desc' },
    });
    if (!res.ok) return { ok: false, error: res.error ?? 'Failed to list repos' };
    const repos: GitHubRepoSummary[] = (res.data ?? []).map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      defaultBranch: r.default_branch,
      htmlUrl: r.html_url,
    }));
    return { ok: true, repos };
  }

  // ── Status surface ──────────────────────────────────────────────

  status(): GitHubStatusResponse {
    return {
      hasToken: Boolean(this.accessToken),
      login: this.login,
      watchedRepos: [...this.watchedRepos],
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      rateLimitRemaining: this.rateLimitRemaining,
      tokenBackend: secureTokenBackend(),
    };
  }

  private notifyStatus(): void {
    const snapshot = this.status();
    for (const listener of this.statusListeners) {
      try { listener(snapshot); } catch { /* listener errors must not break the bridge */ }
    }
    if (this.webContents && !this.webContents.isDestroyed()) {
      try { this.webContents.send(IPC_CHANNELS.GITHUB_STATUS_CHANGED, snapshot); } catch { /* ignore */ }
    }
  }

  // ── Polling ─────────────────────────────────────────────────────

  private async runPollCycle(): Promise<void> {
    if (!this.accessToken) return;
    if (this.watchedRepos.length === 0) return;
    if (Date.now() < this.rateLimitBackoffUntil) return;

    this.lastPollAt = Date.now();
    let hadError = false;
    for (const repo of this.watchedRepos) {
      try {
        await this.pollRepo(repo);
      } catch (err) {
        hadError = true;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = msg;
        logError(`poll ${repo} failed: ${msg}`);
      }
    }
    if (!hadError) this.lastError = null;
    if (this.rateLimitRemaining !== null && this.rateLimitRemaining < RATE_LIMIT_LOW_WATERMARK) {
      this.rateLimitBackoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      log(`rate-limit low (${this.rateLimitRemaining} remaining), backing off ${RATE_LIMIT_BACKOFF_MS / 60_000}m`);
    }
    await backendPutSetting(this.deps.backendPort, GITHUB_SETTING_KEYS.cursors, this.cursors)
      .catch(() => { /* best-effort */ });
    this.notifyStatus();
  }

  private async pollRepo(repoFullName: string): Promise<void> {
    const parts = parseRepoFullName(repoFullName);
    if (!parts) return;
    const cursor: GitHubRepoCursor = this.cursors[repoFullName] ?? {};
    await this.pollIssues(repoFullName, parts.owner, parts.repo, cursor);
    await this.pollPulls(repoFullName, parts.owner, parts.repo, cursor);
    this.cursors[repoFullName] = cursor;
  }

  private async pollIssues(
    repoFullName: string,
    owner: string,
    repo: string,
    cursor: GitHubRepoCursor,
  ): Promise<void> {
    const sinceParam = cursor.issuesSince ?? new Date(Date.now() - 5 * 60_000).toISOString();
    const res = await callGitHubApi<GitHubApiIssue[]>(this.accessToken!, `/repos/${owner}/${repo}/issues`, {
      query: { state: 'open', since: sinceParam, sort: 'created', direction: 'asc', per_page: 50 },
      etag: cursor.issuesEtag,
    });
    this.recordRateLimit(res.rateLimitRemaining);
    if (res.status === 304) return;
    if (!res.ok) throw new Error(res.error ?? `issues poll HTTP ${res.status}`);
    if (res.etag) cursor.issuesEtag = res.etag;
    const seenIds = new Set(cursor.seenIssueNumbers ?? []);
    let newSeen: number[] = [...(cursor.seenIssueNumbers ?? [])];
    let latestCreatedAt = cursor.issuesSince ?? null;
    for (const issue of res.data ?? []) {
      // Filter out PRs (the issues endpoint also returns them).
      if (issue.pull_request !== undefined && issue.pull_request !== null) continue;
      if (seenIds.has(issue.number)) continue;
      seenIds.add(issue.number);
      newSeen.push(issue.number);
      const labels = (issue.labels ?? []).map((l) => l.name ?? '').filter(Boolean);
      const payload: GitHubTriggerPayload = {
        event_type: 'github_issue_opened',
        repo_full_name: repoFullName,
        repo_owner: owner,
        repo_name: repo,
        issue_number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        author_login: issue.user?.login ?? '',
        html_url: issue.html_url,
        received_at: new Date().toISOString(),
      };
      await this.dispatchEvent(payload, labels);
      if (!latestCreatedAt || issue.created_at > latestCreatedAt) latestCreatedAt = issue.created_at;
    }
    if (latestCreatedAt) cursor.issuesSince = latestCreatedAt;
    if (newSeen.length > SEEN_RING_BUFFER_SIZE) newSeen = newSeen.slice(-SEEN_RING_BUFFER_SIZE);
    cursor.seenIssueNumbers = newSeen;
  }

  private async pollPulls(
    repoFullName: string,
    owner: string,
    repo: string,
    cursor: GitHubRepoCursor,
  ): Promise<void> {
    const me = this.login;
    if (!me) return;
    const res = await callGitHubApi<GitHubApiPull[]>(this.accessToken!, `/repos/${owner}/${repo}/pulls`, {
      query: { state: 'open', sort: 'updated', direction: 'desc', per_page: 50 },
      etag: cursor.prsEtag,
    });
    this.recordRateLimit(res.rateLimitRemaining);
    if (res.status === 304) return;
    if (!res.ok) throw new Error(res.error ?? `pulls poll HTTP ${res.status}`);
    if (res.etag) cursor.prsEtag = res.etag;
    const seen = new Set(cursor.seenReviewRequests ?? []);
    let newSeen: number[] = [...(cursor.seenReviewRequests ?? [])];
    let latestUpdated = cursor.prsLastUpdated ?? null;
    for (const pr of res.data ?? []) {
      const requestedMe = (pr.requested_reviewers ?? []).some((r) => r.login === me);
      if (!requestedMe) continue;
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      newSeen.push(pr.number);
      const labels = (pr.labels ?? []).map((l) => l.name ?? '').filter(Boolean);
      const payload: GitHubTriggerPayload = {
        event_type: 'github_pr_review_requested',
        repo_full_name: repoFullName,
        repo_owner: owner,
        repo_name: repo,
        pr_number: pr.number,
        title: pr.title,
        body: pr.body ?? '',
        author_login: pr.user?.login ?? '',
        html_url: pr.html_url,
        received_at: new Date().toISOString(),
      };
      await this.dispatchEvent(payload, labels);
      if (!latestUpdated || pr.updated_at > latestUpdated) latestUpdated = pr.updated_at;
    }
    if (latestUpdated) cursor.prsLastUpdated = latestUpdated;
    if (newSeen.length > SEEN_RING_BUFFER_SIZE) newSeen = newSeen.slice(-SEEN_RING_BUFFER_SIZE);
    cursor.seenReviewRequests = newSeen;
  }

  private recordRateLimit(remaining: number | null): void {
    if (remaining !== null) this.rateLimitRemaining = remaining;
  }

  // ── Routine dispatch ────────────────────────────────────────────

  private async dispatchEvent(payload: GitHubTriggerPayload, labels: string[]): Promise<void> {
    const matches = await this.matchRoutines(payload.event_type, payload.repo_full_name, payload.title, payload.body, labels);
    if (matches.length === 0) return;
    for (const routine of matches) {
      await this.dispatchRoutine(routine, payload);
    }
  }

  private async matchRoutines(
    eventType: GitHubEventType,
    repoFullName: string,
    title: string,
    body: string,
    labels: string[],
  ): Promise<GitHubTriggerRoutine[]> {
    if (!this.deps.executionEngine) return [];
    const now = Date.now();
    if (!this.routineCache || now - this.routineCache.fetchedAt > ROUTINE_CACHE_TTL_MS) {
      const records = await this.fetchRoutineRecords();
      const list = records
        .filter((r) => r.is_enabled && r.dag_json)
        .map(parseGitHubTriggerRoutine)
        .filter((r): r is GitHubTriggerRoutine => r !== null);
      this.routineCache = { fetchedAt: now, routines: list };
    }
    return matchRoutineTriggers(this.routineCache.routines, {
      type: eventType, repoFullName, title, body, labels,
    });
  }

  private async fetchRoutineRecords(): Promise<BackendRoutineRecord[]> {
    // The backend exposes /routines?trigger_type=<type>; fetch both event
    // types in parallel and merge so one cache covers both flows.
    const [issuesRes, prsRes] = await Promise.all([
      backendJsonRequest<{ routines?: BackendRoutineRecord[] }>(
        this.deps.backendPort, 'GET', '/routines?trigger_type=github_issue_opened',
      ),
      backendJsonRequest<{ routines?: BackendRoutineRecord[] }>(
        this.deps.backendPort, 'GET', '/routines?trigger_type=github_pr_review_requested',
      ),
    ]);
    const merged: BackendRoutineRecord[] = [
      ...(issuesRes.data?.routines ?? []),
      ...(prsRes.data?.routines ?? []),
    ];
    return merged;
  }

  private async dispatchRoutine(
    routine: GitHubTriggerRoutine,
    payload: GitHubTriggerPayload,
  ): Promise<void> {
    const engine = this.deps.executionEngine;
    if (!engine) return;
    if (!this.webContents || this.webContents.isDestroyed()) {
      logError(`routine "${routine.name}" not dispatched: main window not available`);
      return;
    }
    try {
      backendJsonRequest(this.deps.backendPort, 'POST', `/routines/${routine.id}/run`)
        .catch(() => { /* best-effort */ });
      const runId = await engine.startRun(this.webContents, {
        dag: routine.dag,
        routineId: routine.id,
        triggerSource: payload.event_type,
        triggerPayload: payload as unknown as Record<string, unknown>,
      });
      log(`dispatched routine "${routine.name}" (${routine.id}) for ${payload.repo_full_name} → run ${runId}`);
    } catch (err) {
      logError('dispatchRoutine failed', err instanceof Error ? err.message : String(err));
    }
  }
}
