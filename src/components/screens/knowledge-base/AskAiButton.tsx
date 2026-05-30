import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useKnowledgeBase } from '../../../context/KnowledgeBaseContext';
import { useKnowledgeAi } from '../../../context/KnowledgeAiContext';

/**
 * Floating circular "Ask AI" button, pinned to the bottom-right of the editor
 * pane (anchored to a non-scrolling, relative ancestor so it stays put as the
 * page scrolls). Hidden when no page is open or while the panel is open.
 */
export function AskAiButton() {
  const { t } = useTranslation();
  const { activePage } = useKnowledgeBase();
  const { isOpen, openForPage } = useKnowledgeAi();

  if (isOpen || !activePage) return null;

  return (
    <button
      type="button"
      onClick={() => openForPage(activePage)}
      className="absolute bottom-5 right-5 z-30 flex items-center justify-center w-11 h-11 rounded-full bg-accent text-white shadow-lg shadow-accent/30 ring-1 ring-accent/40 hover:brightness-110 active:scale-95 transition-all cursor-pointer"
      title={t('knowledgeBase.askAi')}
      aria-label={t('knowledgeBase.askAi')}
    >
      <Sparkles size={18} strokeWidth={2} />
    </button>
  );
}
