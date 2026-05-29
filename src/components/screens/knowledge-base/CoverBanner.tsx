import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useKnowledgeBase, type KbPage } from '../../../context/KnowledgeBaseContext';
import { CoverUrlPopover } from './CoverUrlPopover';

/**
 * Full-bleed page cover banner (shown only when the page has a cover_url).
 * Hover reveals "Change cover" / "Remove cover" controls, like Notion.
 */
export function CoverBanner({ page }: { page: KbPage }) {
  const { t } = useTranslation();
  const { setPageCover } = useKnowledgeBase();
  const [changeOpen, setChangeOpen] = useState(false);

  if (!page.coverUrl) return null;

  return (
    <div className="relative w-full h-52 group/cover overflow-hidden bg-bg-elevated">
      <img
        src={page.coverUrl}
        alt=""
        className="w-full h-full object-cover"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.opacity = '0.2';
        }}
      />
      <div className="absolute bottom-2 right-3 flex items-center gap-1.5 opacity-0 group-hover/cover:opacity-100 transition-opacity">
        <div className="relative">
          <button
            onClick={() => setChangeOpen((v) => !v)}
            className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-black/50 hover:bg-black/70 text-white/90 backdrop-blur-sm cursor-pointer transition-colors"
          >
            {t('knowledgeBase.changeCover')}
          </button>
          {changeOpen && (
            <CoverUrlPopover
              align="right"
              initialUrl={page.coverUrl}
              onApply={(url) => {
                void setPageCover(page.id, url);
                setChangeOpen(false);
              }}
              onClose={() => setChangeOpen(false)}
            />
          )}
        </div>
        <button
          onClick={() => void setPageCover(page.id, null)}
          className="px-2.5 py-1 rounded-md text-[12px] font-medium bg-black/50 hover:bg-black/70 text-white/90 backdrop-blur-sm cursor-pointer transition-colors"
        >
          {t('knowledgeBase.removeCover')}
        </button>
      </div>
    </div>
  );
}
