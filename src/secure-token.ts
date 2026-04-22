/**
 * Tiny main-process helper for at-rest encryption of small secrets (Telegram
 * bot token today; can be reused for other tokens later).
 *
 * Encrypted blobs use a versioned text envelope so we can tell encrypted from
 * legacy plaintext at read time and migrate transparently:
 *
 *   "v1:enc:<base64>"   — safeStorage-encrypted (OS keychain / DPAPI / libsecret)
 *   "v1:plain:<value>"  — fallback when safeStorage is unavailable
 *   <anything else>     — legacy plaintext from before this module existed
 *
 * Renderer code MUST NOT call decrypt: token plaintext stays in the main
 * process. The renderer only knows whether a token is configured.
 */

import { safeStorage } from 'electron';

export type StorageBackend = 'os-keychain' | 'plaintext-fallback';

export interface SecureTokenInfo {
  configured: boolean;
  backend: StorageBackend;
}

const ENC_PREFIX = 'v1:enc:';
const PLAIN_PREFIX = 'v1:plain:';

/** True when the OS provides an encryption backend we can use. */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function backend(): StorageBackend {
  return isEncryptionAvailable() ? 'os-keychain' : 'plaintext-fallback';
}

/**
 * Wrap a plaintext value for storage. Falls back to a marked-plain envelope
 * if the OS keychain isn't available (Linux without libsecret, headless CI).
 */
export function encryptForStorage(plaintext: string): string {
  if (!plaintext) return '';
  if (isEncryptionAvailable()) {
    const buf = safeStorage.encryptString(plaintext);
    return ENC_PREFIX + buf.toString('base64');
  }
  return PLAIN_PREFIX + plaintext;
}

/**
 * Recover the plaintext from a stored envelope. Accepts both v1 envelopes and
 * legacy bare-string values (from before encryption was introduced) so existing
 * configs keep working until they're saved again.
 *
 * Returns null only when the stored value is missing or a v1:enc envelope
 * fails to decrypt (corrupt blob / different OS user / new install).
 */
export function decryptFromStorage(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith(ENC_PREFIX)) {
    const b64 = stored.slice(ENC_PREFIX.length);
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch {
      return null;
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }
  // Legacy plaintext — the bridge will re-save with encryption on the next
  // settings write, so this branch is transitional.
  return stored;
}

/** True if a stored envelope was written without encryption (legacy or fallback). */
export function isStoredPlaintext(stored: string | null | undefined): boolean {
  if (!stored) return false;
  return !stored.startsWith(ENC_PREFIX);
}
