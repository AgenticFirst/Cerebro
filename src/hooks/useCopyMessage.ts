import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../context/ToastContext';
import { renderMarkdownToHtml } from '../lib/markdown-to-html';

interface UseCopyMessageResult {
  copied: boolean;
  copy: (markdown: string) => Promise<void>;
}

const COPIED_DURATION_MS = 1500;

/**
 * Copy message content so plaintext targets receive markdown and rich-text
 * targets (Docs, Notion, Gmail) receive formatted HTML. Falls back to
 * plain-text writeText if the rich ClipboardItem path is unavailable.
 */
export function useCopyMessage(): UseCopyMessageResult {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), COPIED_DURATION_MS);
  }, []);

  const copy = useCallback(
    async (markdown: string) => {
      if (!markdown) return;

      // Rich path first — writes both MIME types so the clipboard target picks
      // the one it prefers.
      const canWriteRich =
        typeof navigator !== 'undefined'
        && !!navigator.clipboard
        && typeof navigator.clipboard.write === 'function'
        && typeof ClipboardItem !== 'undefined';

      if (canWriteRich) {
        try {
          const html = renderMarkdownToHtml(markdown);
          const item = new ClipboardItem({
            'text/plain': new Blob([markdown], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
          });
          await navigator.clipboard.write([item]);
          flashCopied();
          addToast(t('chat.messageCopied'), 'success');
          return;
        } catch {
          // fall through to plain-text path
        }
      }

      try {
        await navigator.clipboard.writeText(markdown);
        flashCopied();
        addToast(t('chat.messageCopied'), 'success');
      } catch {
        addToast(t('chat.copyFailed'), 'error');
      }
    },
    [addToast, flashCopied, t],
  );

  return { copied, copy };
}
