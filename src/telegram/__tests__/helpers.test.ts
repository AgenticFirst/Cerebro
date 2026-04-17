import { describe, expect, it } from 'vitest';
import {
  chunkText,
  parseAllowlistRaw,
  redactForChat,
  SlidingWindowLimiter,
  parseApprovalCallback,
} from '../helpers';

describe('chunkText', () => {
  it('returns a single chunk when shorter than max', () => {
    expect(chunkText('hello', 10)).toEqual(['hello']);
  });

  it('splits at newline boundaries when available', () => {
    const text = 'one two three\nfour five six\nseven eight nine';
    const chunks = chunkText(text, 20);
    // First chunk should end at a newline, never exceed 20
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('falls back to hard cut when no whitespace is in range', () => {
    const text = 'x'.repeat(50);
    const chunks = chunkText(text, 20);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(20);
    expect(chunks[1]).toHaveLength(20);
    expect(chunks[2]).toHaveLength(10);
  });

  it('round-trips for a realistic long paragraph', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text, 80);
    const joined = chunks.join(' ');
    expect(joined).toBe(text);
  });
});

describe('parseAllowlistRaw', () => {
  it('parses a comma-separated list', () => {
    expect(parseAllowlistRaw('123,456, 789')).toEqual(['123', '456', '789']);
  });

  it('filters out non-numeric entries', () => {
    expect(parseAllowlistRaw('12, abc, 34')).toEqual(['12', '34']);
  });

  it('handles whitespace-only input', () => {
    expect(parseAllowlistRaw('   ')).toEqual([]);
  });
});

describe('redactForChat', () => {
  const macDataDir = '/Users/alice/Library/Application Support/Cerebro';
  const linuxDataDir = '/home/alice/.config/Cerebro';

  it('scrubs bot tokens', () => {
    const text = 'leaked: 123456789:AAEabcdefghijklmnopqrstuvwxy123 end';
    const out = redactForChat(text, macDataDir);
    expect(out).not.toContain('AAEabcdefghijklmnopqrstuvwxy123');
    expect(out).toContain('***');
  });

  it.each([
    ['macOS', macDataDir],
    ['Linux', linuxDataDir],
  ])('masks paths under the data dir (%s)', (_platform, dataDir) => {
    const text = `see ${dataDir}/telegram-tmp/abc.ogg for details`;
    const out = redactForChat(text, dataDir);
    expect(out).not.toContain('telegram-tmp/abc.ogg');
    expect(out).toContain('<path>');
  });

  it('masks generic sk-* keys', () => {
    const text = 'api key: sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const out = redactForChat(text, macDataDir);
    expect(out).toContain('<key>');
    expect(out).not.toMatch(/sk-proj-[A-Z0-9]{20,}/);
  });

  it('leaves ordinary text intact', () => {
    const text = 'Nothing sensitive here.';
    expect(redactForChat(text, macDataDir)).toBe(text);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows up to max events within the window', () => {
    const lim = new SlidingWindowLimiter(3, 1_000);
    expect(lim.allow('a', 0)).toBe(true);
    expect(lim.allow('a', 100)).toBe(true);
    expect(lim.allow('a', 200)).toBe(true);
    expect(lim.allow('a', 300)).toBe(false);
  });

  it('expires old entries outside the window', () => {
    const lim = new SlidingWindowLimiter(2, 1_000);
    expect(lim.allow('a', 0)).toBe(true);
    expect(lim.allow('a', 500)).toBe(true);
    expect(lim.allow('a', 900)).toBe(false);
    // After window passes, the first one expires
    expect(lim.allow('a', 1_100)).toBe(true);
  });

  it('tracks keys independently', () => {
    const lim = new SlidingWindowLimiter(1, 1_000);
    expect(lim.allow('a', 0)).toBe(true);
    expect(lim.allow('b', 0)).toBe(true);
    expect(lim.allow('a', 100)).toBe(false);
    expect(lim.allow('b', 100)).toBe(false);
  });
});

describe('parseApprovalCallback', () => {
  it('parses approve payloads', () => {
    expect(parseApprovalCallback('approve:abc123')).toEqual({
      action: 'approve',
      approvalId: 'abc123',
    });
  });

  it('parses deny payloads', () => {
    expect(parseApprovalCallback('deny:xyz')).toEqual({
      action: 'deny',
      approvalId: 'xyz',
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseApprovalCallback('invalid')).toBeNull();
    expect(parseApprovalCallback('approved:abc')).toBeNull();
    expect(parseApprovalCallback('')).toBeNull();
  });

  it('preserves approval IDs with colons', () => {
    expect(parseApprovalCallback('approve:abc:123')).toEqual({
      action: 'approve',
      approvalId: 'abc:123',
    });
  });
});
