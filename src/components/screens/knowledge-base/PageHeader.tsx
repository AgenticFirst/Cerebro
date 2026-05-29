import { useEffect, useRef, useState } from 'react';
import { Smile, Image as ImageIcon } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useKnowledgeBase, type KbPage } from '../../../context/KnowledgeBaseContext';
import { EmojiGlyph } from './EmojiGlyph';
import { EmojiPicker } from './EmojiPicker';
import { CoverUrlPopover } from './CoverUrlPopover';

const RENAME_MS = 400;

/**
 * Notion-style page header: a hover toolbar to add an icon/cover, an emoji icon
 * (click to pick/change/remove) and a large editable title. Title edits are
 * debounced into a rename; the context updates the sidebar tree optimistically.
 */
export function PageHeader({ page }: { page: KbPage }) {
  const { t } = useTranslation();
  const { renamePage, setPageIcon, setPageCover } = useKnowledgeBase();
  const [title, setTitle] = useState(page.title);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTitle(page.title);
  }, [page.id, page.title]);

  const onTitleChange = (next: string) => {
    setTitle(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      renamePage(page.id, next.trim());
    }, RENAME_MS);
  };

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <div className="px-[54px] group/header">
      {/* Hover toolbar: offer to add what isn't there yet */}
      <div className="flex items-center gap-1 h-7 mb-1 opacity-0 group-hover/header:opacity-100 transition-opacity">
        {!page.icon && (
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-white/[0.04] cursor-pointer transition-colors"
          >
            <Smile size={14} />
            {t('knowledgeBase.addIcon')}
          </button>
        )}
        {!page.coverUrl && (
          <div className="relative">
            <button
              onClick={() => setCoverOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-white/[0.04] cursor-pointer transition-colors"
            >
              <ImageIcon size={14} />
              {t('knowledgeBase.addCover')}
            </button>
            {coverOpen && (
              <CoverUrlPopover
                onApply={(url) => {
                  void setPageCover(page.id, url);
                  setCoverOpen(false);
                }}
                onClose={() => setCoverOpen(false)}
              />
            )}
          </div>
        )}
      </div>

      {/* Icon */}
      {page.icon && (
        <div className="relative inline-block">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="flex items-center justify-center rounded-md hover:bg-white/[0.06] p-1 -ml-1 cursor-pointer transition-colors"
            title={t('knowledgeBase.changeIcon')}
          >
            <EmojiGlyph emoji={page.icon} size={56} />
          </button>
          {pickerOpen && (
            <EmojiPicker
              hasIcon
              onSelect={(emoji) => {
                void setPageIcon(page.id, emoji);
                setPickerOpen(false);
              }}
              onRemove={() => {
                void setPageIcon(page.id, null);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      )}
      {/* Picker anchor when there is no icon yet (opened from the toolbar) */}
      {!page.icon && pickerOpen && (
        <div className="relative inline-block">
          <EmojiPicker
            hasIcon={false}
            onSelect={(emoji) => {
              void setPageIcon(page.id, emoji);
              setPickerOpen(false);
            }}
            onRemove={() => setPickerOpen(false)}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      )}

      {/* Title */}
      <input
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder={t('knowledgeBase.titlePlaceholder')}
        className={clsx(
          'w-full bg-transparent outline-none border-none mt-1',
          'text-[40px] leading-tight font-bold tracking-tight',
          'text-text-primary placeholder:text-text-tertiary/50',
        )}
        maxLength={255}
      />
    </div>
  );
}
