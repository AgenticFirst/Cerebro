import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, Search, Users } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useChat } from '../../context/ChatContext';
import { useChatSearch } from '../../context/ChatSearchContext';
import { useExperts } from '../../context/ExpertContext';
import { SnippetText } from '../common/SnippetText';
import { timeAgo } from '../screens/activity/helpers';
import { TelegramIcon } from '../icons/BrandIcons';
import type { BackendResponse } from '../../types/ipc';

// Shapes returned by GET /conversations/search (backend/conversation_search.py).
interface MessageHit {
  message_id: string;
  role: string;
  snippet: string;
  created_at: string;
}

interface ConversationSearchHit {
  conversation_id: string;
  title: string;
  title_snippet: string | null;
  expert_id: string | null;
  source: string;
  updated_at: string;
  match_count: number;
  message_hits: MessageHit[];
}

/** Global search across every conversation (general, expert, telegram).
 *  Overlay opened from the sidebar, the command palette, or Cmd/Ctrl+Shift+F. */
export default function ChatSearchModal() {
  const { t } = useTranslation();
  const { isOpen, open, close } = useChatSearch();
  const { conversations, setActiveScreen, setActiveConversation, requestExpertConversation } =
    useChat();
  const { experts, setLastExpertsTab } = useExperts();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Monotonic counter so responses that arrive out of order are discarded.
  const searchSeq = useRef(0);

  // Global Cmd/Ctrl+Shift+F toggle (Cmd+K belongs to the command palette).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        if (isOpen) close();
        else open();
      } else if (e.key === 'Escape' && isOpen) {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, open, close]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setResults(null);
      setSearching(false);
      setActiveIndex(0);
    }
  }, [isOpen]);

  // Debounced live search (250ms), same pattern as the Email screen.
  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();
    const seq = ++searchSeq.current;
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res: BackendResponse<{ results: ConversationSearchHit[] }> =
          await window.cerebro.invoke({
            method: 'GET',
            path: `/conversations/search?q=${encodeURIComponent(q)}&limit=20`,
          });
        if (searchSeq.current !== seq) return;
        setResults(res.ok ? res.data.results : []);
        setActiveIndex(0);
      } catch {
        if (searchSeq.current === seq) setResults([]);
      } finally {
        if (searchSeq.current === seq) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, isOpen]);

  const openHit = (hit: ConversationSearchHit) => {
    // Deleted since indexing (or not yet synced locally) → drop the stale row.
    if (!conversations.some((c) => c.id === hit.conversation_id)) {
      setResults((prev) =>
        prev ? prev.filter((r) => r.conversation_id !== hit.conversation_id) : prev,
      );
      return;
    }
    if (hit.expert_id) {
      // Expert threads live in Experts → Messages; MessagesTab consumes this.
      requestExpertConversation(hit.expert_id, hit.conversation_id);
      setLastExpertsTab('messages');
      setActiveScreen('experts');
    } else {
      setActiveScreen('chat');
      setActiveConversation(hit.conversation_id);
    }
    close();
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (!results?.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (activeIndex + delta + results.length) % results.length;
      setActiveIndex(next);
      itemRefs.current[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[activeIndex];
      if (hit) openHit(hit);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={close}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-xl border border-border-subtle bg-bg-base shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border-subtle">
          {searching ? (
            <Loader2 size={16} className="text-accent animate-spin" />
          ) : (
            <Search size={16} className="text-text-tertiary" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <kbd className="text-[10px] text-text-tertiary border border-border-subtle rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>

        <div className="max-h-[400px] overflow-y-auto scrollbar-thin py-1.5">
          {!query.trim() && (
            <div className="px-3.5 py-6 text-center text-[12px] text-text-tertiary">
              {t('search.hint')}
            </div>
          )}

          {query.trim() && results && results.length === 0 && !searching && (
            <div className="px-3.5 py-6 text-center text-[12px] text-text-tertiary">
              {t('search.noResults', { query: query.trim() })}
            </div>
          )}

          {results?.map((hit, idx) => {
            const expertName = hit.expert_id
              ? (experts.find((e) => e.id === hit.expert_id)?.name ?? t('search.expertBadge'))
              : null;
            return (
              <button
                key={hit.conversation_id}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                onClick={() => openHit(hit)}
                onMouseEnter={() => setActiveIndex(idx)}
                className={clsx(
                  'w-full text-left px-3.5 py-2 transition-colors',
                  idx === activeIndex ? 'bg-bg-hover' : 'hover:bg-bg-hover',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MessageSquare size={13} className="text-text-tertiary flex-shrink-0" />
                  <span className="text-[13px] text-text-primary truncate">
                    {hit.title_snippet ? (
                      <SnippetText snippet={hit.title_snippet} />
                    ) : (
                      hit.title.trim() || t('search.untitled')
                    )}
                  </span>
                  {expertName && (
                    <span className="flex items-center gap-1 flex-shrink-0 text-[10px] text-accent bg-accent/10 rounded px-1.5 py-0.5">
                      <Users size={10} />
                      {expertName}
                    </span>
                  )}
                  {hit.source === 'telegram' && (
                    <span className="flex-shrink-0 text-text-tertiary">
                      <TelegramIcon size={11} />
                    </span>
                  )}
                  <span className="ml-auto flex-shrink-0 text-[10px] text-text-tertiary">
                    {timeAgo(hit.updated_at, t)}
                  </span>
                </div>
                {hit.message_hits.length > 0 && (
                  <div className="mt-1 pl-[21px] space-y-0.5">
                    {hit.message_hits.map((m) => (
                      <div
                        key={m.message_id}
                        className="text-[11px] text-text-tertiary line-clamp-2 leading-snug"
                      >
                        <span className="text-text-secondary">
                          {t(m.role === 'user' ? 'search.roleUser' : 'search.roleAssistant')}
                        </span>{' '}
                        <SnippetText snippet={m.snippet} />
                      </div>
                    ))}
                    {hit.match_count > hit.message_hits.length && (
                      <div className="text-[10px] text-text-tertiary/70">
                        {t('search.moreMatches', {
                          count: hit.match_count - hit.message_hits.length,
                        })}
                      </div>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
