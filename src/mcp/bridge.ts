/**
 * McpBridge — main-process owner of MCP server connections: encrypted
 * credentials, the Google Drive OAuth account, tool discovery, and the
 * per-run --mcp-config resolution the agent runtime consumes.
 *
 * Why main (not the Python backend): safeStorage (secure-token.ts) only works
 * in main, and OAuth secrets / custom env values must never reach the
 * renderer or the backend process. The bridge writes only secret-free
 * metadata rows to the backend `mcp_servers` table.
 *
 * Shape mirrors GmailBridge (single-flight connect, refresh-on-expiry,
 * settings-key persistence under the local-only `mcp_` prefix).
 */

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { encryptForStorage, decryptFromStorage } from '../secure-token';
import {
  backendGetSetting,
  backendGetSettingStrict,
  backendPutSetting,
  backendJsonRequest,
} from '../shared/backend-settings';
import { IPC_CHANNELS } from '../types/ipc';
import { runOAuthFlow, TokenExpiredError, type TokenSet } from '../shared/oauth';
import { GMAIL_INDEX_KEY, gmailSettingKey } from '../gmail/types';
import { GoogleDriveOAuthProvider } from './provider';
import { discoverHttp, discoverStdio, type DiscoveryResult } from './discovery-client';
import { buildMcpRunConfig, type ResolvedMcpServer } from './config-builder';
import {
  GDRIVE_MCP_URL,
  GDRIVE_SLUG,
  GDRIVE_WRITE_TOOLS,
  MCP_INDEX_KEY,
  MCP_SERVER_FIELDS,
  mcpSettingKey,
  slugifyServerName,
  type AddCustomMcpInput,
  type DiscoveredTool,
  type McpRunConfig,
  type McpServerInfo,
  type McpServerKind,
  type McpServerStatus,
  type McpTransport,
} from './types';

const TOKEN_REFRESH_SKEW_MS = 60_000;

interface ServerRecord {
  id: string;
  slug: string;
  name: string;
  kind: McpServerKind;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Decrypted custom-server secrets (main-process memory only). */
  env: Record<string, string>;
  headers: Record<string, string>;
  /** gdrive kind only. */
  clientId: string | null;
  clientSecret: string | null;
  tokens: TokenSet | null;
  chatEnabled: boolean;
  status: McpServerStatus;
  lastError: string | null;
  lastDiscoveredAt: string | null;
  tools: DiscoveredTool[];
  accountLabel: string | null;
}

export interface McpBridgeDeps {
  backendPort: number;
}

export class McpBridge {
  private servers = new Map<string, ServerRecord>();
  private webContents: WebContents | null = null;
  private provider = new GoogleDriveOAuthProvider();

  constructor(private deps: McpBridgeDeps) {}

