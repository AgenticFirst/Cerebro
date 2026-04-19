import { useEffect, useState } from 'react';
import { X, Download, FolderOpen, Folder, Check, Loader2, Save } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { AttachmentInfo } from '../../types/attachments';
import { useToast } from '../../context/ToastContext';
import { useMarkdownDocument } from '../../context/MarkdownDocumentContext';
import { useFiles } from '../../context/FilesContext';

const EXT_LABELS: Record<string, string> = {
  ts: 'TS', tsx: 'TX', js: 'JS', jsx: 'JX',
  py: 'PY', rs: 'RS', go: 'GO', rb: 'RB',
  json: '{}', md: 'MD', txt: 'TXT', html: '<>',
  css: 'CS', yaml: 'YM', yml: 'YM', toml: 'TM',
  sh: 'SH', sql: 'SQ', pdf: 'PF', swift: 'SW',
  java: 'JA', c: 'C', cpp: 'C+', h: 'H',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface AttachmentChipProps {
  attachment: AttachmentInfo;
  onRemove?: (id: string) => void;
  /** 'user' = chip on the user's own message (default). 'assistant' = chip for
   *  a file emitted by an expert — renders Download/Reveal actions instead of remove. */
  source?: 'user' | 'assistant';
  /** Conversation/message refs are stored alongside the saved file so it can be
   *  traced back to its origin. */
  conversationId?: string;
  messageId?: string;
}

export default function AttachmentChip({ attachment, onRemove, source = 'user', conversationId, messageId }: AttachmentChipProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { open: openMarkdown } = useMarkdownDocument();
  const { saveExternalToFiles } = useFiles();
  const isAssistant = source === 'assistant';
  const [saveState, setSaveState] = useState<'idle' | 'running' | 'done'>('idle');

  // Live-stat the path on mount so we can pick the right UI (file vs folder)
  // and show accurate size. Stays 'undefined' until the stat returns so we can
  // render a quiet placeholder instead of the wrong chip type.
  const [isDirectory, setIsDirectory] = useState<boolean | undefined>(attachment.isDirectory);
  const [fileSize, setFileSize] = useState<number>(attachment.fileSize);
  const [missing, setMissing] = useState(false);
  const [downloadState, setDownloadState] = useState<'idle' | 'running' | 'done'>('idle');

  useEffect(() => {
    if (!isAssistant) return;
    if (attachment.isDirectory !== undefined) return;
    let cancelled = false;
    window.cerebro.shell
      .statPath(attachment.filePath)
      .then((stat) => {
        if (cancelled) return;
        if (!stat.exists) {
          setMissing(true);
          return;
        }
        setIsDirectory(stat.isDirectory);
        if (!stat.isDirectory && stat.size > 0) setFileSize(stat.size);
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => { cancelled = true; };
  }, [attachment.filePath, attachment.isDirectory, isAssistant]);

  const extLabel = EXT_LABELS[attachment.extension] || attachment.extension.slice(0, 2).toUpperCase() || '?';

  const handleReveal = () => {
    window.cerebro.shell.revealPath(attachment.filePath).catch(() => undefined);
  };
  const handleOpenFolder = () => {
    // Opens the directory itself in Finder/Explorer.
    window.cerebro.shell.openPath(attachment.filePath).catch(() => undefined);
  };
  const isMarkdown =
    isAssistant &&
    isDirectory === false &&
    !missing &&
    attachment.extension === 'md';

  const handleOpenMarkdown = async () => {
    try {
      const content = await window.cerebro.shell.readTextFile(attachment.filePath);
      openMarkdown({
        title: attachment.fileName,
        subtitle: attachment.filePath,
        content,
        readOnly: true,
        filePath: attachment.filePath,
      });
    } catch (err) {
      const message = err instanceof Error && err.message.includes('too large')
        ? t('markdown.loadTooLarge')
        : t('markdown.loadFailed');
      addToast(message, 'error');
    }
  };

  const handleSaveToFiles = async () => {
    if (saveState === 'running') return;
    setSaveState('running');
    try {
      const item = await saveExternalToFiles({
        sourcePath: attachment.filePath,
        source: isAssistant ? 'workspace-save' : 'chat-save',
        sourceConversationId: conversationId ?? null,
        sourceMessageId: messageId ?? null,
        displayName: attachment.fileName,
      });
      if (item) {
        setSaveState('done');
        setTimeout(() => setSaveState('idle'), 2000);
      } else {
        setSaveState('idle');
      }
    } catch {
      setSaveState('idle');
      addToast(t('experts.downloadFailed'), 'error');
    }
  };

  const handleDownload = async () => {
    if (downloadState === 'running') return;
    setDownloadState('running');
    try {
      const dest = await window.cerebro.shell.downloadToDownloads(attachment.filePath);
      setDownloadState('done');
      addToast(t('experts.downloadedToDownloads', { name: attachment.fileName }), 'success');
      // Snap back to the default icon after a moment so the chip is usable again.
      setTimeout(() => setDownloadState('idle'), 2000);
      // A tiny nudge in case the user wants to grab the freshly-copied file.
      void dest;
    } catch {
      setDownloadState('idle');
      addToast(t('experts.downloadFailed'), 'error');
    }
  };

  // ── Folder chip — single "Open folder" action ────────────────────
  if (isAssistant && isDirectory === true) {
    return (
      <button
        onClick={handleOpenFolder}
        className={clsx(
          'inline-flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-md cursor-pointer',
          'bg-bg-elevated border border-border-subtle text-xs text-text-secondary',
          'group transition-all duration-150',
          'hover:border-accent/40 hover:bg-accent/[0.04] hover:text-text-primary',
        )}
        title={t('experts.openFolder')}
      >
        <span className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 bg-accent/10 text-accent">
          <Folder size={12} strokeWidth={2.25} />
        </span>
        <span className="max-w-[160px] truncate">{attachment.fileName}</span>
        <FolderOpen
          size={11}
          className="flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity"
        />
      </button>
    );
  }

  // ── File chip — download primary, reveal secondary ───────────────
  const bodyContent = (
    <>
      <span
        className={clsx(
          'w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
          'bg-accent/10 text-accent text-[9px] font-bold',
        )}
      >
        {extLabel}
      </span>
      <span className="max-w-[140px] truncate">{attachment.fileName}</span>
      {fileSize > 0 && (
        <span className="text-text-tertiary text-[10px]">{formatSize(fileSize)}</span>
      )}
    </>
  );

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-md',
        'bg-bg-elevated border border-border-subtle text-xs text-text-secondary',
        'group transition-colors',
        (onRemove || isAssistant) && !missing && 'hover:border-border-default',
        missing && 'opacity-60',
      )}
      title={missing ? t('experts.attachmentMissing') : undefined}
    >
      {isMarkdown ? (
        <button
          type="button"
          onClick={handleOpenMarkdown}
          className="flex items-center gap-1.5 cursor-pointer hover:text-text-primary transition-colors"
          title={t('markdown.expand')}
        >
          {bodyContent}
        </button>
      ) : (
        bodyContent
      )}
      {isAssistant && !missing && isDirectory === false && (
        <button
          onClick={handleSaveToFiles}
          disabled={saveState === 'running'}
          className={clsx(
            'w-5 h-5 flex items-center justify-center rounded flex-shrink-0 transition-all',
            saveState === 'done'
              ? 'text-emerald-500'
              : 'opacity-70 hover:opacity-100 hover:bg-bg-hover text-text-secondary',
          )}
          title={t('files.saveToFiles')}
        >
          {saveState === 'running' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : saveState === 'done' ? (
            <Check size={11} strokeWidth={2.5} />
          ) : (
            <Save size={11} />
          )}
        </button>
      )}
      {isAssistant && !missing && (
        <>
          <button
            onClick={handleDownload}
            disabled={downloadState === 'running'}
            className={clsx(
              'w-5 h-5 flex items-center justify-center rounded flex-shrink-0 transition-all',
              downloadState === 'done'
                ? 'text-emerald-500'
                : 'opacity-70 hover:opacity-100 hover:bg-bg-hover text-text-secondary',
            )}
            title={t('experts.downloadFile')}
          >
            {downloadState === 'running' ? (
              <Loader2 size={11} className="animate-spin" />
            ) : downloadState === 'done' ? (
              <Check size={11} strokeWidth={2.5} />
            ) : (
              <Download size={11} />
            )}
          </button>
          <button
            onClick={handleReveal}
            className="w-5 h-5 flex items-center justify-center rounded flex-shrink-0 opacity-70 hover:opacity-100 hover:bg-bg-hover transition-all"
            title={t('experts.revealInFolder')}
          >
            <FolderOpen size={11} />
          </button>
        </>
      )}
      {onRemove && (
        <button
          onClick={() => onRemove(attachment.id)}
          className={clsx(
            'w-4 h-4 flex items-center justify-center rounded flex-shrink-0',
            'opacity-0 group-hover:opacity-100 hover:bg-bg-hover',
            'transition-all',
          )}
        >
          <X size={10} />
        </button>
      )}
    </div>
  );
}
