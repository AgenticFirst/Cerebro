/**
 * Main-process holder for the Supabase backend-sync connection.
 *
 * Bridges the device-local encrypted store (backend-mode.ts) and the Python
 * backend's /cloud-sync endpoints. Connecting validates the connection string,
 * encrypts + persists it, then tells the running backend to start syncing — no
 * restart needed, because the app's own engine stays on local SQLite (the sync
 * worker is the only thing that talks to Postgres).
 */

import { backendJsonRequest } from '../shared/backend-settings';
import {
  clearConnection,
  getPublicConfig,
  isSupabaseConfigured,
  saveConnection,
  secretBackend,
} from './backend-mode';
import type {
  SupabaseConnectInput,
  SupabaseConnectResult,
  SupabaseStatus,
  SupabaseSyncStatus,
} from './types';

export class SupabaseHolder {
  constructor(private readonly getPort: () => number | null) {}

  private port(): number | null {
    return this.getPort();
  }

  async testConnection(dbUrl: string): Promise<{ ok: boolean; error?: string }> {
    const port = this.port();
    if (!port) return { ok: false, error: 'Backend not ready' };
    const res = await backendJsonRequest<{ ok: boolean; error?: string }>(
      port,
      'POST',
      '/cloud-sync/test',
      { db_url: dbUrl },
    );
    if (!res.ok || !res.data) return { ok: false, error: 'Could not reach the backend' };
    return res.data;
  }

  async connect(input: SupabaseConnectInput): Promise<SupabaseConnectResult> {
    const dbUrl = input.dbUrl.trim();
    if (!dbUrl) return { ok: false, error: 'A Postgres connection string is required' };

    const test = await this.testConnection(dbUrl);
    if (!test.ok) return { ok: false, error: test.error || 'Connection test failed' };

    saveConnection({
      dbUrl,
      supabaseUrl: input.supabaseUrl.trim(),
      supabaseKey: input.supabaseKey.trim(),
      storageBucket: (input.storageBucket || 'cerebro').trim(),
    });

    const port = this.port();
    if (port) {
      await backendJsonRequest(port, 'POST', '/cloud-sync/connect', {
        db_url: dbUrl,
        supabase_url: input.supabaseUrl.trim() || null,
        supabase_key: input.supabaseKey.trim() || null,
        storage_bucket: (input.storageBucket || 'cerebro').trim(),
        seed: !!input.seed,
      });
    }
    return { ok: true, status: await this.status() };
  }

  async disconnect(): Promise<SupabaseStatus> {
    const port = this.port();
    if (port) await backendJsonRequest(port, 'POST', '/cloud-sync/disconnect');
    clearConnection();
    return this.status();
  }

  /** Ask the backend to sync right now. */
  async trigger(): Promise<void> {
    const port = this.port();
    if (port) await backendJsonRequest(port, 'POST', '/cloud-sync/trigger');
  }

  /**
   * Called at startup: if this device already has a connection, the backend was
   * launched with the env vars and auto-starts sync. Nothing to do here beyond
   * confirming status, but kept for symmetry with other bridges' init().
   */
  async init(): Promise<void> {
    /* backend auto-starts from env (see startPythonBackend); no-op */
  }

  async status(): Promise<SupabaseStatus> {
    const pub = getPublicConfig();
    let sync: SupabaseSyncStatus | null = null;
    const port = this.port();
    if (port) {
      const res = await backendJsonRequest<SupabaseSyncStatus>(port, 'GET', '/cloud-sync/status');
      if (res.ok) sync = res.data;
    }
    return {
      connected: isSupabaseConfigured(),
      supabaseUrl: pub.supabaseUrl,
      storageBucket: pub.storageBucket,
      secretBackend: secretBackend(),
      sync,
    };
  }
}
