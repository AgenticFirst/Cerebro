/**
 * markdownToMrkdwn — verify each transform rule and combinations. The
 * converter is the only thing between assistant output (CommonMark) and
 * Slack's mrkdwn renderer, so misses here surface as visible junk in the
 * Slack client.
 */
import { describe, expect, it } from 'vitest';
import { markdownToMrkdwn } from '../mrkdwn';

describe('markdownToMrkdwn', () => {
  it('returns empty/null-ish inputs unchanged', () => {
    expect(markdownToMrkdwn('')).toBe('');
  });

  it('plain text passes through', () => {
    expect(markdownToMrkdwn('Just a sentence.')).toBe('Just a sentence.');
  });

  it('converts ** double-asterisk bold to * single-asterisk', () => {
    expect(markdownToMrkdwn('hello **world**')).toBe('hello *world*');
  });

  it('converts __ double-underscore bold to * single-asterisk', () => {
    expect(markdownToMrkdwn('hello __world__')).toBe('hello *world*');
  });

  it('converts * single-asterisk italic to _ underscore', () => {
    expect(markdownToMrkdwn('a *quick* fox')).toBe('a _quick_ fox');
  });

  it('leaves underscore italic untouched', () => {
    expect(markdownToMrkdwn('a _quick_ fox')).toBe('a _quick_ fox');
  });

  it('does not treat lone asterisks as italic (arithmetic survives)', () => {
    expect(markdownToMrkdwn('result = 2 * 3 * 5')).toBe('result = 2 * 3 * 5');
  });

  it('converts ~~ strikethrough to ~ single-tilde', () => {
    expect(markdownToMrkdwn('~~gone~~')).toBe('~gone~');
  });

  it('converts ATX headers to bold', () => {
    expect(markdownToMrkdwn('## ⚡ Acciones directas'))
      .toBe('*⚡ Acciones directas*');
    expect(markdownToMrkdwn('# H1\n## H2\n### H3'))
      .toBe('*H1*\n*H2*\n*H3*');
  });

  it('converts [text](url) links to <url|text>', () => {
    expect(markdownToMrkdwn('see [docs](https://example.com/x) please'))
      .toBe('see <https://example.com/x|docs> please');
  });

  it('converts image syntax to angle-bracket links', () => {
    expect(markdownToMrkdwn('![alt](https://img.test/p.png)'))
      .toBe('<https://img.test/p.png|alt>');
    expect(markdownToMrkdwn('![](https://img.test/p.png)'))
      .toBe('<https://img.test/p.png|https://img.test/p.png>');
  });

  it('converts -, *, + bullet list markers to •', () => {
    expect(markdownToMrkdwn('- one\n- two')).toBe('• one\n• two');
    expect(markdownToMrkdwn('* one\n* two')).toBe('• one\n• two');
    expect(markdownToMrkdwn('+ one\n+ two')).toBe('• one\n• two');
  });

  it('preserves leading indent on bullet lists', () => {
    expect(markdownToMrkdwn('  - nested')).toBe('  • nested');
  });

  it('protects fenced code blocks from inner transforms', () => {
    const md = 'before\n```\n**not bold** and [no link](x)\n```\nafter';
    expect(markdownToMrkdwn(md))
      .toBe('before\n```\n**not bold** and [no link](x)\n```\nafter');
  });

  it('protects inline code from inner transforms', () => {
    expect(markdownToMrkdwn('use `**raw**` here'))
      .toBe('use `**raw**` here');
  });

  it('converts GFM tables into fenced code blocks', () => {
    const md = [
      'Header line.',
      '',
      '| Expert | Skill |',
      '| --- | --- |',
      '| Carlos | Sales |',
      '| Ginne | PM |',
      '',
      'Trailing line.',
    ].join('\n');
    const out = markdownToMrkdwn(md);
    expect(out).toContain('```');
    expect(out).toContain('| Expert | Skill |');
    expect(out).toContain('| Carlos | Sales |');
    expect(out).toContain('Trailing line.');
    expect(out).not.toMatch(/\|\s*---\s*\|/); // separator dropped
  });

  it('converts horizontal rules to blank lines', () => {
    expect(markdownToMrkdwn('one\n---\ntwo')).toBe('one\n\ntwo');
  });

  it('combines header + bold + link + bullet in one block', () => {
    const md = [
      '## Resumen',
      '',
      '**Total**: 3 ítems.',
      '',
      '- Ver [reporte](https://r.test/1)',
      '- Cerrar el ciclo',
    ].join('\n');
    const out = markdownToMrkdwn(md);
    expect(out).toBe([
      '*Resumen*',
      '',
      '*Total*: 3 ítems.',
      '',
      '• Ver <https://r.test/1|reporte>',
      '• Cerrar el ciclo',
    ].join('\n'));
  });

  it('preserves Spanish accents and ñ', () => {
    expect(markdownToMrkdwn('**Año** con `ñ` y _más_ acentuación: áéíóú'))
      .toBe('*Año* con `ñ` y _más_ acentuación: áéíóú');
  });

  it('does not turn list-leading * into italic afterwards', () => {
    expect(markdownToMrkdwn('* item one\n* item two'))
      .toBe('• item one\n• item two');
  });

  it('handles nested bold inside link text', () => {
    // Slack doesn't honor mrkdwn inside link labels — the asterisks end up
    // as literal text. Verify the converter still produces parseable output.
    const out = markdownToMrkdwn('[**Click me**](https://x.test)');
    expect(out).toBe('<https://x.test|*Click me*>');
  });
});