  setWebContents(wc: WebContents | null): void {
    this.webContents = wc;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, MCP_INDEX_KEY)) ?? [];
    for (const id of index) {
      try {
        const record = await this.loadServer(id);
        if (record) this.servers.set(id, record);
      } catch (err) {
        console.error(`[MCP] failed to load server ${id}:`, err);
      }
    }
  }

  // ── Persistence (settings are device-local via the mcp_ prefix) ───────────

  private async loadServer(id: string): Promise<ServerRecord | null> {
    const port = this.deps.backendPort;
    const meta = await backendJsonRequest<{
      slug: string;
      name: string;
      kind: McpServerKind;
      transport: McpTransport;
      command: string | null;
      args: string[];
      url: string | null;
      chat_enabled: boolean;
      status: McpServerStatus;
      last_error: string | null;
      last_discovered_at: string | null;
      tools: Array<{ name: string; description: string; read_only: boolean }>;
      account_label: string | null;
    }>(port, 'GET', `/mcp-servers/${id}`);
    if (!meta.ok || !meta.data) return null;

    // Strict reads: a transient backend hiccup must throw (init retries on
    // next boot) rather than silently load the server as "not authorized".
    const [clientId, encSecret, encAccess, encRefresh, expiry, encEnv, encHeaders] =
      await Promise.all([
        backendGetSettingStrict<string>(port, mcpSettingKey(id, 'client_id')),
        backendGetSettingStrict<string>(port, mcpSettingKey(id, 'client_secret')),
        backendGetSettingStrict<string>(port, mcpSettingKey(id, 'access_token')),
        backendGetSettingStrict<string>(port, mcpSettingKey(id, 'refresh_token')),
        backendGetSettingStrict<number>(port, mcpSettingKey(id, 'token_expiry')),
        backendGetSettingStrict<string>(port, mcpSettingKey(id, 'env_json')),
        backendGetSettingStrict<string>(port, mcpSettingKey(id, 'headers_json')),
      ]);

    const accessToken = encAccess ? decryptFromStorage(encAccess) : null;
    return {
      id,
      slug: meta.data.slug,
      name: meta.data.name,
      kind: meta.data.kind,
      transport: meta.data.transport,
      command: meta.data.command,
      args: meta.data.args ?? [],
      url: meta.data.url,
      env: parseJsonRecord(encEnv ? decryptFromStorage(encEnv) : null),
      headers: parseJsonRecord(encHeaders ? decryptFromStorage(encHeaders) : null),
      clientId: clientId || null,
      clientSecret: encSecret ? decryptFromStorage(encSecret) : null,
      tokens: accessToken
        ? {
            accessToken,
            refreshToken: encRefresh ? decryptFromStorage(encRefresh) : null,
            expiresAt: expiry ?? 0,
          }
        : null,
      chatEnabled: meta.data.chat_enabled,
      status: meta.data.status,
      lastError: meta.data.last_error,
      lastDiscoveredAt: meta.data.last_discovered_at,
      tools: (meta.data.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.read_only,
      })),
      accountLabel: meta.data.account_label,
    };
  }

  private async persistSecrets(record: ServerRecord): Promise<void> {
    const port = this.deps.backendPort;
    await Promise.all([
      backendPutSetting(port, mcpSettingKey(record.id, 'client_id'), record.clientId ?? ''),
      backendPutSetting(
        port,
        mcpSettingKey(record.id, 'client_secret'),
        record.clientSecret ? encryptForStorage(record.clientSecret) : '',
      ),
      backendPutSetting(
        port,
        mcpSettingKey(record.id, 'access_token'),
        record.tokens ? encryptForStorage(record.tokens.accessToken) : '',
      ),
      backendPutSetting(
        port,
        mcpSettingKey(record.id, 'refresh_token'),
        record.tokens?.refreshToken ? encryptForStorage(record.tokens.refreshToken) : '',
      ),
      backendPutSetting(
        port,
        mcpSettingKey(record.id, 'token_expiry'),
        record.tokens?.expiresAt ?? 0,
      ),
      backendPutSetting(
        port,
        mcpSettingKey(record.id, 'env_json'),
        Object.keys(record.env).length > 0 ? encryptForStorage(JSON.stringify(record.env)) : '',
      ),
      backendPutSetting(
        port,
        mcpSettingKey(record.id, 'headers_json'),
        Object.keys(record.headers).length > 0
          ? encryptForStorage(JSON.stringify(record.headers))
          : '',
      ),
    ]);
  }

  private async upsertBackendRow(record: ServerRecord): Promise<void> {
    await backendJsonRequest(this.deps.backendPort, 'PUT', `/mcp-servers/${record.id}`, {
      id: record.id,
      slug: record.slug,
      name: record.name,
      kind: record.kind,
      transport: record.transport,
      command: record.command,
      args: record.args,
      url: record.url,
      env_names: Object.keys(record.env),
      header_names: Object.keys(record.headers),
      chat_enabled: record.chatEnabled,
      status: record.status,
      last_error: record.lastError,
      last_discovered_at: record.lastDiscoveredAt,
      tools: record.tools.map((t) => ({
        name: t.name,
        description: t.description,
        read_only: t.readOnly,
      })),
      account_label: record.accountLabel,
    });
  }

  private async addToIndex(id: string): Promise<void> {
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, MCP_INDEX_KEY)) ?? [];
    if (!index.includes(id)) {
      index.push(id);
      await backendPutSetting(this.deps.backendPort, MCP_INDEX_KEY, index);
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  private async runDiscovery(record: ServerRecord): Promise<DiscoveryResult> {
    if (record.transport === 'stdio') {
      return discoverStdio(record.command ?? '', record.args, record.env);
    }
    const headers = { ...record.headers };
    if (record.kind === 'gdrive') {
      try {
        headers.Authorization = `Bearer ${await this.getValidAccessToken(record)}`;
      } catch (err) {
        return {
          ok: false,
          tools: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return discoverHttp(record.url ?? '', headers);
  }

  private applyDiscovery(record: ServerRecord, result: DiscoveryResult): void {
    if (result.ok) {
      record.tools =
        record.kind === 'gdrive'
          ? result.tools.filter((t) => !GDRIVE_WRITE_TOOLS.has(t.name))
          : result.tools;
      record.status = 'connected';
      record.lastError = null;
      record.lastDiscoveredAt = new Date().toISOString();
    } else {
      record.status = 'error';
      record.lastError = result.error ?? 'Discovery failed';
    }
  }

  // ── Connect / manage ───────────────────────────────────────────────────────

  async addCustomServer(
    input: AddCustomMcpInput,
  ): Promise<{ ok: boolean; server?: McpServerInfo; error?: string }> {
    const name = input.name.trim();
    if (!name) return { ok: false, error: 'Name is required' };
    if (input.transport === 'stdio' && !input.command?.trim()) {
      return { ok: false, error: 'Command is required for stdio servers' };
    }
    if (input.transport === 'http' && !/^https?:\/\//.test(input.url ?? '')) {
      return { ok: false, error: 'A valid http(s) URL is required' };
    }

    const taken = new Set([...this.servers.values()].map((s) => s.slug));
    const record: ServerRecord = {
      id: randomUUID().replace(/-/g, ''),
      slug: slugifyServerName(name, taken),
      name,
      kind: 'custom',
      transport: input.transport,
      command: input.command?.trim() ?? null,
      args: input.args ?? [],
      url: input.url?.trim() ?? null,
      env: input.env ?? {},
      headers: input.headers ?? {},
      clientId: null,
      clientSecret: null,
      tokens: null,
      chatEnabled: true,
      status: 'discovering',
      lastError: null,
      lastDiscoveredAt: null,
      tools: [],
      accountLabel: null,
    };

    this.applyDiscovery(record, await this.runDiscovery(record));
    if (record.status !== 'connected') {
      // Do not persist broken configs — the modal shows the error inline and
      // the user retries with corrected values.
      return { ok: false, error: record.lastError ?? 'Could not reach the server' };
    }

    this.servers.set(record.id, record);
    await this.persistSecrets(record);
    await this.addToIndex(record.id);
    await this.upsertBackendRow(record);
    this.emitChanged();
    return { ok: true, server: toInfo(record) };
  }

  async startGoogleDriveOAuth(input: {
    clientId?: string;
    clientSecret?: string;
    reuseGmail?: boolean;
  }): Promise<{ ok: boolean; server?: McpServerInfo; error?: string }> {
    try {
      let clientId = input.clientId?.trim() ?? '';
      let clientSecret = input.clientSecret?.trim() ?? '';
      if (input.reuseGmail) {
        const gmailClient = await this.readGmailClient();
        if (!gmailClient) {
          return { ok: false, error: 'No Gmail OAuth client found to reuse' };
        }
        clientId = gmailClient.clientId;
        clientSecret = gmailClient.clientSecret;
      }
      if (!clientId || !clientSecret) {
        return { ok: false, error: 'Client ID and secret are required' };
      }

      const tokens = await runOAuthFlow(this.provider, clientId, clientSecret, {
        successTitle: 'Google Drive connected',
      });
      const userInfo = await this.provider.getUserInfo(tokens.accessToken);

      // Single Drive connection: connecting again replaces the existing one.
      const existing = [...this.servers.values()].find((s) => s.kind === 'gdrive');
      if (existing) await this.removeServer(existing.id);

      const record: ServerRecord = {
        id: randomUUID().replace(/-/g, ''),
        slug: GDRIVE_SLUG,
        name: 'Google Drive',
        kind: 'gdrive',
        transport: 'http',
        command: null,
        args: [],
        url: GDRIVE_MCP_URL,
        env: {},
        headers: {},
        clientId,
        clientSecret,
        tokens,
        chatEnabled: true,
        status: 'discovering',
        lastError: null,
        lastDiscoveredAt: null,
        tools: [],
        accountLabel: userInfo.email || null,
      };

      this.applyDiscovery(record, await this.runDiscovery(record));
      // Keep the connection even if discovery failed (OAuth succeeded; the
      // Drive MCP API may just not be enabled yet) — status/error explain it.
      this.servers.set(record.id, record);
      await this.persistSecrets(record);
      await this.addToIndex(record.id);
      await this.upsertBackendRow(record);
      this.emitChanged();
      if (record.status !== 'connected') {
        return { ok: false, server: toInfo(record), error: record.lastError ?? undefined };
      }
      return { ok: true, server: toInfo(record) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Whether a Gmail BYO OAuth client exists whose credentials we can reuse. */
  async gdriveHasGmailClient(): Promise<boolean> {
    try {
      return (await this.readGmailClient()) !== null;
    } catch {
      return false; // backend hiccup — just hide the shortcut
    }
  }

  private async readGmailClient(): Promise<{ clientId: string; clientSecret: string } | null> {
    const port = this.deps.backendPort;
    const index = (await backendGetSetting<string[]>(port, GMAIL_INDEX_KEY)) ?? [];
    for (const accountId of index) {
      const [clientId, encSecret] = await Promise.all([
        backendGetSettingStrict<string>(port, gmailSettingKey(accountId, 'client_id')),
        backendGetSettingStrict<string>(port, gmailSettingKey(accountId, 'client_secret')),
      ]);
      const clientSecret = encSecret ? decryptFromStorage(encSecret) : null;
      if (clientId && clientSecret) return { clientId, clientSecret };
    }
    return null;
  }

  async rediscover(
    serverId: string,
  ): Promise<{ ok: boolean; tools?: DiscoveredTool[]; error?: string }> {
    const record = this.servers.get(serverId);
    if (!record) return { ok: false, error: 'Server not found' };
    record.status = 'discovering';
    await this.upsertBackendRow(record);
    this.emitChanged();
    this.applyDiscovery(record, await this.runDiscovery(record));
    await this.upsertBackendRow(record);
    this.emitChanged();
    return record.status === 'connected'
      ? { ok: true, tools: record.tools }
      : { ok: false, error: record.lastError ?? 'Discovery failed' };
  }

  async setChatEnabled(
    serverId: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const record = this.servers.get(serverId);
    if (!record) return { ok: false, error: 'Server not found' };
    record.chatEnabled = enabled;
    await this.upsertBackendRow(record);
    this.emitChanged();
    return { ok: true };
  }

  async removeServer(serverId: string): Promise<{ ok: boolean; error?: string }> {
    this.servers.delete(serverId);
    // Grants cascade with the backend row.
    await backendJsonRequest(this.deps.backendPort, 'DELETE', `/mcp-servers/${serverId}`).catch(
      () => undefined,
    );
    await Promise.all(
      MCP_SERVER_FIELDS.map((f) =>
        backendPutSetting(this.deps.backendPort, mcpSettingKey(serverId, f), ''),
      ),
    );
    const index = (await backendGetSetting<string[]>(this.deps.backendPort, MCP_INDEX_KEY)) ?? [];
    await backendPutSetting(
      this.deps.backendPort,
      MCP_INDEX_KEY,
      index.filter((x) => x !== serverId),
    );
    this.emitChanged();
    return { ok: true };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  listServers(): McpServerInfo[] {
    return [...this.servers.values()].map(toInfo);
  }

  getServer(serverId: string): McpServerInfo | null {
    const record = this.servers.get(serverId);
    return record ? toInfo(record) : null;
  }

  // ── Per-run config resolution ──────────────────────────────────────────────

  /** Servers the main Cerebro chat agent should load. */
  chatEnabledServerIds(): string[] {
    return [...this.servers.values()]
      .filter((s) => s.chatEnabled && s.status === 'connected')
      .map((s) => s.id);
  }

  /** Server ids granted to an expert (healthy ones only). */
  async serverIdsGrantedToExpert(expertId: string): Promise<string[]> {
    const res = await backendJsonRequest<Array<{ mcp_server_id: string }>>(
      this.deps.backendPort,
      'GET',
      `/experts/${encodeURIComponent(expertId)}/mcp-grants`,
    );
    if (!res.ok || !res.data) return [];
    return res.data
      .map((g) => g.mcp_server_id)
      .filter((id) => this.servers.get(id)?.status === 'connected');
  }

  /**
   * Resolve the given servers into an --mcp-config payload + env overlay.
   * Refreshes near-expiry Drive tokens first; servers that fail to resolve
   * are skipped (a broken MCP server must never block a run).
   */
  async getConfigForRun(serverIds: string[]): Promise<McpRunConfig> {
    const resolved: ResolvedMcpServer[] = [];
    for (const id of serverIds) {
      const record = this.servers.get(id);
      if (!record || record.status !== 'connected') continue;
      if (record.transport === 'stdio') {
        resolved.push({
          slug: record.slug,
          transport: 'stdio',
          command: record.command ?? '',
          args: record.args,
          env: record.env,
        });
        continue;
      }
      let bearerToken: string | undefined;
      if (record.kind === 'gdrive') {
        try {
          bearerToken = await this.getValidAccessToken(record);
        } catch (err) {
          console.warn(`[MCP] skipping ${record.slug}: token refresh failed`, err);
          continue;
        }
      }
      resolved.push({
        slug: record.slug,
        transport: 'http',
        url: record.url ?? '',
        headers: record.headers,
        bearerToken,
      });
    }
    return buildMcpRunConfig(resolved);
  }

  // ── Token management ───────────────────────────────────────────────────────

  private async getValidAccessToken(record: ServerRecord): Promise<string> {
    if (!record.tokens) throw new TokenExpiredError('Not authorized; connect required');
    if (record.tokens.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return record.tokens.accessToken;
    }
    if (!record.tokens.refreshToken) {
      await this.markAuthExpired(record, 'No refresh token; reconnect required');
      throw new TokenExpiredError('No refresh token; reconnect required');
    }
    try {
      record.tokens = await this.provider.refresh({
        client: {
          clientId: record.clientId ?? '',
          clientSecret: record.clientSecret ?? '',
          redirectUri: '',
        },
        refreshToken: record.tokens.refreshToken,
      });
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        await this.markAuthExpired(record, err.message);
      }
      throw err;
    }
    await this.persistSecrets(record);
    return record.tokens.accessToken;
  }

  private async markAuthExpired(record: ServerRecord, message: string): Promise<void> {
    record.status = 'auth_expired';
    record.lastError = message;
    await this.upsertBackendRow(record).catch(() => undefined);
    this.emitChanged();
  }

  private emitChanged(): void {
    if (this.webContents && !this.webContents.isDestroyed()) {
      this.webContents.send(IPC_CHANNELS.MCP_CHANGED);
    }
  }
}

function parseJsonRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    /* corrupted blob — treat as empty */
  }
  return {};
}

function toInfo(record: ServerRecord): McpServerInfo {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    kind: record.kind,
    transport: record.transport,
    command: record.command,
    args: record.args,
    url: record.url,
    envNames: Object.keys(record.env),
    headerNames: Object.keys(record.headers),
    chatEnabled: record.chatEnabled,
    status: record.status,
    lastError: record.lastError,
    lastDiscoveredAt: record.lastDiscoveredAt,
    tools: record.tools,
    accountLabel: record.accountLabel,
  };
}
