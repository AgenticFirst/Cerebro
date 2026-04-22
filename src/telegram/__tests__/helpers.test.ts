import { describe, expect, it } from 'vitest';
import {
  chunkText,
  parseAllowlistRaw,
  redactForChat,
  SlidingWindowLimiter,
  parseApprovalCallback,
  parseTelegramTriggerRoutine,
  matchesTelegramFilter,
  matchRoutineTriggers,
  type TelegramTriggerRoutine,
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

// ── Telegram trigger routing ─────────────────────────────────────

function makeRoutineRecord(overrides: {
  id?: string;
  name?: string;
  trigger?: { triggerType?: string; config?: Record<string, unknown> } | undefined;
  steps?: unknown[];
  dag_json?: string | null;
}) {
  const dag = overrides.dag_json !== undefined
    ? overrides.dag_json
    : JSON.stringify({
        trigger: overrides.trigger,
        steps: overrides.steps ?? [],
      });
  return {
    id: overrides.id ?? 'r1',
    name: overrides.name ?? 'Test routine',
    is_enabled: true,
    trigger_type: 'telegram_message',
    dag_json: dag,
  };
}

describe('parseTelegramTriggerRoutine', () => {
  it('returns null when dag_json is missing', () => {
    expect(parseTelegramTriggerRoutine(makeRoutineRecord({ dag_json: null }))).toBeNull();
  });

  it('returns null when dag_json is malformed', () => {
    expect(parseTelegramTriggerRoutine(makeRoutineRecord({ dag_json: 'not-json' }))).toBeNull();
  });

  it('returns null when triggerType is not telegram', () => {
    const r = makeRoutineRecord({
      trigger: { triggerType: 'trigger_schedule', config: { chat_id: '123' } },
    });
    expect(parseTelegramTriggerRoutine(r)).toBeNull();
  });

  it('returns null when chat_id is missing', () => {
    const r = makeRoutineRecord({
      trigger: { triggerType: 'trigger_telegram_message', config: {} },
    });
    expect(parseTelegramTriggerRoutine(r)).toBeNull();
  });

  it('parses a minimal telegram trigger', () => {
    const r = makeRoutineRecord({
      trigger: { triggerType: 'trigger_telegram_message', config: { chat_id: '42' } },
    });
    const parsed = parseTelegramTriggerRoutine(r);
    expect(parsed?.trigger.chat_id).toBe('42');
    expect(parsed?.trigger.filter_type).toBe('none');
    expect(parsed?.trigger.filter_value).toBe('');
  });

  it('parses a full filter spec', () => {
    const r = makeRoutineRecord({
      trigger: {
        triggerType: 'trigger_telegram_message',
        config: { chat_id: '*', filter_type: 'keyword', filter_value: 'standup' },
      },
    });
    const parsed = parseTelegramTriggerRoutine(r);
    expect(parsed?.trigger).toEqual({
      chat_id: '*',
      filter_type: 'keyword',
      filter_value: 'standup',
    });
  });

  it('coerces unknown filter_type to none', () => {
    const r = makeRoutineRecord({
      trigger: {
        triggerType: 'trigger_telegram_message',
        config: { chat_id: '7', filter_type: 'bogus', filter_value: 'x' },
      },
    });
    expect(parseTelegramTriggerRoutine(r)?.trigger.filter_type).toBe('none');
  });

  it('passes runtime steps through unchanged', () => {
    const steps = [{ id: 's1', name: 'Step 1', actionType: 'ask_ai' }];
    const r = makeRoutineRecord({
      trigger: { triggerType: 'trigger_telegram_message', config: { chat_id: '1' } },
      steps,
    });
    expect(parseTelegramTriggerRoutine(r)?.dag.steps).toEqual(steps);
  });
});

describe('matchesTelegramFilter', () => {
  it('returns true for filter_type=none', () => {
    expect(matchesTelegramFilter('anything', 'none', '')).toBe(true);
    expect(matchesTelegramFilter('anything', 'none', 'ignored')).toBe(true);
  });

  it('returns true when filter_value is empty regardless of type', () => {
    expect(matchesTelegramFilter('hello', 'keyword', '')).toBe(true);
    expect(matchesTelegramFilter('hello', 'regex', '   ')).toBe(true);
  });

  it('matches keyword on word boundaries, case-insensitive', () => {
    expect(matchesTelegramFilter('Time for STANDUP today', 'keyword', 'standup')).toBe(true);
    expect(matchesTelegramFilter('standuptime', 'keyword', 'standup')).toBe(false);
  });

  it('matches prefix case-insensitively', () => {
    expect(matchesTelegramFilter('HELLO world', 'prefix', 'hello')).toBe(true);
    expect(matchesTelegramFilter('say hello', 'prefix', 'hello')).toBe(false);
  });

  it('matches regex case-insensitively', () => {
    expect(matchesTelegramFilter('order #42 placed', 'regex', '#\\d+')).toBe(true);
    expect(matchesTelegramFilter('no number', 'regex', '#\\d+')).toBe(false);
  });

  it('returns false for invalid regex without throwing', () => {
    expect(matchesTelegramFilter('anything', 'regex', '[bad')).toBe(false);
  });
});

describe('matchRoutineTriggers', () => {
  const baseDag = { steps: [] };
  const exact: TelegramTriggerRoutine = {
    id: 'r-exact', name: 'exact', dag: baseDag,
    trigger: { chat_id: '111', filter_type: 'none' },
  };
  const wildcard: TelegramTriggerRoutine = {
    id: 'r-any', name: 'any', dag: baseDag,
    trigger: { chat_id: '*', filter_type: 'none' },
  };
  const standup: TelegramTriggerRoutine = {
    id: 'r-standup', name: 'standup', dag: baseDag,
    trigger: { chat_id: '*', filter_type: 'keyword', filter_value: 'standup' },
  };

  it('matches exact chat_id', () => {
    const matched = matchRoutineTriggers([exact, wildcard], '111', 'hi');
    expect(matched.map((r) => r.id).sort()).toEqual(['r-any', 'r-exact']);
  });

  it('does not match non-matching exact chat_id', () => {
    const matched = matchRoutineTriggers([exact], '999', 'hi');
    expect(matched).toEqual([]);
  });

  it('wildcard matches any chat', () => {
    const matched = matchRoutineTriggers([wildcard], '999', 'hi');
    expect(matched).toEqual([wildcard]);
  });

  it('combines chat_id + filter', () => {
    expect(matchRoutineTriggers([standup], '999', 'standup time')).toEqual([standup]);
    expect(matchRoutineTriggers([standup], '999', 'no match here')).toEqual([]);
  });

  it('returns multiple matches', () => {
    const matched = matchRoutineTriggers([wildcard, standup], '111', 'standup');
    expect(matched.map((r) => r.id)).toEqual(['r-any', 'r-standup']);
  });
});
