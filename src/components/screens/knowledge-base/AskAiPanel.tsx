import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Plus, Trash2, Send, Loader2, Globe, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useKnowledgeAi } from '../../../context/KnowledgeAiContext';
import MarkdownContent from '../../chat/MarkdownContent';

/**
 * Presentational "Ask AI" panel. All run/thread state lives in
 * KnowledgeAiContext so a run survives navigation and panel collapse; this
 * component only renders it. Mounted as a flex sibling by KnowledgeBaseScreen,
 * so when open it reserves width and the page content stays fully visible.
 */
export function AskAiPanel() {
  const { t } = useTranslation();
  const {
    threads,
    threadId,
    messages,
    input,
    streaming,
    isRunning,
    setInput,
    close,
    openThread,
    startNewThread,
    removeThread,
    send,
  } = useKnowledgeAi();

  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the message list pinned to the bottom as content streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const currentTitle = threads.find((th) => th.id === threadId)?.title ?? t('knowledgeBase.askAiNewChat');
  const isEmpty = messages.length === 0 && !streaming;

  return (
    <div className="w-[400px] flex-shrink-0 h-full flex flex-col bg-bg-surface border-l border-border-default">
      {/* Header */}
      <div className="app-drag-region h-11 flex-shrink-0" />
      <div className="flex items-center gap-2 px-3 pb-2">
        <Sparkles size={15} className="text-accent flex-shrink-0" />
        {/* Thread switcher */}
        <div className="relative flex-1 min-w-0">
          <button
            onClick={() => setThreadMenuOpen((v) => !v)}
            className="flex items-center gap-1 max-w-full text-[13px] font-medium text-text-primary hover:text-text-primary truncate cursor-pointer"
            title={currentTitle}
          >
            <span className="truncate">{currentTitle}</span>
            <ChevronDown size={13} className="text-text-tertiary flex-shrink-0" />
          </button>
          {threadMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setThreadMenuOpen(false)} />
              <div className="absolute left-0 top-7 z-50 w-72 max-h-80 overflow-y-auto scrollbar-thin rounded-lg border border-border-default bg-bg-elevated shadow-xl py-1">
                <button
                  onClick={() => {
                    startNewThread();
                    setThreadMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-accent hover:bg-white/[0.05] cursor-pointer"
                >
                  <Plus size={13} /> {t('knowledgeBase.askAiNewChat')}
                </button>
                {threads.length > 0 && <div className="my-1 border-t border-border-subtle" />}
                {threads.map((th) => (
                  <div
                    key={th.id}
                    className={clsx(
                      'group/th flex items-center gap-1 px-2 py-1.5 mx-1 rounded-md cursor-pointer',
                      th.id === threadId ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]',
                    )}
                    onClick={() => {
                      void openThread(th.id);
                      setThreadMenuOpen(false);
                    }}
                  >
                    <span className="flex-1 truncate text-[13px] text-text-secondary">{th.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeThread(th.id);
                      }}
                      className="opacity-0 group-hover/th:opacity-100 p-0.5 rounded text-text-tertiary hover:text-red-400 cursor-pointer"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          onClick={() => {
            startNewThread();
            setThreadMenuOpen(false);
          }}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer"
          title={t('knowledgeBase.askAiNewChat')}
          aria-label={t('knowledgeBase.askAiNewChat')}
        >
          <Plus size={15} />
        </button>
        <button
          onClick={close}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer"
          title={t('knowledgeBase.askAiCollapse')}
          aria-label={t('knowledgeBase.askAiCollapse')}
        >
          <X size={16} />
        </button>
      </div>
      <div className="border-t border-border-subtle" />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-3">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center text-center gap-2 h-full px-4">
            <Sparkles size={22} className="text-accent" />
            <p className="text-[13px] font-medium text-text-secondary">{t('knowledgeBase.askAiEmptyTitle')}</p>
            <p className="text-[12px] text-text-tertiary leading-relaxed">{t('knowledgeBase.askAiEmptySubtitle')}</p>
          </div>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 text-text-primary px-3 py-2 text-[13px] whitespace-pre-wrap">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="max-w-full text-[13px] text-text-primary">
              <MarkdownContent content={m.content} />
            </div>
          ),
        )}

        {/* In-flight assistant answer */}
        {streaming && (
          <div className="max-w-full text-[13px] text-text-primary">
            {streaming.searching && (
              <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.06] text-accent px-2.5 py-1 text-[11px] font-medium">
                <Globe size={11} /> {t('knowledgeBase.askAiSearchingWeb')}
              </div>
            )}
            {streaming.text ? (
              <MarkdownContent content={streaming.text} />
            ) : (
              !streaming.searching && (
                <div className="inline-flex items-center gap-2 text-text-secondary text-[12px]">
                  <Loader2 size={12} className="animate-spin" /> {t('knowledgeBase.askAiThinking')}
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-border-subtle p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 focus-within:border-border-accent transition-colors">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={t('knowledgeBase.askAiPlaceholder')}
            className="flex-1 resize-none bg-transparent outline-none text-[13px] text-text-primary placeholder:text-text-tertiary max-h-32 py-1"
          />
          <button
            onClick={() => void send()}
            disabled={!input.trim() || isRunning}
            className={clsx(
              'flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0 transition-colors',
              input.trim() && !isRunning
                ? 'bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer'
                : 'text-text-tertiary cursor-not-allowed',
            )}
            aria-label={t('knowledgeBase.askAiSend')}
          >
            {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
