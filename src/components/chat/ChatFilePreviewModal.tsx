import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Check, Download, ExternalLink, FolderOpen, Loader2, Save, X } from 'lucide-react';
import type { AttachmentInfo } from '../../types/attachments';
import { useToast } from '../../context/ToastContext';
import { useFiles } from '../../context/FilesContext';
import FilePreviewBody from '../files-preview/FilePreviewBody';
import { useChatFilePreview } from './useChatFilePreview';
import { labelForExt, formatFileSize } from '../../lib/file-ext-labels';

interface ChatFilePreviewModalProps {
  attachment: AttachmentInfo;
  conversationId?: string;
  messageId?: string;
  source: 'user' | 'assistant';
  onClose: () => void;
}

export default function ChatFilePreviewModal({
  attachment,
  conversationId,
  messageId,
  source,
  onClose,
}: ChatFilePreviewModalProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { saveExternalToFiles } = useFiles();
  const state = useChatFilePreview(attachment);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'running' | 'done'>('idle');
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'running' | 'done'>('idle');

  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Restore focus on close, focus the panel on open.
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Esc closes; Tab/Shift-Tab traps inside the panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleOpenExternal = useCallback(() => {
    window.cerebro.shell.openPath(attachment.filePath).catch(() => undefined);
  }, [attachment.filePath]);

  const handleReveal = useCallback(() => {
    window.cerebro.shell.revealPath(attachment.filePath).catch(() => undefined);
  }, [attachment.filePath]);

  const handleDownload = useCallback(async () => {
    if (downloadStatus === 'running') return;
    setDownloadStatus('running');
    try {
      await window.cerebro.shell.downloadToDownloads(attachment.filePath);
      setDownloadStatus('done');
      addToast(t('experts.downloadedToDownloads', { name: attachment.fileName }), 'success');
      setTimeout(() => setDownloadStatus('idle'), 2000);
    } catch {
      setDownloadStatus('idle');
      addToast(t('experts.downloadFailed'), 'error');
    }
  }, [attachment.filePath, attachment.fileName, downloadStatus, addToast, t]);

  const handleSaveToFiles = useCallback(async () => {
    if (saveStatus === 'running') return;
    setSaveStatus('running');
    try {
      const item = await saveExternalToFiles({
        sourcePath: attachment.filePath,
        source: source === 'assistant' ? 'workspace-save' : 'chat-save',
        sourceConversationId: conversationId ?? null,
        sourceMessageId: messageId ?? null,
        displayName: attachment.fileName,
      });
      if (item) {
        setSaveStatus('done');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('idle');
      }
    } catch {
      setSaveStatus('idle');
      addToast(t('experts.downloadFailed'), 'error');
    }
  }, [attachment, source, conversationId, messageId, saveExternalToFiles, addToast, t]);

  // Translate the structured load error into a user-facing string for the body.
  const bodyError = (() => {
    if (!state.loadError) return null;
    if (state.loadError === 'missing') return t('files.previewMissing');
    if (state.loadError === 'outside-safe-roots') return t('files.previewOutsideSafeRoot');
    if (state.loadError === 'too-large') {
      return t('files.previewTooLarge', { size: formatFileSize(attachment.fileSize) });
    }
    if (state.loadError === 'parse-failed') return t('files.previewParseFailed');
    return state.loadErrorDetail ?? '';
  })();

  const showLoading = state.loading || state.parsing;
  const loadingLabel = state.parsing ? t('files.previewParsing') : t('files.previewLoading');
  const ext = (attachment.extension || '').toLowerCase();
  const extLabel = labelForExt(ext);

  return (
    <div
      role="dialog"
      aria-modal
      aria-labelledby="chat-file-preview-title"
      className="fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div
        className="absolute inset-0 bg-black/60 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className={clsx(
          'relative w-[min(960px,92vw)] max-h-[85vh] flex flex-col',
          'bg-bg-base border border-border-subtle rounded-lg overflow-hidden',
          'shadow-2xl',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
          <span
            className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 bg-accent/10 text-accent text-[10px] font-bold"
            aria-hidden
          >
            {extLabel}
          </span>
          <div className="flex-1 min-w-0">
            <div
              id="chat-file-preview-title"
              className="text-sm font-semibold text-text-primary truncate"
            >
              {attachment.fileName}
            </div>
            <div
              className="text-[10px] text-text-tertiary truncate font-mono"
              title={attachment.filePath}
            >
              {attachment.fileSize > 0 ? formatFileSize(attachment.fileSize) : ''}
              {attachment.fileSize > 0 && attachment.filePath ? ' · ' : ''}
              {attachment.filePath}
            </div>
          </div>

          {state.hasExtractedTextToggle && (
            <div className="flex items-center mr-1 rounded-md border border-border-subtle overflow-hidden">
              <button
                type="button"
                onClick={() => state.setView('native')}
                className={clsx(
                  'px-2 py-1 text-[10px]',
                  state.view === 'native'
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-tertiary hover:text-text-primary',
                )}
              >
                {t('files.previewTabRendered')}
              </button>
              <button
                type="button"
                onClick={() => state.setView('extracted')}
                className={clsx(
                  'px-2 py-1 text-[10px] border-l border-border-subtle',
                  state.view === 'extracted'
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-tertiary hover:text-text-primary',
                )}
              >
                {t('files.previewTabExtractedText')}
              </button>
            </div>
          )}

          <button
            onClick={handleSaveToFiles}
            disabled={saveStatus === 'running'}
            title={t('files.previewActionSaveToFiles')}
            className={clsx(
              'p-1.5 rounded-md cursor-pointer',
              saveStatus === 'done'
                ? 'text-emerald-500'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
          >
            {saveStatus === 'running' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : saveStatus === 'done' ? (
              <Check size={14} strokeWidth={2.5} />
            ) : (
              <Save size={14} />
            )}
          </button>
          <button
            onClick={handleDownload}
            disabled={downloadStatus === 'running'}
            title={t('files.previewActionDownload')}
            className={clsx(
              'p-1.5 rounded-md cursor-pointer',
              downloadStatus === 'done'
                ? 'text-emerald-500'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-hover',
            )}
          >
            {downloadStatus === 'running' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : downloadStatus === 'done' ? (
              <Check size={14} strokeWidth={2.5} />
            ) : (
              <Download size={14} />
            )}
          </button>
          <button
            onClick={handleReveal}
            title={t('files.previewActionReveal')}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <FolderOpen size={14} />
          </button>
          <button
            onClick={handleOpenExternal}
            title={t('files.previewActionOpenExternal')}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <ExternalLink size={14} />
          </button>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            title={t('files.previewClose')}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {showLoading && state.effectiveKind !== 'markdown' && state.previewUrl === null && state.textContent === null ? (
            <div className="flex-1 flex items-center justify-center text-xs text-text-tertiary">
              {loadingLabel}
            </div>
          ) : (
            <FilePreviewBody
              key={`${attachment.id}-${state.view}-${state.effectiveKind}`}
              kind={state.effectiveKind}
              name={attachment.fileName}
              ext={ext}
              previewUrl={state.previewUrl}
              textContent={state.textContent}
              loadError={bodyError}
              onOpenExternal={handleOpenExternal}
              markdownInline
            />
          )}
        </div>
      </div>
    </div>
  );
}
