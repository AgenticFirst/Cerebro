/**
 * Tests for the main-process secure-token vault. Both branches exercised by
 * toggling `safeStorage.isEncryptionAvailable` on the Electron mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSafeStorage = vi.hoisted(() => ({
  available: true,
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: vi.fn((b: Buffer) => {
    const raw = b.toString();
    if (!raw.startsWith('enc:')) throw new Error('bad blob');
    return raw.slice(4);
  }),
}));
mockSafeStorage.isEncryptionAvailable.mockImplementation(() => mockSafeStorage.available);

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
}));

import {
  encryptForStorage,
  decryptFromStorage,
  isStoredPlaintext,
  isEncryptionAvailable,
  backend,
} from '../secure-token';

beforeEach(() => {
  mockSafeStorage.available = true;
  mockSafeStorage.encryptString.mockClear();
  mockSafeStorage.decryptString.mockClear();
});

describe('isEncryptionAvailable / backend', () => {
  it('reports os-keychain when safeStorage is available', () => {
    mockSafeStorage.available = true;
    expect(isEncryptionAvailable()).toBe(true);
    expect(backend()).toBe('os-keychain');
  });

  it('reports plaintext-fallback when safeStorage is unavailable', () => {
    mockSafeStorage.available = false;
    expect(isEncryptionAvailable()).toBe(false);
    expect(backend()).toBe('plaintext-fallback');
  });

  it('returns false when safeStorage throws', () => {
    mockSafeStorage.isEncryptionAvailable.mockImplementationOnce(() => { throw new Error('no DBus'); });
    expect(isEncryptionAvailable()).toBe(false);
  });
});

describe('encryptForStorage', () => {
  it('returns an empty string for empty input', () => {
    expect(encryptForStorage('')).toBe('');
    expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('writes a v1:enc envelope when encryption is available', () => {
    const out = encryptForStorage('botToken-123');
    expect(out.startsWith('v1:enc:')).toBe(true);
    expect(mockSafeStorage.encryptString).toHaveBeenCalledWith('botToken-123');
  });

  it('falls back to v1:plain when safeStorage is unavailable', () => {
    mockSafeStorage.available = false;
    const out = encryptForStorage('botToken-123');
    expect(out).toBe('v1:plain:botToken-123');
    expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
  });
});

describe('decryptFromStorage', () => {
  it('returns null for missing input', () => {
    expect(decryptFromStorage(null)).toBeNull();
    expect(decryptFromStorage(undefined)).toBeNull();
    expect(decryptFromStorage('')).toBeNull();
  });

  it('round-trips a v1:enc envelope', () => {
    const wrapped = encryptForStorage('round-trip-token');
    expect(decryptFromStorage(wrapped)).toBe('round-trip-token');
  });

  it('returns null when a v1:enc envelope fails to decrypt', () => {
    // Forge an envelope with garbage that the mock will reject
    const garbage = 'v1:enc:' + Buffer.from('not-prefixed').toString('base64');
    expect(decryptFromStorage(garbage)).toBeNull();
  });

  it('reads a v1:plain envelope', () => {
    expect(decryptFromStorage('v1:plain:abc123')).toBe('abc123');
  });

  it('treats unprefixed strings as legacy plaintext', () => {
    // From-before-the-vault tokens look like raw bot-API strings, e.g. "12345:AA…"
    expect(decryptFromStorage('123456:AAFooBarBaz')).toBe('123456:AAFooBarBaz');
  });
});

describe('isStoredPlaintext', () => {
  it('returns false for missing input', () => {
    expect(isStoredPlaintext(null)).toBe(false);
    expect(isStoredPlaintext(undefined)).toBe(false);
    expect(isStoredPlaintext('')).toBe(false);
  });

  it('returns false for v1:enc envelopes', () => {
    expect(isStoredPlaintext(encryptForStorage('x'))).toBe(false);
  });

  it('returns true for v1:plain envelopes', () => {
    expect(isStoredPlaintext('v1:plain:x')).toBe(true);
  });

  it('returns true for legacy plaintext (no envelope)', () => {
    // The bridge uses this to trigger one-shot migration on next save.
    expect(isStoredPlaintext('123456:AAFoo')).toBe(true);
  });
});
