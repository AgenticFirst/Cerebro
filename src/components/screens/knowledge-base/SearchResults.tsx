import { useTranslation } from 'react-i18next';
import type { KbSearchHit } from '../../../context/KnowledgeBaseContext';
import { PageIcon } from './PageIcon';

// Backend wraps matched spans in sentinel control chars (U+0001/U+0002 — see
// knowledge/router.py SNIP_START/SNIP_END). Defined via fromCharCode so the
// source stays printable.
const SENT_START = String.fromCharCode(1);
const SENT_END = String.fromCharCode(2);

/** Render a snippet, bolding the sentinel-wrapped matched spans. Text-only —
 *  no HTML parsing, so user content can't inject markup. */
function SnippetText({ snippet }: { snippet: string }) {
  // Each chunk after the first opens with a highlighted span (…<START>hit<END>rest).
  const parts = snippet.split(SENT_START);
  return (
    <>
      {parts.map((part, idx) => {
        if (idx === 0) return <span key={idx}>{part}</span>;
        const [hit, rest = ''] = part.split(SENT_END);
        return (
          <span key={idx}>
            <mark className="bg-accent/20 text-text-primary rounded-[2px] px-0.5">{hit}</mark>
            {rest}
          </span>
        );
      })}
    </>
  );
}

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
