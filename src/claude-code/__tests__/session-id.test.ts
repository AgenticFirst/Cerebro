/**
 * Pins the conversation-id → Claude Code session UUID mapping. This is
 * load-bearing: every chat turn derives the `--session-id` / `--resume`
 * argument from the conversation id via toUuidFormat, so the same chat
 * must produce the same UUID across runs. If this regresses, resume
 * silently lands in a different session file and the assistant "forgets"
 * prior turns — exactly the bug this whole change is fixing.
 */

import { describe, it, expect } from 'vitest';
import { toUuidFormat } from '../session-id';

describe('toUuidFormat', () => {
  it('formats a 32-char hex conversation id as a dashed UUID', () => {
    expect(toUuidFormat('0123456789abcdef0123456789abcdef')).toBe(
      '01234567-89ab-cdef-0123-456789abcdef',
    );
  });

  it('is deterministic — same input, same output', () => {
    const id = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    expect(toUuidFormat(id)).toBe(toUuidFormat(id));
  });

  it('leaves an already-dashed UUID untouched', () => {
    const dashed = '01234567-89ab-cdef-0123-456789abcdef';
    expect(toUuidFormat(dashed)).toBe(dashed);
  });

  it('returns input unchanged when it is neither 32-hex nor dashed UUID', () => {
    expect(toUuidFormat('not-a-uuid')).toBe('not-a-uuid');
    expect(toUuidFormat('')).toBe('');
  });

  it('is case-insensitive on hex input', () => {
    expect(toUuidFormat('ABCDEF0123456789ABCDEF0123456789')).toBe(
      'ABCDEF01-2345-6789-ABCD-EF0123456789',
    );
  });
});
