import { describe, it, expect } from 'vitest';
import {
  resolveMentions,
  extractMentionIds,
  stripMentionSyntax,
  normalizeToTokens,
  formatMentionToken,
} from '../mentions';
import type { Expert } from '../../context/ExpertContext';

// mentions.ts only reads `id` and `name`; the rest of Expert is irrelevant here.
const makeExpert = (id: string, name: string): Expert => ({ id, name } as Expert);

describe('formatMentionToken', () => {
  it('produces the canonical @[Name](expert:id) form', () => {
    expect(formatMentionToken('abc123', 'Ada Lovelace')).toBe('@[Ada Lovelace](expert:abc123)');
  });
});

describe('resolveMentions — formal tokens', () => {
  it('matches @[Name](expert:id) tokens with correct indices', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const body = 'Hi @[Ada](expert:id-ada) please help.';
    const result = resolveMentions(body, [ada]);
    expect(result).toHaveLength(1);
    expect(result[0].expertId).toBe('id-ada');
    expect(result[0].name).toBe('Ada');
    expect(body.slice(result[0].startIndex, result[0].endIndex)).toBe('@[Ada](expert:id-ada)');
  });

  it('returns empty array for empty body', () => {
    expect(resolveMentions('', [])).toEqual([]);
  });
});

describe('resolveMentions — loose @Name matching', () => {
  it('matches @Name with word boundary before the @', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const body = 'Hey @Ada look at this.';
    const result = resolveMentions(body, [ada]);
    expect(result).toHaveLength(1);
    expect(result[0].expertId).toBe('id-ada');
  });

  it('does not match @Name without word boundary (e.g. inside email-like text)', () => {
    const foo = makeExpert('id-foo', 'foo');
    const body = 'email@foo.example';
    expect(resolveMentions(body, [foo])).toHaveLength(0);
  });

  it('matches @Name at the very start of the string', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const result = resolveMentions('@Ada hi', [ada]);
    expect(result).toHaveLength(1);
    expect(result[0].expertId).toBe('id-ada');
  });

  it('longest prefix wins when two experts share a prefix', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const adaLovelace = makeExpert('id-lovelace', 'Ada Lovelace');
    const body = 'ping @Ada Lovelace now';
    const result = resolveMentions(body, [ada, adaLovelace]);
    expect(result).toHaveLength(1);
    expect(result[0].expertId).toBe('id-lovelace');
  });

  it('does not match when the match is immediately followed by an alphanumeric char', () => {
    const ada = makeExpert('id-ada', 'Ada');
    // "@Adam" should not resolve to "Ada" because 'm' is alphanumeric.
    const result = resolveMentions('hi @Adam', [ada]);
    expect(result).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const result = resolveMentions('ping @ADA', [ada]);
    expect(result).toHaveLength(1);
    expect(result[0].expertId).toBe('id-ada');
  });
});

describe('resolveMentions — order and coverage', () => {
  it('returns mentions sorted by start index', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const bob = makeExpert('id-bob', 'Bob');
    const body = 'First @Bob then @[Ada](expert:id-ada) finally.';
    const result = resolveMentions(body, [ada, bob]);
    expect(result.map(m => m.expertId)).toEqual(['id-bob', 'id-ada']);
  });

  it('does not double-match text already covered by a formal token', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const body = '@[Ada](expert:id-ada)';
    const result = resolveMentions(body, [ada]);
    expect(result).toHaveLength(1);
  });
});

describe('extractMentionIds', () => {
  it('returns unique expert ids in document order', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const bob = makeExpert('id-bob', 'Bob');
    const body = '@Bob and @Ada and @Bob again';
    expect(extractMentionIds(body, [ada, bob])).toEqual(['id-bob', 'id-ada']);
  });

  it('returns empty for text with no mentions', () => {
    const ada = makeExpert('id-ada', 'Ada');
    expect(extractMentionIds('plain text', [ada])).toEqual([]);
  });
});

describe('stripMentionSyntax', () => {
  it('converts formal tokens to @Name display form', () => {
    const ada = makeExpert('id-ada', 'Ada');
    expect(stripMentionSyntax('Hi @[Ada](expert:id-ada)!', [ada])).toBe('Hi @Ada!');
  });

  it('leaves loose @Name unchanged after normalization', () => {
    const ada = makeExpert('id-ada', 'Ada');
    expect(stripMentionSyntax('Hi @Ada', [ada])).toBe('Hi @Ada');
  });

  it('returns input unchanged when there are no mentions', () => {
    expect(stripMentionSyntax('plain', [])).toBe('plain');
  });
});

describe('normalizeToTokens', () => {
  it('converts loose @Name to formal @[Name](expert:id)', () => {
    const ada = makeExpert('id-ada', 'Ada');
    expect(normalizeToTokens('Hi @Ada', [ada])).toBe('Hi @[Ada](expert:id-ada)');
  });

  it('leaves formal tokens untouched', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const body = 'Hi @[Ada](expert:id-ada)';
    expect(normalizeToTokens(body, [ada])).toBe(body);
  });

  it('round-trips: stripMentionSyntax → normalizeToTokens returns original tokenized form', () => {
    const ada = makeExpert('id-ada', 'Ada');
    const original = 'Hi @[Ada](expert:id-ada) there';
    const stripped = stripMentionSyntax(original, [ada]);
    expect(normalizeToTokens(stripped, [ada])).toBe(original);
  });
});
