import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TelegramApi,
  TelegramApiError,
  sanitizeUrl,
  scrubTokenish,
  escapeMarkdownV2,
  approvalKeyboard,
} from '../api';

describe('scrubTokenish / sanitizeUrl', () => {
  it('scrubs a bot-token-shaped substring', () => {
    const s = 'hit https://api.telegram.org/bot123456789:AAEabcdefghijklmnopqrstuvwxy/getMe';
    expect(scrubTokenish(s)).not.toContain('AAEabcdefghijklmnopqrstuvwxy');
  });

  it('sanitizeUrl redacts everything between /bot and /', () => {
    const url = 'https://api.telegram.org/bot987654321:XYZtokenhere/getUpdates';
    expect(sanitizeUrl(url)).toBe('https://api.telegram.org/bot[redacted]/getUpdates');
  });

  it('leaves non-token text alone', () => {
    expect(scrubTokenish('regular message')).toBe('regular message');
  });
});

describe('escapeMarkdownV2', () => {
  it('escapes all MarkdownV2 reserved characters', () => {
    const raw = '_*[](){}~`>#+-=|.!\\';
    const escaped = escapeMarkdownV2(raw);
    // Every reserved char should be prefixed by a backslash
    for (const ch of raw) {
      expect(escaped).toContain(`\\${ch}`);
    }
  });

  it('passes plain text through', () => {
    expect(escapeMarkdownV2('hello world')).toBe('hello world');
  });
});

describe('approvalKeyboard', () => {
  it('builds an inline keyboard with approve+deny', () => {
    const kb = approvalKeyboard('abc123');
    expect(kb.inline_keyboard).toHaveLength(1);
    expect(kb.inline_keyboard[0]).toHaveLength(2);
    expect(kb.inline_keyboard[0][0].callback_data).toBe('approve:abc123');
    expect(kb.inline_keyboard[0][1].callback_data).toBe('deny:abc123');
  });
});

describe('TelegramApi', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('wraps getMe response through the envelope', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { id: 42, is_bot: true, first_name: 'bot', username: 'botty' } }),
    } as unknown as Response);

    const api = new TelegramApi('123456789:AAEtokenhere123456789');
    const me = await api.getMe();
    expect(me.username).toBe('botty');
    expect(me.id).toBe(42);
  });

  it('throws a TelegramApiError with the Telegram description when ok=false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 401,
      json: async () => ({ ok: false, error_code: 401, description: 'Unauthorized' }),
    } as unknown as Response);

    const api = new TelegramApi('123456789:AAEtokenhere123456789');
    await expect(api.getMe()).rejects.toBeInstanceOf(TelegramApiError);
  });

  it('does NOT leak the token into the thrown error message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('connect ECONNREFUSED — leaked 123456789:AAESECRETtokenSHOULDNOTAPPEAR in logs'),
    );

    const api = new TelegramApi('123456789:AAESECRETtokenSHOULDNOTAPPEAR');
    try {
      await api.getMe();
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(TelegramApiError);
      expect(e.message).not.toContain('AAESECRETtokenSHOULDNOTAPPEAR');
    }
  });

  it('getUpdates uses the given offset and timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: [] }),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    const api = new TelegramApi('123456789:AAEtokenhere123456789');
    await api.getUpdates(42, 30);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.offset).toBe(42);
    expect(body.timeout).toBe(30);
    expect(body.allowed_updates).toEqual(['message', 'callback_query']);
  });
});
