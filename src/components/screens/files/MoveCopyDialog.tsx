import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Folder, FolderOpen } from 'lucide-react';
import clsx from 'clsx';
import { useFiles } from '../../../context/FilesContext';

interface MoveCopyDialogProps {
  mode: 'move' | 'copy';
  count: number;
  onClose: () => void;
  onConfirm: (bucketId: string) => Promise<void>;
}

export default function MoveCopyDialog({ mode, count, onClose, onConfirm }: MoveCopyDialogProps) {
  const { t } = useTranslation();
  const { buckets } = useFiles();
  const [selectedId, setSelectedId] = useState<string | null>(buckets.find((b) => b.isDefault)?.id ?? null);
  const [busy, setBusy] = useState(false);

  const titleKey = mode === 'move' ? 'files.moveDialogTitle' : 'files.copyDialogTitle';

  const handleConfirm = async () => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await onConfirm(selectedId);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...buckets].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-md mx-4 animate-fade-in">
        <div className="px-5 pt-5 pb-3">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
          <h3 className="text-sm font-medium text-text-primary mb-1">
            {t(titleKey, { count })}
          </h3>
          <p className="text-xs text-text-tertiary">{t('files.pickBucket')}</p>
        </div>
        <div className="max-h-72 overflow-y-auto px-3 pb-3 space-y-px">
          {sorted.map((bucket) => {
            const isSel = selectedId === bucket.id;
            const Icon = isSel ? FolderOpen : Folder;
            const label = bucket.isDefault ? t('files.bucketDefault') : bucket.name;
            return (
              <button
                key={bucket.id}
                onClick={() => setSelectedId(bucket.id)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-md text-left transition-colors cursor-pointer',
                  isSel ? 'bg-accent/10 text-text-primary' : 'hover:bg-white/[0.03] text-text-secondary',
                )}
              >
                <Icon size={14} className={isSel ? 'text-accent' : 'text-text-tertiary'} />
                <span className="text-[13px] flex-1 truncate">{label}</span>
                <span className="text-[10px] tabular-nums text-text-tertiary">{bucket.fileCount}</span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-border-subtle px-5 py-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selectedId || busy}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mode === 'move' ? t('files.actionMove').replace('\u2026', '') : t('files.actionCopy').replace('\u2026', '')}
          </button>
        </div>
      </div>
    </div>
  );
}
