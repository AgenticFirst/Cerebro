import { useCallback, useEffect, useState } from 'react';
import type { AttachmentInfo } from '../../types/attachments';
import { previewKindFor } from '../screens/files/utils';
import type { PreviewKind } from '../files-preview/FilePreviewBody';
import { parseFileViaBackend, ParseError } from '../../lib/files-parse-client';

const OFFICE_PARSE_EXTS = new Set(['docx', 'xlsx', 'pptx']);

export type LoadErrorKind =
  | 'missing'
  | 'outside-safe-roots'
  | 'too-large'
  | 'parse-failed'
  | 'unknown';

export interface ChatFilePreviewState {
  kind: PreviewKind;
  effectiveKind: PreviewKind;
  previewUrl: string | null;
  textContent: string | null;
  parsedMarkdown: string | null;
  parsing: boolean;
  loading: boolean;
  loadError: LoadErrorKind | null;
  loadErrorDetail: string | null;
  view: 'native' | 'extracted';
  setView: (view: 'native' | 'extracted') => void;
  /** True when the file kind has a separate "extracted text" view (PDFs).
   *  Office formats render extracted text as the only view, so they don't
   *  show a toggle. */
  hasExtractedTextToggle: boolean;
}

/**
 * Loads everything the chat preview modal needs for a single attachment:
 * - file existence stat
 * - safe-root preview URL for binary types (image/video/audio/html/pdf)
 * - text content for text/markdown types
 * - parsed-markdown via /files/parse for office types
 *
 * The hook is keyed on `attachment.id` (typically the absolute path), so
 * swapping attachments cleanly resets everything.
 */
export function useChatFilePreview(attachment: AttachmentInfo | null): ChatFilePreviewState {
  const ext = (attachment?.extension ?? '').toLowerCase();
  const kind = previewKindFor(ext);
  const isOfficeParse = OFFICE_PARSE_EXTS.has(ext);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [parsedMarkdown, setParsedMarkdown] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  // Start in the loading state so the modal's first render shows a spinner
  // instead of falling through to FilePreviewBody with kind='binary' (which
  // briefly flashes the "No preview available for .DOCX" body before the
  // useEffect below has a chance to kick off the parse). Office files
  // especially: previewKindFor returns 'binary' for them — the markdown-
  // mapped effectiveKind only flips after parseFileViaBackend resolves.
  const [loading, setLoading] = useState(attachment !== null);
  const [loadError, setLoadError] = useState<LoadErrorKind | null>(null);
  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null);
  const [view, setViewState] = useState<'native' | 'extracted'>('native');

  const setView = useCallback(
    (next: 'native' | 'extracted') => {
      setViewState(next);
      // Lazy-trigger parse the first time a PDF user asks for extracted text.
      if (
        next === 'extracted' &&
        attachment &&
        kind === 'pdf' &&
        parsedMarkdown === null &&
        !parsing
      ) {
        setParsing(true);
        let cancelled = false;
        (async () => {
          try {
            const parsed = await parseFileViaBackend(attachment.filePath);
            if (cancelled) return;
            const md = await window.cerebro.shell.readTextFile(parsed.parsedPath);
            if (cancelled) return;
            setParsedMarkdown(md);
          } catch (err) {
            if (cancelled) return;
            const msg = err instanceof ParseError ? err.message : String((err as Error)?.message ?? err);
            setLoadError('parse-failed');
            setLoadErrorDetail(msg);
            setViewState('native'); // fall back to iframe
          } finally {
            if (!cancelled) setParsing(false);
          }
        })();
        return () => {
          cancelled = true;
        };
      }
    },
    [attachment, kind, parsedMarkdown, parsing],
  );

  useEffect(() => {
    if (!attachment) return;
    let cancelled = false;
    setPreviewUrl(null);
    setTextContent(null);
    setParsedMarkdown(null);
    setParsing(false);
    setLoadError(null);
    setLoadErrorDetail(null);
    setViewState('native');
    setLoading(true);

    async function load() {
      try {
        const stat = await window.cerebro.shell.statPath(attachment!.filePath);
        if (cancelled) return;
        if (!stat.exists) {
          setLoadError('missing');
          setLoading(false);
          return;
        }

        // Office formats — parse to markdown via backend.
        if (isOfficeParse) {
          setParsing(true);
          try {
            const parsed = await parseFileViaBackend(attachment!.filePath);
            if (cancelled) return;
            const md = await window.cerebro.shell.readTextFile(parsed.parsedPath);
            if (cancelled) return;
            setParsedMarkdown(md);
            setParsing(false);
            setLoading(false);
          } catch (err) {
            if (cancelled) return;
            setParsing(false);
            const msg = err instanceof ParseError ? err.message : String((err as Error)?.message ?? err);
            setLoadError('parse-failed');
            setLoadErrorDetail(msg);
            setLoading(false);
          }
          return;
        }

        if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'html' || kind === 'pdf') {
          try {
            const url = await window.cerebro.shell.previewUrlForPath(attachment!.filePath);
            if (cancelled) return;
            setPreviewUrl(url);
          } catch (err) {
            if (cancelled) return;
            const message = String((err as Error)?.message ?? err);
            if (message.includes('outside-safe-roots')) {
              setLoadError('outside-safe-roots');
            } else {
              setLoadError('unknown');
              setLoadErrorDetail(message);
            }
          }
          setLoading(false);
          return;
        }

        if (kind === 'text' || kind === 'markdown') {
          try {
            const content = await window.cerebro.shell.readTextFile(attachment!.filePath);
            if (cancelled) return;
            setTextContent(content);
          } catch (err) {
            if (cancelled) return;
            const message = String((err as Error)?.message ?? err);
            if (message.includes('too large')) {
              setLoadError('too-large');
            } else {
              setLoadError('unknown');
              setLoadErrorDetail(message);
            }
          }
          setLoading(false);
          return;
        }

        // 'binary' or unknown — nothing to load; the body shows the binary CTA.
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError('unknown');
        setLoadErrorDetail(String((err as Error)?.message ?? err));
        setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [attachment?.id, attachment?.filePath, kind, isOfficeParse, attachment]);

  // For office files that successfully parsed, render the modal as markdown.
  // For PDFs the user toggles between native iframe and extracted text.
  let effectiveKind: PreviewKind = kind;
  if (isOfficeParse && parsedMarkdown !== null) {
    effectiveKind = 'markdown';
  } else if (loadError === 'parse-failed') {
    effectiveKind = 'binary';
  } else if (kind === 'pdf' && view === 'extracted' && parsedMarkdown !== null) {
    effectiveKind = 'markdown';
  }

  return {
    kind,
    effectiveKind,
    previewUrl,
    textContent: effectiveKind === 'markdown' && parsedMarkdown !== null ? parsedMarkdown : textContent,
    parsedMarkdown,
    parsing,
    loading,
    loadError,
    loadErrorDetail,
    view,
    setView,
    hasExtractedTextToggle: kind === 'pdf',
  };
}
