/**
 * Supabase backend-sync types, shared between the main-process holder and the
 * IPC contract. Secrets (the Postgres connection string and the Storage key) are
 * only ever present in their decrypted form inside the main process — the
 * renderer sees status, never plaintext.
 */

export type SupabaseStorageBackend = 'os-keychain' | 'plaintext-fallback';

/** Persisted, device-local backend-mode configuration. Secrets are encrypted. */
export interface SupabaseModeFile {
  mode: 'local' | 'supabase';
  /** Encrypted (v1:enc:…) Postgres connection string for the sync worker. */
  dbUrl?: string;
  /** Supabase project URL, e.g. https://abc.supabase.co (not secret). */
  supabaseUrl?: string;
  /** Encrypted (v1:enc:…) service/anon key, used for Storage uploads. */
  supabaseKey?: string;
  /** Storage bucket name for synced file blobs. */
  storageBucket?: string;
}

/** Decrypted connection details, used inside the main process only. */
export interface SupabaseConnection {
  dbUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  storageBucket: string;
}
// The IPC contract types (SupabaseStatus, SupabaseSyncStatus, SupabaseConnectInput,
// SupabaseConnectResult) live in src/types/ipc.ts — the single source of truth for
// the renderer↔main boundary. Re-exported here so holder/backend-mode can import
// everything Supabase-related from one place.
export type {
  SupabaseStatus,
  SupabaseSyncStatus,
  SupabaseConnectInput,
  SupabaseConnectResult,
} from '../types/ipc';
