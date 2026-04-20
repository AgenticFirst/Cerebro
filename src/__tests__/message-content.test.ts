import { describe, it, expect } from 'vitest';
import {
  parseFileRefs,
  parseTrailingFileRefs,
  stripModelTags,
  getCopyableContent,
} from '../lib/message-content';

describe('parseFileRefs', () => {
  it('strips leading @/ and @~ lines and returns them as attachments', () => {
    const input = '@/src/foo.ts\n@~/notes.md\nPlease review this';
    const { attachments, text } = parseFileRefs(input);
    expect(attachments.map((a) => a.filePath)).toEqual(['/src/foo.ts', '~/notes.md']);
    expect(text).toBe('Please review this');
  });

  it('leaves content alone when no attachment refs are present', () => {
    const { attachments, text } = parseFileRefs('Just a normal prompt');
    expect(attachments).toEqual([]);
    expect(text).toBe('Just a normal prompt');
  });

  it('keeps @-mentions that are not file paths in the text body', () => {
    const { attachments, text } = parseFileRefs('@someone check this out');
    expect(attachments).toEqual([]);
    expect(text).toBe('@someone check this out');
  });
});

describe('parseTrailingFileRefs', () => {
  it('strips trailing @/ lines and returns them as attachments', () => {
    const input = 'Here is the analysis.\n\n@/out/report.md\n@/out/chart.png';
    const { attachments, text } = parseTrailingFileRefs(input);
    expect(attachments.map((a) => a.filePath)).toEqual(['/out/report.md', '/out/chart.png']);
    expect(text).toBe('Here is the analysis.');
  });

  it('is a no-op when there are no trailing refs', () => {
    const { attachments, text } = parseTrailingFileRefs('All done.');
    expect(attachments).toEqual([]);
    expect(text).toBe('All done.');
  });
});

describe('stripModelTags', () => {
  it('removes <think>...</think> reasoning blocks', () => {
    const input = '<think>hidden reasoning</think>Visible answer.';
    expect(stripModelTags(input)).toBe('Visible answer.');
  });

  it('removes orphaned </think> fragments from mid-stream chunks', () => {
    const input = 'leaked reasoning</think>Real answer.';
    expect(stripModelTags(input)).toBe('Real answer.');
  });

  it('removes <tool_call>...</tool_call> blocks', () => {
    const input = '<tool_call>{"name":"x"}</tool_call>Plain text';
    expect(stripModelTags(input)).toBe('Plain text');
  });

  it('leaves normal markdown untouched', () => {
    const input = '# Heading\n\n- item 1\n- item 2\n\n`code`';
    expect(stripModelTags(input)).toBe(input);
  });
});

describe('getCopyableContent', () => {
  it('returns the prompt text for user messages without attachment lines', () => {
    const result = getCopyableContent({
      role: 'user',
      content: '@/src/foo.ts\n\nExplain this function',
    });
    expect(result).toBe('Explain this function');
  });

  it('returns clean markdown for assistant messages, stripping tags and trailing refs', () => {
    const content = [
      '<think>reasoning</think># Plan',
      '',
      '1. Do A',
      '2. Do B',
      '',
      '@/out/plan.md',
    ].join('\n');
    const result = getCopyableContent({ role: 'assistant', content });
    expect(result).toBe('# Plan\n\n1. Do A\n2. Do B');
  });

  it('returns an empty string when the message is attachment-only', () => {
    const result = getCopyableContent({
      role: 'user',
      content: '@/src/foo.ts\n@/src/bar.ts',
    });
    expect(result).toBe('');
  });

  it('does not mutate the input message', () => {
    const content = '<think>x</think>Hello\n@/a.txt';
    const frozen = Object.freeze({ role: 'assistant' as const, content });
    expect(() => getCopyableContent(frozen)).not.toThrow();
    expect(frozen.content).toBe(content);
  });

  it('preserves code fences, tables, and list nesting in assistant output', () => {
    const content = [
      '# Report',
      '',
      '| Col | Val |',
      '| --- | --- |',
      '| a   | 1   |',
      '',
      '- top',
      '  - nested',
      '',
      '```ts',
      "const x = 'y';",
      '```',
    ].join('\n');
    const result = getCopyableContent({ role: 'assistant', content });
    expect(result).toBe(content);
  });
});
