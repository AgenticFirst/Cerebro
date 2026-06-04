/**
 * Device-local store for the Supabase backend-sync connection.
 *
 * The connection lives in a small JSON file under userData — NOT in the synced
 * database (that would be a chicken-and-egg: you can't read the connection from
 * the database it configures), and the secrets are device-specific anyway. The
 * Postgres connection string and Storage key are encrypted at rest with the OS
 * keychain via secure-token.ts; only the main process ever decrypts them.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { backend, decryptFromStorage, encryptForStorage } from '../secure-token';
import type { SupabaseConnection, SupabaseModeFile, SupabaseStorageBackend } from './types';

function modeFilePath(): string {
  return path.join(app.getPath('userData'), 'cerebro-backend-mode.json');
}

function readFile(): SupabaseModeFile | null {
  try {
    const raw = fs.readFileSync(modeFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as SupabaseModeFile;
    if (parsed && (parsed.mode === 'local' || parsed.mode === 'supabase')) {
      return parsed;
    }
  } catch {
    /* missing or corrupt — treat as local mode */
  }
  return null;
}

function writeFile(cfg: SupabaseModeFile): void {
  fs.writeFileSync(modeFilePath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

/** True when a Supabase project is configured for this device. */
export function isSupabaseConfigured(): boolean {
  const cfg = readFile();
  return !!cfg && cfg.mode === 'supabase' && !!cfg.dbUrl;
}

export function secretBackend(): SupabaseStorageBackend {
  return backend();
}

/** Persist a new connection, encrypting the secrets. */
export function saveConnection(input: {
  dbUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  storageBucket: string;
}): void {
  writeFile({
    mode: 'supabase',
    dbUrl: encryptForStorage(input.dbUrl),
    supabaseUrl: input.supabaseUrl,
    supabaseKey: encryptForStorage(input.supabaseKey),
    storageBucket: input.storageBucket,
  });
}

/** Forget the connection (revert to local-only). Leaves the local DB intact. */
export function clearConnection(): void {
  try {
    fs.rmSync(modeFilePath(), { force: true });
  } catch {
    /* ignore */
  }
}

/** Decrypted connection for use inside the main process (null if local-only). */
export function getConnection(): SupabaseConnection | null {
  const cfg = readFile();
  if (!cfg || cfg.mode !== 'supabase' || !cfg.dbUrl) return null;
  const dbUrl = decryptFromStorage(cfg.dbUrl);
  if (!dbUrl) return null; // secret unreadable (e.g. different OS user) — treat as not configured
  return {
    dbUrl,
    supabaseUrl: cfg.supabaseUrl ?? '',
    supabaseKey: decryptFromStorage(cfg.supabaseKey) ?? '',
    storageBucket: cfg.storageBucket || 'cerebro',
  };
}

/** Non-secret view for status/UI. */
export function getPublicConfig(): { supabaseUrl: string | null; storageBucket: string | null } {
  const cfg = readFile();
  if (!cfg || cfg.mode !== 'supabase') return { supabaseUrl: null, storageBucket: null };
  return { supabaseUrl: cfg.supabaseUrl ?? null, storageBucket: cfg.storageBucket ?? null };
}
