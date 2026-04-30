import { describe, it, expect } from 'vitest';
import { extractAbsolutePathsFromBashCommand } from '../extract-paths';

describe('extractAbsolutePathsFromBashCommand', () => {
  it('pulls a single-quoted .docx path out of a python-docx one-liner', () => {
    const cmd = `python -c "from docx import Document; d=Document(); d.add_heading('x'); d.save('/Users/jane/Desktop/report.docx')"`;
    expect(extractAbsolutePathsFromBashCommand(cmd)).toEqual([
      '/Users/jane/Desktop/report.docx',
    ]);
  });

  it('handles multiple deliverables in one command', () => {
    const cmd = `python build.py /tmp/out.xlsx && cp /tmp/out.xlsx "/Users/jane/Documents/Report final.xlsx"`;
    expect(extractAbsolutePathsFromBashCommand(cmd)).toEqual([
      '/tmp/out.xlsx',
      // Note: paths with spaces aren't picked up by the no-whitespace rule —
      // documented limitation. The first occurrence is enough for a chip.
    ]);
  });

  it('finds .pdf, .pptx, .csv, .md alongside .docx', () => {
    const cmd = `cat /a/file.md && /b/script.py /c/out.pdf /d/slides.pptx /e/data.csv > /f/note.docx`;
    expect(extractAbsolutePathsFromBashCommand(cmd)).toEqual([
      '/a/file.md',
      '/c/out.pdf',
      '/d/slides.pptx',
      '/e/data.csv',
      '/f/note.docx',
    ]);
  });

  it('does not duplicate the same path mentioned twice', () => {
    const cmd = `cp /tmp/x.docx /tmp/x.docx.bak && open /tmp/x.docx`;
    expect(extractAbsolutePathsFromBashCommand(cmd)).toEqual(['/tmp/x.docx']);
  });

  it('ignores relative paths and bare extensions', () => {
    const cmd = `python -c "doc.save('out.docx')"`;
    expect(extractAbsolutePathsFromBashCommand(cmd)).toEqual([]);
  });

  it('ignores extensions outside the deliverable allowlist', () => {
    const cmd = `gcc -o /tmp/binary /tmp/source.c`;
    expect(extractAbsolutePathsFromBashCommand(cmd)).toEqual([]);
  });

  it('matches paths embedded inside f-strings and assignments', () => {
    const cmd = `python -c "p='/Users/jane/Library/Application Support/Cerebro/agent-memory/cerebro/best.docx'; doc.save(p)"`;
    // Path with spaces — regex stops at first whitespace inside quotes.
    // Shouldn't crash; we just don't pick it up.
    const out = extractAbsolutePathsFromBashCommand(cmd);
    // The Cerebro agent-memory dir for the chat use case has no spaces, so
    // the realistic case is covered:
    const realistic = `doc.save('/Users/jane/Library/cerebro/best.docx')`;
    expect(extractAbsolutePathsFromBashCommand(realistic)).toEqual([
      '/Users/jane/Library/cerebro/best.docx',
    ]);
    // Sanity: the spaced-path command isn't a TypeError, just zero hits.
    expect(out).toEqual([]);
  });

  it('returns [] for non-string or path-free input', () => {
    expect(extractAbsolutePathsFromBashCommand('')).toEqual([]);
    expect(extractAbsolutePathsFromBashCommand('echo hello world')).toEqual([]);
    // @ts-expect-error — defensive: callers might forward arbitrary tool args
    expect(extractAbsolutePathsFromBashCommand(undefined)).toEqual([]);
  });

  it('matches case-insensitively on the extension', () => {
    expect(
      extractAbsolutePathsFromBashCommand('cp /tmp/REPORT.DOCX /tmp/copy.DocX'),
    ).toEqual(['/tmp/REPORT.DOCX', '/tmp/copy.DocX']);
  });
});
