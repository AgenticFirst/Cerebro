import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, FolderX } from 'lucide-react';
import clsx from 'clsx';

interface ProjectFolderFieldProps {
  value: string | null;
  onChange: (path: string | null) => void | Promise<void>;
  /** "compact" fits the drawer's metadata row; "block" fills the dialog's column layout. */
  variant?: 'compact' | 'block';
  className?: string;
}

export default function ProjectFolderField({
  value,
  onChange,
  variant = 'block',
  className,
}: ProjectFolderFieldProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async () => {
    setError(null);
    try {
      const chosen = await window.cerebro.sandbox.pickDirectory();
      if (chosen) await onChange(chosen);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChange]);

  const clear = useCallback(async () => {
    setError(null);
    try {
      await onChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onChange]);

  const isCompact = variant === 'compact';
  const iconSize = isCompact ? 13 : 14;

  return (
    <div className={className}>
      {value ? (
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'flex-1 bg-bg-surface border border-border-subtle rounded-lg font-mono text-text-primary truncate',
              isCompact ? 'px-2 py-1 text-xs max-w-[260px]' : 'px-3 py-2 text-xs',
            )}
            title={value}
          >
            {value}
          </span>
          <button
            type="button"
            onClick={pick}
            className={clsx(
              'rounded-lg text-text-tertiary hover:text-accent hover:bg-bg-hover transition-colors cursor-pointer',
              isCompact ? 'p-1' : 'p-2',
            )}
            title={t('tasks.drawerPickFolder')}
          >
            <FolderOpen size={iconSize} />
          </button>
          <button
            type="button"
            onClick={clear}
            className={clsx(
              'rounded-lg text-text-tertiary hover:text-red-400 hover:bg-bg-hover transition-colors cursor-pointer',
              isCompact ? 'p-1' : 'p-2',
            )}
            title={t('tasks.drawerClearFolder')}
          >
            <FolderX size={iconSize} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pick}
          className={clsx(
            'flex items-center gap-2 bg-bg-surface border border-border-subtle rounded-lg text-text-tertiary hover:border-accent/40 hover:text-text-primary transition-colors cursor-pointer',
            isCompact ? 'px-2 py-1 text-xs' : 'w-full px-3 py-2 text-sm',
          )}
        >
          <FolderOpen size={isCompact ? 11 : 13} />
          {t('tasks.drawerPickFolder')}
        </button>
      )}

      {error && (
        <div className="mt-1 text-xs text-red-400">{error}</div>
      )}
    </div>
  );
}
