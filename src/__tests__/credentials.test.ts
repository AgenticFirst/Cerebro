import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

let encryptionAvailable = true;
const mockEncryptString = vi.fn((value: string) => Buffer.from(`enc:${value}`));
const mockDecryptString = vi.fn((buffer: Buffer) => {
  const str = buffer.toString();
  if (!str.startsWith('enc:')) throw new Error('Decryption failed');
  return str.slice(4);
});
const mockGetPath = vi.fn(() => '/mock/userData');

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (v: string) => mockEncryptString(v),
    decryptString: (b: Buffer) => mockDecryptString(b),
  },
  app: {
    getPath: (name: string) => mockGetPath(name),
  },
}));

// In-memory filesystem with spies
let fileSystem: Record<string, string> = {};
const writeFileSyncCalls: Array<{ path: string; content: string; encoding?: string }> = [];
const renameSyncCalls: Array<{ src: string; dest: string }> = [];

vi.mock('node:fs', () => ({
  default: {
    readFileSync: (p: string) => {
      if (!(p in fileSystem)) throw new Error('ENOENT');
      return fileSystem[p];
    },
    writeFileSync: (p: string, content: string, encoding?: string) => {
      writeFileSyncCalls.push({ path: p, content, encoding });
      fileSystem[p] = content;
    },
    renameSync: (src: string, dest: string) => {
      renameSyncCalls.push({ src, dest });
      if (!(src in fileSystem)) throw new Error('ENOENT');
      fileSystem[dest] = fileSystem[src];
      delete fileSystem[src];
    },
    existsSync: (p: string) => p in fileSystem || p === '/mock/userData',
    mkdirSync: () => {},
  },
}));

import {
  initCredentialStore,
  setCredential,
  getCredential,
  hasCredential,
  deleteCredential,
  clearCredentials,
  listCredentials,
} from '../credentials';

const STORE_PATH = '/mock/userData/credentials.enc';
const TMP_PATH = STORE_PATH + '.tmp';

beforeEach(() => {
  fileSystem = {};
  encryptionAvailable = true;
  mockEncryptString.mockClear();
  mockDecryptString.mockClear();
  writeFileSyncCalls.length = 0;
  renameSyncCalls.length = 0;
  initCredentialStore();
});

