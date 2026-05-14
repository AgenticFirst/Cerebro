import { describe, it, expect } from 'vitest';
import { isReplIdleTail } from './completion-detection';

describe('isReplIdleTail', () => {
  it('returns true when tail ends in the box-drawn REPL prompt', () => {
    const text = 'a'.repeat(600) + '\n│ > ';
    expect(isReplIdleTail(text)).toBe(true);
  });

  it('returns true when tail ends in a bare `> ` prompt', () => {
    const text = 'a'.repeat(600) + '\n> ';
    expect(isReplIdleTail(text)).toBe(true);
  });

  it('returns true when tail ends in `>` with no trailing whitespace', () => {
    const text = 'a'.repeat(600) + '\n>';
    expect(isReplIdleTail(text)).toBe(true);
  });

  it('returns false when a braille spinner glyph is present in the tail', () => {
    const text = 'a'.repeat(600) + '\nrunning search ⠋\n> ';
    expect(isReplIdleTail(text)).toBe(false);
  });

  it('returns false when a play-arrow spinner glyph is present in the tail', () => {
    const text = 'a'.repeat(600) + '\n⏵ thinking...\n> ';
    expect(isReplIdleTail(text)).toBe(false);
  });

  it('returns false when the tail has no prompt at all', () => {
    const text = 'a'.repeat(600) + '\nsome trailing prose with no marker';
    expect(isReplIdleTail(text)).toBe(false);
  });

  it('returns false when `>` appears inline (mid-line, not as a prompt)', () => {
    const text = 'a'.repeat(600) + '\nthis line has an inline > arrow and more text';
    expect(isReplIdleTail(text)).toBe(false);
  });

  it('does NOT fire for a markdown blockquote line ending with non-prompt content', () => {
    // A blockquote like "> some text" should not match because the `>` is
    // followed by content, not whitespace-then-end.
    const text = 'a'.repeat(600) + '\n> some text in a quote';
    expect(isReplIdleTail(text)).toBe(false);
  });

  it('returns true for a multi-line tail where only the last line is the prompt', () => {
    const text = [
      'a'.repeat(400),
      'lots of prose',
      'more prose',
      'final paragraph wrapping up the deliverable.',
      '│ > ',
    ].join('\n');
    expect(isReplIdleTail(text)).toBe(true);
  });

  it('only inspects the tail window, so an early spinner does not block', () => {
    const earlyNoise = '⠋ '.repeat(50); // spinner appears early
    const longClean = 'x'.repeat(400); // pushes the spinner out of the 256-char tail
    const text = earlyNoise + longClean + '\n│ > ';
    expect(isReplIdleTail(text)).toBe(true);
  });

  it('respects a custom tail length', () => {
    const text = '⠋ '.repeat(5) + 'x'.repeat(100) + '\n│ > ';
    // 10 chars of spinner + 100 x's + 4-char prompt = 114 chars.
    // With a 60-char window, the spinner is out of view → idle.
    expect(isReplIdleTail(text, 60)).toBe(true);
    // With a 200-char window, the spinner is visible → busy.
    expect(isReplIdleTail(text, 200)).toBe(false);
  });
});
