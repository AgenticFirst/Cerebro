import { safeStorage, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { CredentialResult, CredentialInfo } from './types/ipc';

interface StoredEntry {
  encrypted: string;
  label?: string;
  updatedAt: string;
}

type Store = Record<string, StoredEntry>;

let storePath = '';

function compositeKey(service: string, key: string): string {
  return `${service}:${key}`;
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): void {
  const dir = path.dirname(storePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = storePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmpPath, storePath);
}

export function initCredentialStore(): void {
  storePath = path.join(app.getPath('userData'), 'credentials.enc');
}

export function setCredential(
  service: string,
  key: string,
  value: string,
  label?: string,
): CredentialResult {
  if (!service || !key || !value) {
    return { ok: false, error: 'Service, key, and value must be non-empty' };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS encryption is not available' };
  }

  const store = readStore();
  const encrypted = safeStorage.encryptString(value);

  store[compositeKey(service, key)] = {
    encrypted: encrypted.toString('base64'),
    label,
    updatedAt: new Date().toISOString(),
  };

  writeStore(store);
  return { ok: true };
}

export function getCredential(service: string, key: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;

  const store = readStore();
  const entry = store[compositeKey(service, key)];
  if (!entry) return null;

  try {
    const buffer = Buffer.from(entry.encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  } catch {
    return null;
  }
}

export function hasCredential(service: string, key: string): boolean {
  const store = readStore();
  return compositeKey(service, key) in store;
}

export function deleteCredential(service: string, key: string): CredentialResult {
  const store = readStore();
  const ck = compositeKey(service, key);

  if (!(ck in store)) {
    return { ok: true };
  }

  delete store[ck];
  writeStore(store);
  return { ok: true };
}

export function clearCredentials(service?: string): CredentialResult {
  if (!service) {
    writeStore({});
    return { ok: true };
  }

  const store = readStore();
  const prefix = `${service}:`;
  for (const ck of Object.keys(store)) {
    if (ck.startsWith(prefix)) {
      delete store[ck];
    }
  }
  writeStore(store);
  return { ok: true };
}

export function listCredentials(service?: string): CredentialInfo[] {
  const store = readStore();
  const results: CredentialInfo[] = [];

  for (const [ck, entry] of Object.entries(store)) {
    const colonIdx = ck.indexOf(':');
    if (colonIdx === -1) continue;

    const svc = ck.slice(0, colonIdx);
    const key = ck.slice(colonIdx + 1);

    if (service && svc !== service) continue;

    results.push({
      service: svc,
      key,
      label: entry.label,
      updatedAt: entry.updatedAt,
    });
  }

  return results;
}
