import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { useFiles } from '../../../context/FilesContext';

const COLORS: Array<{ key: string; hex: string }> = [
  { key: 'cyan', hex: '#06b6d4' },
  { key: 'violet', hex: '#8b5cf6' },
  { key: 'amber', hex: '#f59e0b' },
  { key: 'emerald', hex: '#10b981' },
  { key: 'rose', hex: '#f43f5e' },
  { key: 'sky', hex: '#0ea5e9' },
];

interface CreateBucketModalProps {
  onClose: () => void;
  onCreated?: (bucketId: string) => void;
}

export default function CreateBucketModal({ onClose, onCreated }: CreateBucketModalProps) {
  const { t } = useTranslation();
  const { createBucket } = useFiles();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await createBucket({ name: name.trim(), color });
      if (created) {
        onCreated?.(created.id);
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <form
        onSubmit={handleSubmit}
        className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-sm mx-4 animate-fade-in"
      >
        <div className="px-5 pt-5 pb-4">
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <X size={14} />
          </button>
          <h3 className="text-sm font-medium text-text-primary mb-4">{t('files.createBucketTitle')}</h3>

          <label className="block text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-1.5">
            {t('files.createBucketName')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="ProjectA"
            className="w-full px-3 py-2 rounded-md bg-bg-base border border-border-subtle text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40"
          />

          <div className="mt-4">
            <label className="block text-[11px] font-medium text-text-tertiary uppercase tracking-wider mb-2">
              {t('files.createBucketColor')}
            </label>
            <div className="flex items-center gap-2">
              {COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setColor((prev) => (prev === c.hex ? null : c.hex))}
                  className={clsx(
                    'w-6 h-6 rounded-full border-2 transition-transform',
                    color === c.hex ? 'border-text-primary scale-110' : 'border-transparent',
                  )}
                  style={{ background: c.hex }}
                  aria-label={c.key}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="border-t border-border-subtle px-5 py-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!name.trim() || busy}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? t('common.creating') : t('files.createBucketCreate')}
          </button>
        </div>
      </form>
    </div>
  );
}
