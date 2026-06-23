/**
 * Pure-helper tests for the Slack bridge. No network, no Bolt, no Electron —
 * these are the bedrock the bridge depends on, so they must be airtight.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationKey,
  isSessionExpired,
  migrateConversationMap,
  parseAllowlistRaw,
  parseSlashCommandText,
  chunkSlackText,
  extractTrailingFilePaths,
  EventDedupe,
  SlidingWindowLimiter,
  redactSlackPayload,
  stripBotMention,
  parseSlackTriggerRoutine,
  matchSlackRoutineTriggers,
  matchesSlackFilter,
  pickAudioAttachment,
  pickNonAudioFiles,
  type BackendRoutineRecord,
} from '../helpers';
import type { SlackFile } from '../types';

describe('conversationKey', () => {
  it('keeps a DM stable across messages (ignores per-message ts)', () => {
    // The original bug: every DM message had a unique ts → a new conversation.
    const first = conversationKey({
      teamId: 'T1',
      channel: 'D1',
      channelType: 'im',
      userId: 'U1',
      ts: '1.000',
    });
    const second = conversationKey({
      teamId: 'T1',
      channel: 'D1',
      channelType: 'im',
      userId: 'U1',
      ts: '99.000',
    });
    expect(first.key).toBe('dm:T1:D1');
    expect(second.key).toBe(first.key);
    expect(first.surface).toBe('dm');
    expect(first.rotates).toBe(true);
  });

  it('keeps a DM stable even when a reply lands in a thread', () => {
    const top = conversationKey({
      teamId: 'T1',
      channel: 'D1',
      channelType: 'im',
      userId: 'U1',
      ts: '1.000',
    });
    const threaded = conversationKey({
      teamId: 'T1',
      channel: 'D1',
      channelType: 'im',
      userId: 'U1',
      ts: '5.000',
      threadTs: '2.000',
    });
    expect(threaded.key).toBe(top.key);
  });

  it('keys a channel thread by its root and never rotates', () => {
    const k = conversationKey({
      teamId: 'T1',
      channel: 'C1',
      channelType: 'channel',
      userId: 'U1',
      ts: '5.000',
      threadTs: '2.000',
    });
    expect(k.key).toBe('thread:T1:C1:2.000');
    expect(k.surface).toBe('thread');
    expect(k.rotates).toBe(false);
  });

  it('keys a top-level channel @mention per channel+user and rotates', () => {
    const k = conversationKey({
      teamId: 'T1',
      channel: 'C1',
      channelType: 'channel',
      userId: 'U1',
      ts: '5.000',
    });
    expect(k.key).toBe('mention:T1:C1:U1');
    expect(k.surface).toBe('mention');
    expect(k.rotates).toBe(true);
    // A different user in the same channel gets a distinct conversation.
    const other = conversationKey({
      teamId: 'T1',
      channel: 'C1',
      channelType: 'channel',
      userId: 'U2',
      ts: '5.000',
    });
    expect(other.key).not.toBe(k.key);
  });
});

describe('isSessionExpired', () => {
  const now = 1_000_000_000;
  const sixHours = 6 * 60 * 60_000;
  it('is not expired within the idle window', () => {
    expect(isSessionExpired(now - sixHours + 1, now, sixHours)).toBe(false);
  });
  it('is expired once the window is exceeded', () => {
    expect(isSessionExpired(now - sixHours - 1, now, sixHours)).toBe(true);
  });
  it('treats a missing/zero timestamp as expired', () => {
    expect(isSessionExpired(0, now, sixHours)).toBe(true);
    expect(isSessionExpired(NaN, now, sixHours)).toBe(true);
  });
});

describe('migrateConversationMap', () => {
  const now = 1_700_000_000_000;
  it('wraps legacy string values without losing the conversation id', () => {
    const out = migrateConversationMap({ 'dm:T1:D1': 'conv123' }, now);
    expect(out['dm:T1:D1']).toEqual({ conversationId: 'conv123', lastActivityAt: now });
  });
  it('preserves already-migrated entry objects', () => {
    const entry = { conversationId: 'conv9', lastActivityAt: 42, lastSeenTs: '5.000' };
    const out = migrateConversationMap({ 'thread:T1:C1:2.000': entry }, now);
    expect(out['thread:T1:C1:2.000']).toEqual(entry);
  });
  it('backfills a missing timestamp on a malformed entry', () => {
    const out = migrateConversationMap({ k: { conversationId: 'c' } }, now);
    expect(out.k).toEqual({ conversationId: 'c', lastActivityAt: now, lastSeenTs: undefined });
  });
  it('drops junk values and tolerates non-object input', () => {
    const out = migrateConversationMap({ good: 'c1', bad: 123, empty: {} }, now);
    expect(Object.keys(out)).toEqual(['good']);
    expect(migrateConversationMap(null, now)).toEqual({});
  });
});

describe('parseAllowlistRaw', () => {
  it('parses Slack channel ids', () => {
    expect(parseAllowlistRaw('C01ABCDEF, G01ABCDEF', 'channel')).toEqual([
      'C01ABCDEF',
      'G01ABCDEF',
    ]);
  });
  it('parses Slack DM channel ids', () => {
    expect(parseAllowlistRaw('D01ABCDEF', 'channel')).toEqual(['D01ABCDEF']);
  });
  it('parses Slack user ids (U and W prefixes)', () => {
    expect(parseAllowlistRaw('U01ABCDEF W098XYZAB', 'user')).toEqual(['U01ABCDEF', 'W098XYZAB']);
  });
  it('strips <#C123|name> mention wrappers', () => {
    expect(parseAllowlistRaw('<#C01ABCDEF|general>, <@U01ABCDEF>', 'channel')).toEqual([
      'C01ABCDEF',
    ]);
    expect(parseAllowlistRaw('<#C01ABCDEF|general>, <@U01ABCDEF>', 'user')).toEqual(['U01ABCDEF']);
  });
  it('keeps the literal wildcard', () => {
    expect(parseAllowlistRaw('*', 'channel')).toEqual(['*']);
    expect(parseAllowlistRaw('*', 'user')).toEqual(['*']);
  });
  it('dedupes', () => {
    expect(parseAllowlistRaw('U01ABCDEF, U01ABCDEF', 'user')).toEqual(['U01ABCDEF']);
  });
  it('rejects ids of the wrong kind', () => {
    expect(parseAllowlistRaw('U01ABCDEF', 'channel')).toEqual([]);
    expect(parseAllowlistRaw('C01ABCDEF', 'user')).toEqual([]);
  });
  it('rejects garbage', () => {
    expect(parseAllowlistRaw('hello world', 'channel')).toEqual([]);
    expect(parseAllowlistRaw('1234567890', 'user')).toEqual([]);
    expect(parseAllowlistRaw('Cabc', 'channel')).toEqual([]); // too short
  });
});

describe('parseSlashCommandText', () => {
  it('treats empty input as empty', () => {
    expect(parseSlashCommandText('')).toEqual({ verb: 'empty' });
    expect(parseSlashCommandText('   ')).toEqual({ verb: 'empty' });
  });
  it('recognises help', () => {
    expect(parseSlashCommandText('help')).toEqual({ verb: 'help' });
    expect(parseSlashCommandText('?')).toEqual({ verb: 'help' });
  });
  it('recognises experts', () => {
    expect(parseSlashCommandText('experts')).toEqual({ verb: 'experts' });
  });
  it('recognises status', () => {
    expect(parseSlashCommandText('status')).toEqual({ verb: 'status' });
  });
  it('parses expert list / set / clear', () => {
    expect(parseSlashCommandText('expert')).toEqual({ verb: 'expert', sub: 'list' });
    expect(parseSlashCommandText('expert list')).toEqual({ verb: 'expert', sub: 'list' });
    expect(parseSlashCommandText('expert clear')).toEqual({ verb: 'expert', sub: 'clear' });
    expect(parseSlashCommandText('expert sales-coach')).toEqual({
      verb: 'expert',
      sub: 'set',
      slug: 'sales-coach',
    });
    expect(parseSlashCommandText('expert set sales-coach')).toEqual({
      verb: 'expert',
      sub: 'set',
      slug: 'sales-coach',
    });
  });
  it('treats free text as an ask', () => {
    expect(parseSlashCommandText('what is our refund policy')).toEqual({
      verb: 'ask',
      text: 'what is our refund policy',
    });
  });
});

describe('chunkSlackText', () => {
  it('returns the text unchanged when short enough', () => {
    expect(chunkSlackText('hello', 100)).toEqual(['hello']);
  });
  it('chunks long text on whitespace boundaries', () => {
    const long = 'a'.repeat(3400) + ' ' + 'b'.repeat(3400);
    const chunks = chunkSlackText(long, 3500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3500);
    expect(chunks.join(' ').replace(/\s+/g, ' ').replace(/^ /, '')).toBe(
      long.replace(/\s+/g, ' ').replace(/^ /, ''),
    );
  });
  it('handles text without any whitespace', () => {
    const blob = 'x'.repeat(10000);
    const chunks = chunkSlackText(blob, 3500);
    expect(chunks.length).toBe(Math.ceil(10000 / 3500));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3500);
    expect(chunks.join('').length).toBe(10000);
  });
});

describe('extractTrailingFilePaths', () => {
  it('splits a single trailing @/path from the prose', () => {
    const { prose, paths } = extractTrailingFilePaths(
      'Aquí tienes el logo:\n\n@/home/agents-ia/Desktop/cerebro-logo.png',
    );
    expect(prose).toBe('Aquí tienes el logo:');
    expect(paths).toEqual(['/home/agents-ia/Desktop/cerebro-logo.png']);
  });

  it('returns multiple trailing paths in original order', () => {
    const { prose, paths } = extractTrailingFilePaths(
      'Here are both files:\n@/tmp/a.docx\n@/tmp/b.xlsx',
    );
    expect(prose).toBe('Here are both files:');
    expect(paths).toEqual(['/tmp/a.docx', '/tmp/b.xlsx']);
  });

  it('returns no paths for a plain prose reply', () => {
    const { prose, paths } = extractTrailingFilePaths('Just a normal answer.');
    expect(prose).toBe('Just a normal answer.');
    expect(paths).toEqual([]);
  });

  it('leaves a mid-message @/path untouched', () => {
    const text = 'See @/tmp/x.png in the middle.\nMore prose after it.';
    const { prose, paths } = extractTrailingFilePaths(text);
    expect(prose).toBe(text);
    expect(paths).toEqual([]);
  });

  it('tolerates trailing blank lines after the path', () => {
    const { prose, paths } = extractTrailingFilePaths('Logo:\n\n@/tmp/logo.png\n\n  \n');
    expect(prose).toBe('Logo:');
    expect(paths).toEqual(['/tmp/logo.png']);
  });

  it('handles a reply that is only the path', () => {
    const { prose, paths } = extractTrailingFilePaths('@/tmp/only.pdf');
    expect(prose).toBe('');
    expect(paths).toEqual(['/tmp/only.pdf']);
  });

  it('preserves spaces inside a path', () => {
    const { prose, paths } = extractTrailingFilePaths(
      'Listo:\n@/Users/jane/Desktop/Informe Final Q3.docx',
    );
    expect(prose).toBe('Listo:');
    expect(paths).toEqual(['/Users/jane/Desktop/Informe Final Q3.docx']);
  });

  it('tolerates CRLF line endings', () => {
    const { prose, paths } = extractTrailingFilePaths('Aquí está:\r\n\r\n@/tmp/a.pdf\r\n');
    expect(prose).toBe('Aquí está:');
    expect(paths).toEqual(['/tmp/a.pdf']);
  });

  it('does not treat a bare @mention or email as a path', () => {
    // Lines must start with `@/` — `@channel` / `user@host` never match.
    expect(extractTrailingFilePaths('ping @here when ready').paths).toEqual([]);
    expect(extractTrailingFilePaths('email me at a@b.com').paths).toEqual([]);
  });

  it('returns an empty result for empty input', () => {
    expect(extractTrailingFilePaths('')).toEqual({ prose: '', paths: [] });
  });
});

describe('EventDedupe', () => {
  it('returns true on first sight, false on duplicate', () => {
    const d = new EventDedupe();
    expect(d.observe('evt-1')).toBe(true);
    expect(d.observe('evt-1')).toBe(false);
    expect(d.observe('evt-2')).toBe(true);
  });
  it('caps total size', () => {
    const d = new EventDedupe(5);
    for (let i = 0; i < 10; i++) d.observe(`evt-${i}`);
    expect(d.size()).toBeLessThanOrEqual(5);
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows up to max calls in a window', () => {
    const lim = new SlidingWindowLimiter(3, 1000);
    expect(lim.allow('u1', 1000)).toBe(true);
    expect(lim.allow('u1', 1100)).toBe(true);
    expect(lim.allow('u1', 1200)).toBe(true);
    expect(lim.allow('u1', 1300)).toBe(false);
  });
  it('lets calls through once the window slides', () => {
    const lim = new SlidingWindowLimiter(2, 1000);
    expect(lim.allow('u1', 1000)).toBe(true);
    expect(lim.allow('u1', 1500)).toBe(true);
    expect(lim.allow('u1', 1600)).toBe(false);
    // After 1000ms passes for the first call, it should fall out of the window
    expect(lim.allow('u1', 2100)).toBe(true);
  });
});

describe('stripBotMention', () => {
  it('strips a bare bot mention', () => {
    expect(stripBotMention('<@U098ABC> hello', 'U098ABC')).toBe('hello');
  });
  it('strips a labelled bot mention', () => {
    expect(stripBotMention('<@U098ABC|cerebro> tell me a joke', 'U098ABC')).toBe('tell me a joke');
  });
  it('returns text unchanged when no botUserId', () => {
    expect(stripBotMention('<@U098ABC> hi', null)).toBe('<@U098ABC> hi');
  });
  it('leaves other mentions alone', () => {
    expect(stripBotMention('<@U098ABC> say hi to <@U999XYZ>', 'U098ABC')).toBe(
      'say hi to <@U999XYZ>',
    );
  });
});

describe('redactSlackPayload', () => {
  it('redacts text and blocks fields', () => {
    const out = redactSlackPayload({
      channel: 'C123',
      user: 'U456',
      text: 'top secret message',
      blocks: [{ type: 'section', text: 'sensitive' }],
    }) as Record<string, unknown>;
    expect(out.channel).toBe('C123');
    expect(out.user).toBe('U456');
    expect(out.text).toBe('<redacted>');
    expect(out.blocks).toBe('<redacted>');
  });
  it('scrubs token-looking values in nested strings', () => {
    const out = redactSlackPayload({
      auth_header: 'Bearer xoxb-1234567890abcdef-ghijklmnop',
      app: 'xapp-1-AAAAAAAAAA-1111111111111-bbbbbbbb',
    }) as Record<string, unknown>;
    expect(out.auth_header).not.toContain('xoxb-');
    expect(out.app).not.toContain('xapp-');
  });
  it('passes through null / non-objects safely', () => {
    expect(redactSlackPayload(null)).toBe(null);
    expect(redactSlackPayload(42)).toBe(42);
  });
});

describe('parseSlackTriggerRoutine', () => {
  function rec(dag: unknown, opts: Partial<BackendRoutineRecord> = {}): BackendRoutineRecord {
    return {
      id: 'rt-1',
      name: 'test routine',
      is_enabled: true,
      trigger_type: 'slack_message',
      dag_json: JSON.stringify(dag),
      ...opts,
    };
  }
  it('returns null when dag_json missing', () => {
    expect(parseSlackTriggerRoutine({ ...rec({}), dag_json: null })).toBe(null);
  });
  it('returns null when triggerType is not slack', () => {
    expect(
      parseSlackTriggerRoutine(
        rec({ trigger: { triggerType: 'trigger_telegram_message', config: { channel: 'C1' } } }),
      ),
    ).toBe(null);
  });
  it('parses a minimal slack trigger', () => {
    const parsed = parseSlackTriggerRoutine(
      rec({
        trigger: { triggerType: 'trigger_slack_message', config: { channel: 'C1' } },
        steps: [],
      }),
    );
    expect(parsed).not.toBe(null);
    expect(parsed!.trigger.channel).toBe('C1');
    expect(parsed!.trigger.surface).toBe('any');
    expect(parsed!.trigger.filter_type).toBe('none');
  });
  it('respects optional surface and user_id', () => {
    const parsed = parseSlackTriggerRoutine(
      rec({
        trigger: {
          triggerType: 'trigger_slack_message',
          config: {
            channel: '*',
            user_id: 'U123',
            surface: 'app_mention',
            filter_type: 'keyword',
            filter_value: 'urgent',
          },
        },
        steps: [],
      }),
    );
    expect(parsed!.trigger.user_id).toBe('U123');
    expect(parsed!.trigger.surface).toBe('app_mention');
    expect(parsed!.trigger.filter_type).toBe('keyword');
    expect(parsed!.trigger.filter_value).toBe('urgent');
  });
});

describe('matchesSlackFilter', () => {
  it('matches everything when type is none', () => {
    expect(matchesSlackFilter('hello world', 'none', '')).toBe(true);
    expect(matchesSlackFilter('', 'none', '')).toBe(true);
  });
  it('keyword filter is word-boundary sensitive', () => {
    expect(matchesSlackFilter('urgent: server down', 'keyword', 'urgent')).toBe(true);
    expect(matchesSlackFilter('the urgentest fire', 'keyword', 'urgent')).toBe(false);
  });
  it('prefix filter is case-insensitive', () => {
    expect(matchesSlackFilter('HELP me out', 'prefix', 'help')).toBe(true);
    expect(matchesSlackFilter('please help', 'prefix', 'help')).toBe(false);
  });
  it('regex filter handles complex patterns', () => {
    expect(matchesSlackFilter('order #12345 stuck', 'regex', 'order #\\d+')).toBe(true);
  });
  it('returns false for a bad regex (no crash)', () => {
    expect(matchesSlackFilter('anything', 'regex', '[unterminated')).toBe(false);
  });
});

describe('matchSlackRoutineTriggers', () => {
  const baseRoutine = {
    id: 'r1',
    name: 'r1',
    dag: { steps: [] },
    trigger: { channel: 'C1', filter_type: 'none' as const, filter_value: '' },
  };
  it('matches a channel-specific routine', () => {
    expect(
      matchSlackRoutineTriggers([baseRoutine], {
        channel: 'C1',
        userId: 'U1',
        surface: 'app_mention',
        text: 'hi',
      }).length,
    ).toBe(1);
  });
  it('rejects a routine for the wrong channel', () => {
    expect(
      matchSlackRoutineTriggers([baseRoutine], {
        channel: 'C2',
        userId: 'U1',
        surface: 'app_mention',
        text: 'hi',
      }).length,
    ).toBe(0);
  });
  it('wildcard channel matches anything', () => {
    expect(
      matchSlackRoutineTriggers(
        [{ ...baseRoutine, trigger: { ...baseRoutine.trigger, channel: '*' } }],
        {
          channel: 'C99',
          userId: 'U1',
          surface: 'message_im',
          text: 'hi',
        },
      ).length,
    ).toBe(1);
  });
  it('user_id constraint narrows the match', () => {
    const r = { ...baseRoutine, trigger: { ...baseRoutine.trigger, user_id: 'U42' } };
    expect(
      matchSlackRoutineTriggers([r], {
        channel: 'C1',
        userId: 'U42',
        surface: 'app_mention',
        text: 'hi',
      }).length,
    ).toBe(1);
    expect(
      matchSlackRoutineTriggers([r], {
        channel: 'C1',
        userId: 'U99',
        surface: 'app_mention',
        text: 'hi',
      }).length,
    ).toBe(0);
  });
  it('surface constraint narrows the match', () => {
    const r = {
      ...baseRoutine,
      trigger: { ...baseRoutine.trigger, surface: 'app_mention' as const },
    };
    expect(
      matchSlackRoutineTriggers([r], {
        channel: 'C1',
        userId: 'U1',
        surface: 'app_mention',
        text: 'hi',
      }).length,
    ).toBe(1);
    expect(
      matchSlackRoutineTriggers([r], {
        channel: 'C1',
        userId: 'U1',
        surface: 'message_im',
        text: 'hi',
      }).length,
    ).toBe(0);
  });
});

describe('pickAudioAttachment', () => {
  const file = (over: Partial<SlackFile>): SlackFile => ({ id: 'F0', ...over });

  it('detects a native Slack voice clip (audio/mp4 + slack_audio) and remaps the ext to m4a', () => {
    // The reported bug: native clips are AAC-in-MP4 (filetype/name "mp4"),
    // which MediaIngestService classifies as video → STT never ran. The ext
    // MUST come back m4a so the download routes to STT.
    const picked = pickAudioAttachment([
      file({
        id: 'F1',
        name: 'audio_message.mp4',
        mimetype: 'audio/mp4',
        filetype: 'mp4',
        subtype: 'slack_audio',
      }),
    ]);
    expect(picked?.file.id).toBe('F1');
    expect(picked?.ext).toBe('m4a');
  });

  it('detects a slack_audio clip even when MIME is missing/odd', () => {
    const picked = pickAudioAttachment([
      file({ id: 'F1b', filetype: 'mp4', subtype: 'slack_audio' }),
    ]);
    expect(picked?.file.id).toBe('F1b');
    expect(picked?.ext).toBe('m4a'); // mp4 isn't an audio ext → fall back to m4a
  });

  it('detects a webm voice note', () => {
    const picked = pickAudioAttachment([
      file({ id: 'F2', mimetype: 'audio/webm', filetype: 'webm', subtype: 'slack_audio' }),
    ]);
    expect(picked?.ext).toBe('webm');
  });

  it('detects a shared mp3 by MIME/extension', () => {
    const picked = pickAudioAttachment([
      file({ id: 'F3', name: 'clip.mp3', mimetype: 'audio/mpeg', filetype: 'mp3' }),
    ]);
    expect(picked?.ext).toBe('mp3');
  });

  it('ignores a real video mp4 (no audio MIME, no slack_audio)', () => {
    const picked = pickAudioAttachment([
      file({ id: 'F4', name: 'demo.mp4', mimetype: 'video/mp4', filetype: 'mp4' }),
    ]);
    expect(picked).toBeNull();
  });

  it('ignores images/docs and returns null for empty/undefined input', () => {
    expect(
      pickAudioAttachment([
        file({ id: 'F5', name: 'a.png', mimetype: 'image/png', filetype: 'png' }),
      ]),
    ).toBeNull();
    expect(pickAudioAttachment([])).toBeNull();
    expect(pickAudioAttachment(undefined)).toBeNull();
  });

  it('picks the first audio file when several are attached', () => {
    const picked = pickAudioAttachment([
      file({ id: 'IMG', mimetype: 'image/png', filetype: 'png' }),
      file({ id: 'AUD', mimetype: 'audio/mp4', filetype: 'mp4', subtype: 'slack_audio' }),
    ]);
    expect(picked?.file.id).toBe('AUD');
  });
});

describe('pickNonAudioFiles', () => {
  const file = (over: Partial<SlackFile>): SlackFile => ({ id: 'F0', ...over });

  it('returns images, PDFs and docs', () => {
    const files = [
      file({ id: 'IMG', name: 'a.png', mimetype: 'image/png', filetype: 'png' }),
      file({ id: 'PDF', name: 'b.pdf', mimetype: 'application/pdf', filetype: 'pdf' }),
      file({ id: 'DOC', name: 'c.docx', filetype: 'docx' }),
    ];
    expect(pickNonAudioFiles(files).map((f) => f.id)).toEqual(['IMG', 'PDF', 'DOC']);
  });

  it('excludes audio notes (slack_audio, audio MIME, audio ext)', () => {
    const files = [
      file({ id: 'AUD', mimetype: 'audio/mp4', filetype: 'mp4', subtype: 'slack_audio' }),
      file({ id: 'MP3', name: 'clip.mp3', mimetype: 'audio/mpeg', filetype: 'mp3' }),
      file({ id: 'IMG', name: 'a.png', mimetype: 'image/png', filetype: 'png' }),
    ];
    expect(pickNonAudioFiles(files).map((f) => f.id)).toEqual(['IMG']);
  });

  it('keeps a real video mp4 (not audio)', () => {
    const files = [file({ id: 'VID', name: 'demo.mp4', mimetype: 'video/mp4', filetype: 'mp4' })];
    expect(pickNonAudioFiles(files).map((f) => f.id)).toEqual(['VID']);
  });

  it('returns [] for empty/undefined input', () => {
    expect(pickNonAudioFiles([])).toEqual([]);
    expect(pickNonAudioFiles(undefined)).toEqual([]);
  });
});
