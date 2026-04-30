/**
 * Regression coverage for the `.docx` preview flash:
 *
 * `previewKindFor('docx')` returns 'binary' (the dispatcher predates the
 * office-parse path). On first render the hook used to expose
 * `loading=false, effectiveKind='binary'`, which made the chat preview
 * modal flash the "No preview available for .DOCX" body before the
 * useEffect kicked off the backend parse. The fix initialises `loading`
 * to true whenever an attachment is provided.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../lib/files-parse-client', () => ({
  parseFileViaBackend: vi.fn(),
  ParseError: class ParseError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const shellMock = {
  statPath: vi.fn(),
  readTextFile: vi.fn(),
  previewUrlForPath: vi.fn(),
};

beforeEach(() => {
  // window.cerebro.shell — the renderer's IPC bridge. Reset between tests.
  Object.assign(globalThis, {
    window: Object.assign(globalThis.window ?? {}, {
      cerebro: { shell: shellMock },
    }),
  });
  shellMock.statPath.mockReset();
  shellMock.readTextFile.mockReset();
  shellMock.previewUrlForPath.mockReset();
});

import { useChatFilePreview } from './useChatFilePreview';
import { parseFileViaBackend } from '../../lib/files-parse-client';

const dummyDocx = {
  id: '/tmp/file.docx',
  filePath: '/tmp/file.docx',
  fileName: 'file.docx',
  extension: 'docx',
  fileSize: 2048,
  isDirectory: false,
};

describe('useChatFilePreview — docx flash regression', () => {
  it('starts in loading=true so the modal does not flash the binary body', () => {
    shellMock.statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 2048 });
    (parseFileViaBackend as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => undefined), // never resolves — freeze in parsing state
    );

    const { result } = renderHook(() => useChatFilePreview(dummyDocx));
    expect(result.current.loading).toBe(true);
    // effectiveKind starts as 'binary' (the dispatcher's verdict for docx),
    // but the modal's gate keys off `loading`, so it shows the spinner instead.
    expect(result.current.effectiveKind).toBe('binary');
  });

  it('flips effectiveKind to markdown once parse succeeds', async () => {
    shellMock.statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 2048 });
    (parseFileViaBackend as ReturnType<typeof vi.fn>).mockResolvedValue({
      sha256: 'deadbeef',
      parsedPath: '/tmp/parsed/deadbeef.md',
      charCount: 5,
      parser: 'python-docx',
      parserVersion: '1.2.0',
      truncated: false,
      warning: null,
      cached: false,
    });
    shellMock.readTextFile.mockResolvedValue('# hello');

    const { result } = renderHook(() => useChatFilePreview(dummyDocx));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.effectiveKind).toBe('markdown');
    expect(result.current.textContent).toBe('# hello');
    expect(result.current.parsedMarkdown).toBe('# hello');
  });

  it('lands on parse-failed (red error) when the backend rejects the file', async () => {
    shellMock.statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 2048 });
    (parseFileViaBackend as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useChatFilePreview(dummyDocx));
    await waitFor(() => expect(result.current.loadError).toBe('parse-failed'));
    // effectiveKind goes to 'binary' on parse-failed so the body shows the
    // localized red error string from the modal — not the office markdown.
    expect(result.current.effectiveKind).toBe('binary');
  });

  it('passes a null attachment through without sticking in loading=true', () => {
    const { result } = renderHook(() => useChatFilePreview(null));
    expect(result.current.loading).toBe(false);
    // Sanity: with no attachment, no parsing and no error.
    expect(result.current.parsing).toBe(false);
    expect(result.current.loadError).toBeNull();
  });
});

// Silence "act" warnings without doing anything else with this; the hook's
// useEffect schedules state updates we already await via waitFor.
void act;
