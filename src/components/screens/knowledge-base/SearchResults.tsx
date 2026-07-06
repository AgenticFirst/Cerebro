import { useTranslation } from 'react-i18next';
import type { KbSearchHit } from '../../../context/KnowledgeBaseContext';
import { SnippetText } from '../../common/SnippetText';
import { PageIcon } from './PageIcon';

export function SearchResults({
  hits,
  query,
  onOpen,
}: {
  hits: KbSearchHit[];
  query: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (hits.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-text-tertiary">
        {t('knowledgeBase.searchNoResults', { query })}
      </div>
    );
  }

  return (
    <div className="space-y-px">
      {hits.map((h) => (
        <button
          key={h.id}
          onClick={() => onOpen(h.id)}
          className="w-full text-left px-2 py-2 rounded-md hover:bg-white/[0.03] cursor-pointer transition-colors"
        >
          <div className="flex items-center gap-1.5">
            <PageIcon icon={h.icon} />
            <span className="text-[13px] text-text-primary truncate">
              {h.title.trim() || t('knowledgeBase.untitled')}
            </span>
          </div>
          {h.snippet && (
            <div className="mt-0.5 pl-[22px] text-[11px] text-text-tertiary line-clamp-2 leading-snug">
              <SnippetText snippet={h.snippet} />
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
