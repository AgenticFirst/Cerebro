/**
 * SlackApi tests — focus on the parts we own (token scrubbing). We can't
 * sensibly mock the entire @slack/web-api surface, so we keep the network-y
 * methods covered at the bridge level via integration-style stubs.
 */
import { describe, expect, it } from 'vitest';
import { scrubTokenish, SlackApiError } from '../api';

describe('scrubTokenish', () => {
  it('redacts xoxb- bot tokens', () => {
    expect(scrubTokenish('Bearer xoxb-1234567890-abcdef')).toContain('***');
    expect(scrubTokenish('Bearer xoxb-1234567890-abcdef')).not.toContain('xoxb-');
  });
  it('redacts xapp- app-level tokens', () => {
    expect(scrubTokenish('xapp-1-AAAAAAAAA-1111111111111-bbbbbbbb')).toContain('***');
    expect(scrubTokenish('xapp-1-AAAAAAAAA-1111111111111-bbbbbbbb')).not.toContain('xapp-');
  });
  it('redacts user / legacy tokens (xoxp-, xoxs-)', () => {
    expect(scrubTokenish('legacy xoxp-1234567890-abcdef-ghijklmn')).not.toContain('xoxp-');
    expect(scrubTokenish('shared xoxs-1234567890-abcdef-ghijklmn')).not.toContain('xoxs-');
  });
  it('passes plain text unchanged', () => {
    expect(scrubTokenish('the bridge is healthy')).toBe('the bridge is healthy');
  });
  it('handles empty input', () => {
    expect(scrubTokenish('')).toBe('');
  });
});

describe('SlackApiError', () => {
  it('captures method + code + scrubs the message', () => {
    const e = new SlackApiError('auth.test', 'invalid_auth', 'Bearer xoxb-leaky-token failed');
    expect(e.method).toBe('auth.test');
    expect(e.code).toBe('invalid_auth');
    expect(e.message).not.toContain('xoxb-');
  });
});
