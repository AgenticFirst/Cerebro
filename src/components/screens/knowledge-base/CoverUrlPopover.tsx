import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';

/**
 * Small popover to set a page cover from an image URL. Covers are stored as a
 * plain URL (cover_url) so we avoid file-management plumbing; remote images and
 * cerebro-files:// URLs both render directly in the renderer.
 */
export function CoverUrlPopover({
  initialUrl,
  onApply,
  onClose,
  align = 'left',
}: {
  initialUrl?: string | null;
  onApply: (url: string) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(initialUrl ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const apply = () => {
    const v = url.trim();
    if (v) onApply(v);
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className={clsx(
          'absolute top-full mt-1 z-50 w-[320px] rounded-xl border border-border-default bg-bg-elevated shadow-2xl p-2.5',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="https://…"
            className="flex-1 bg-bg-base/60 rounded-md px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary outline-none border border-border-subtle focus:border-border-accent"
          />
          <button
            onClick={apply}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-accent/15 hover:bg-accent/25 text-accent cursor-pointer whitespace-nowrap transition-colors"
          >
            {t('common.apply') ?? 'Apply'}
          </button>
        </div>
      </div>
    </>
  );
}
