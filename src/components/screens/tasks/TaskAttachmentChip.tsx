import { useTranslation } from 'react-i18next';
import { FolderOpen, X } from 'lucide-react';
import type { TaskAttachment } from '../../../context/TaskContext';
import { formatFileSize, labelForExt } from '../../../lib/file-ext-labels';

interface TaskAttachmentChipProps {
  attachment: TaskAttachment;
  onRemove: () => void;
}

export default function TaskAttachmentChip({ attachment, onRemove }: TaskAttachmentChipProps) {
  const { t } = useTranslation();

  const handleOpen = () => {
    window.cerebro.files
      .open({ storageKind: 'managed', storagePath: attachment.storage_path })
      .catch((err) => console.warn('[attachment] open failed:', err));
  };

  const handleReveal = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.cerebro.files
      .reveal({ storageKind: 'managed', storagePath: attachment.storage_path })
      .catch((err) => console.warn('[attachment] reveal failed:', err));
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRemove();
  };

  return (
    <div
      onClick={handleOpen}
      className="group flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-bg-elevated border border-border-subtle hover:border-border-default transition-colors cursor-pointer min-w-0 max-w-full"
      title={t('tasks.attachmentsOpen') + ' — ' + attachment.name}
    >
      <span className="flex-shrink-0 w-7 h-7 rounded bg-bg-base border border-border-subtle flex items-center justify-center text-[10px] font-mono text-text-tertiary uppercase">
        {labelForExt(attachment.ext)}
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm text-text-primary truncate">{attachment.name}</span>
        <span className="text-[11px] text-text-tertiary">
          {formatFileSize(attachment.size_bytes)}
        </span>
      </div>
      <button
        type="button"
        onClick={handleReveal}
        className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-base opacity-0 group-hover:opacity-100 transition-opacity"
        title={t('tasks.attachmentsReveal')}
        aria-label={t('tasks.attachmentsReveal')}
      >
        <FolderOpen size={14} />
      </button>
      <button
        type="button"
        onClick={handleRemove}
        className="flex-shrink-0 p-1 rounded text-text-tertiary hover:text-red-400 hover:bg-bg-base opacity-0 group-hover:opacity-100 transition-opacity"
        title={t('tasks.attachmentsRemove')}
        aria-label={t('tasks.attachmentsRemove')}
      >
        <X size={14} />
      </button>
    </div>
  );
}
