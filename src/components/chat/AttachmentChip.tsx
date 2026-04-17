import { X, ExternalLink, FolderOpen } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { AttachmentInfo } from '../../types/attachments';

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
   *  a file emitted by an expert — renders Open/Reveal actions instead of remove. */
  source?: 'user' | 'assistant';
}

export default function AttachmentChip({ attachment, onRemove, source = 'user' }: AttachmentChipProps) {
  const { t } = useTranslation();
  const extLabel = EXT_LABELS[attachment.extension] || attachment.extension.slice(0, 2).toUpperCase() || '?';
  const isAssistant = source === 'assistant';

  const handleOpen = () => {
    window.cerebro.shell.openPath(attachment.filePath).catch(() => undefined);
  };
  const handleReveal = () => {
    window.cerebro.shell.revealPath(attachment.filePath).catch(() => undefined);
  };

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-md',
        'bg-bg-elevated border border-border-subtle text-xs text-text-secondary',
        'group transition-colors',
        (onRemove || isAssistant) && 'hover:border-border-default',
      )}
    >
      <span
        className={clsx(
          'w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
          'bg-accent/10 text-accent text-[9px] font-bold',
        )}
      >
        {extLabel}
      </span>
      <span className="max-w-[140px] truncate">{attachment.fileName}</span>
      {attachment.fileSize > 0 && (
        <span className="text-text-tertiary text-[10px]">{formatSize(attachment.fileSize)}</span>
      )}
      {isAssistant && (
        <>
          <button
            onClick={handleOpen}
            className="w-4 h-4 flex items-center justify-center rounded flex-shrink-0 opacity-70 hover:opacity-100 hover:bg-bg-hover transition-all"
            title={t('experts.openFile')}
          >
            <ExternalLink size={10} />
          </button>
          <button
            onClick={handleReveal}
            className="w-4 h-4 flex items-center justify-center rounded flex-shrink-0 opacity-70 hover:opacity-100 hover:bg-bg-hover transition-all"
            title={t('experts.revealInFolder')}
          >
            <FolderOpen size={10} />
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