describe('credentials store', () => {
  describe('set + has', () => {
    it('stores a credential and reports it exists', () => {
      const result = setCredential('anthropic', 'api_key', 'sk-ant-test');
      expect(result.ok).toBe(true);
      expect(hasCredential('anthropic', 'api_key')).toBe(true);
    });

    it('reports false for non-existent credential', () => {
      expect(hasCredential('anthropic', 'api_key')).toBe(false);
    });
  });

  describe('set + get (main-process decryption)', () => {
    it('round-trips through encrypt/decrypt', () => {
      setCredential('openai', 'api_key', 'sk-test-123');
      const value = getCredential('openai', 'api_key');
      expect(value).toBe('sk-test-123');
    });

    it('returns null for non-existent key', () => {
      expect(getCredential('openai', 'api_key')).toBeNull();
    });

    it('returns null when decryption throws', () => {
      setCredential('anthropic', 'api_key', 'real-key');
      // Corrupt the encrypted blob on disk so decryptString throws
      const store = JSON.parse(fileSystem[STORE_PATH]);
      store['anthropic:api_key'].encrypted = Buffer.from('garbage').toString('base64');
      fileSystem[STORE_PATH] = JSON.stringify(store);

      expect(getCredential('anthropic', 'api_key')).toBeNull();
    });
  });

  describe('overwrite', () => {
    it('replaces an existing credential with a new value', () => {
      setCredential('anthropic', 'api_key', 'old-key');
      setCredential('anthropic', 'api_key', 'new-key');

      expect(getCredential('anthropic', 'api_key')).toBe('new-key');
    });
  });

  describe('delete', () => {
    it('removes a stored credential from both has and get', () => {
      setCredential('anthropic', 'api_key', 'sk-ant-test');
      deleteCredential('anthropic', 'api_key');

      expect(hasCredential('anthropic', 'api_key')).toBe(false);
      expect(getCredential('anthropic', 'api_key')).toBeNull();
    });

    it('succeeds silently for non-existent key', () => {
      const result = deleteCredential('anthropic', 'api_key');
      expect(result.ok).toBe(true);
    });
  });

  describe('clear', () => {
    it('clears all credentials when no service specified', () => {
      setCredential('anthropic', 'api_key', 'key1');
      setCredential('openai', 'api_key', 'key2');

      const result = clearCredentials();
      expect(result.ok).toBe(true);
      expect(hasCredential('anthropic', 'api_key')).toBe(false);
      expect(hasCredential('openai', 'api_key')).toBe(false);
    });

    it('clears only credentials for the specified service', () => {
      setCredential('anthropic', 'api_key', 'key1');
      setCredential('anthropic', 'org_id', 'org-123');
      setCredential('openai', 'api_key', 'key2');

      clearCredentials('anthropic');
      expect(hasCredential('anthropic', 'api_key')).toBe(false);
      expect(hasCredential('anthropic', 'org_id')).toBe(false);
      expect(hasCredential('openai', 'api_key')).toBe(true);
    });
  });

  describe('list', () => {
    it('returns metadata without secrets', () => {
      setCredential('anthropic', 'api_key', 'secret-value', 'Anthropic Key');
      const list = listCredentials();

      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        service: 'anthropic',
        key: 'api_key',
        label: 'Anthropic Key',
        updatedAt: expect.any(String),
      });
      expect(JSON.stringify(list)).not.toContain('secret-value');
      expect(JSON.stringify(list)).not.toContain('encrypted');
    });

    it('lists multiple keys for the same service', () => {
      setCredential('anthropic', 'api_key', 'key1');
      setCredential('anthropic', 'org_id', 'org-123');

      const list = listCredentials('anthropic');
      expect(list).toHaveLength(2);
      const keys = list.map((c) => c.key).sort();
      expect(keys).toEqual(['api_key', 'org_id']);
    });

    it('filters by service', () => {
      setCredential('anthropic', 'api_key', 'key1');
      setCredential('openai', 'api_key', 'key2');

      const list = listCredentials('anthropic');
      expect(list).toHaveLength(1);
      expect(list[0].service).toBe('anthropic');
    });

    it('returns empty array when no credentials', () => {
      expect(listCredentials()).toEqual([]);
    });
  });

  describe('encryption unavailable', () => {
    it('returns error from setCredential', () => {
      encryptionAvailable = false;
      const result = setCredential('anthropic', 'api_key', 'test');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('returns null from getCredential', () => {
      encryptionAvailable = false;
      expect(getCredential('anthropic', 'api_key')).toBeNull();
    });
  });

  describe('corrupted file recovery', () => {
    it('recovers from malformed JSON', () => {
      fileSystem[STORE_PATH] = 'not-json{{{';
      expect(hasCredential('anthropic', 'api_key')).toBe(false);
      // Can still write after corruption
      const result = setCredential('anthropic', 'api_key', 'test');
      expect(result.ok).toBe(true);
      expect(getCredential('anthropic', 'api_key')).toBe('test');
    });

    it('recovers from JSON array instead of object', () => {
      fileSystem[STORE_PATH] = '[1, 2, 3]';
      expect(listCredentials()).toEqual([]);
    });

    it('recovers from JSON null', () => {
      fileSystem[STORE_PATH] = 'null';
      expect(listCredentials()).toEqual([]);
    });
  });

  describe('input validation', () => {
    it('rejects empty service', () => {
      const result = setCredential('', 'api_key', 'test');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('rejects empty key', () => {
      const result = setCredential('anthropic', '', 'test');
      expect(result.ok).toBe(false);
    });

    it('rejects empty value', () => {
      const result = setCredential('anthropic', 'api_key', '');
      expect(result.ok).toBe(false);
    });
  });

  describe('on-disk format', () => {
    it('stores base64-encoded encrypted blob with metadata', () => {
      setCredential('anthropic', 'api_key', 'sk-ant-test', 'My Key');
      const stored = JSON.parse(fileSystem[STORE_PATH]);
      const entry = stored['anthropic:api_key'];

      expect(entry).toBeDefined();
      expect(typeof entry.encrypted).toBe('string');
      // Verify it's valid base64
      expect(() => Buffer.from(entry.encrypted, 'base64')).not.toThrow();
      expect(entry.label).toBe('My Key');
      // updatedAt should be a valid ISO date
      expect(new Date(entry.updatedAt).toISOString()).toBe(entry.updatedAt);
    });

    it('never contains plaintext secret on disk', () => {
      setCredential('anthropic', 'api_key', 'sk-ant-supersecret');
      expect(fileSystem[STORE_PATH]).not.toContain('sk-ant-supersecret');
    });
  });

  describe('atomic writes', () => {
    it('writes to .tmp first then renames to final path', () => {
      setCredential('anthropic', 'api_key', 'test');

      expect(writeFileSyncCalls).toHaveLength(1);
      expect(writeFileSyncCalls[0].path).toBe(TMP_PATH);
      expect(writeFileSyncCalls[0].encoding).toBe('utf-8');

      expect(renameSyncCalls).toHaveLength(1);
      expect(renameSyncCalls[0]).toEqual({ src: TMP_PATH, dest: STORE_PATH });
    });
  });
});
