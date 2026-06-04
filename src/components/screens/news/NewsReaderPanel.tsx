import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink, Loader2, Send, Globe, FileText, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useNews } from '../../../context/NewsContext';
import MarkdownContent from '../../chat/MarkdownContent';
import { deriveSuggestedQuestions, relativeTime } from './news-api';

/** Hostname for a source chip, e.g. "bbc.co.uk". */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Slide-in reader + Perplexity-style Q&A for the selected article. Renders over
 * the dimmed feed. All run state lives in NewsContext so an in-flight answer
 * survives this panel unmounting; closing discards the ephemeral conversation.
 */
export default function NewsReaderPanel() {
  const { t } = useTranslation();
  const {
    selectedArticle: article,
    messages,
    input,
    streaming,
    isRunning,
    setInput,
    ask,
    closeArticle,
  } = useNews();

  const [imgFailed, setImgFailed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pin to bottom as the answer streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeArticle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeArticle]);

  // Reset the broken-image flag whenever the article changes.
  useEffect(() => setImgFailed(false), [article?.id]);

  if (!article) return null;

  const showImage = article.imageUrl && !imgFailed;
  const time = relativeTime(article.publishedAt);
  const isEmpty = messages.length === 0 && !streaming;
  const suggestions = deriveSuggestedQuestions(t);

  const renderSources = (sources?: string[]) =>
    sources && sources.length > 0 ? (
      <div className="mt-2 flex flex-wrap gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mr-0.5 self-center">
          {t('news.sources')}
        </span>
        {sources.map((url) => (
          <button
            key={url}
            onClick={() => window.cerebro.shell.openExternal(url)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-text-secondary bg-bg-elevated border border-border-subtle hover:border-border-accent hover:text-accent transition-colors cursor-pointer"
          >
            <Globe size={10} /> {hostOf(url)}
          </button>
        ))}
      </div>
    ) : null;

  return (
    <>
      {/* Backdrop dims the feed; click to close */}
      <div className="absolute inset-0 z-10 bg-black/40 animate-fade-in" onClick={closeArticle} />

      {/* Panel */}
      <div className="absolute top-0 right-0 bottom-0 w-[480px] max-w-[90%] z-20 bg-bg-surface border-l border-border-subtle animate-slide-in-right flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 h-12 flex-shrink-0 border-b border-border-subtle">
          <span className="text-[11px] font-medium text-text-tertiary uppercase tracking-wider">
            {t('news.readerLabel')}
          </span>
          <button
            onClick={closeArticle}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer transition-colors"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {/* Article header */}
          <div className="px-5 pt-4">
            {showImage && (
              <div className="rounded-xl overflow-hidden mb-3.5 aspect-[16/9] bg-bg-elevated">
                <img
                  src={article.imageUrl ?? undefined}
                  alt=""
                  onError={() => setImgFailed(true)}
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <div className="flex items-center gap-2 text-[12px] mb-2">
              <span className="font-medium text-accent">{article.sourceName}</span>
              {time && (
                <>
                  <span className="text-text-tertiary/50">·</span>
                  <span className="text-text-tertiary">{time}</span>
                </>
              )}
            </div>
            <h1 className="text-[19px] font-semibold text-text-primary leading-snug">
              {article.title}
            </h1>
            {article.summary && (
              <p className="mt-2.5 text-[13px] text-text-secondary leading-relaxed">
                {article.summary}
              </p>
            )}
            <button
              onClick={() => window.cerebro.shell.openExternal(article.url)}
              className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline cursor-pointer"
            >
              {t('news.openOriginal')} <ExternalLink size={12} />
            </button>
          </div>

          <div className="mx-5 my-4 border-t border-border-subtle" />

          {/* Q&A */}
          <div className="px-5 pb-4 space-y-3">
            {isEmpty && (
              <div className="flex flex-col items-center text-center gap-2 py-4 px-2">
                <Sparkles size={20} className="text-accent" />
                <p className="text-[13px] font-medium text-text-secondary">{t('news.askTitle')}</p>
                <p className="text-[12px] text-text-tertiary leading-relaxed">
                  {t('news.askSubtitle')}
                </p>
                <div className="flex flex-wrap justify-center gap-1.5 mt-1.5">
                  {suggestions.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => void ask(s.label)}
                      disabled={isRunning}
                      className="px-2.5 py-1 rounded-full text-[12px] text-text-secondary bg-bg-elevated border border-border-subtle hover:border-border-accent hover:text-accent transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
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
                  {renderSources(m.sources)}
                </div>
              ),
            )}

            {/* In-flight answer */}
            {streaming && (
              <div className="max-w-full text-[13px] text-text-primary">
                {streaming.toolStatus && (
                  <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.06] text-accent px-2.5 py-1 text-[11px] font-medium">
                    {streaming.toolStatus === 'reading' ? (
                      <>
                        <FileText size={11} /> {t('news.readingArticle')}
                      </>
                    ) : (
                      <>
                        <Globe size={11} /> {t('news.searchingWeb')}
                      </>
                    )}
                  </div>
                )}
                {streaming.text ? (
                  <MarkdownContent content={streaming.text} />
                ) : (
                  !streaming.toolStatus && (
                    <div className="inline-flex items-center gap-2 text-text-secondary text-[12px]">
                      <Loader2 size={12} className="animate-spin" /> {t('news.thinking')}
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-border-subtle p-2.5 flex-shrink-0">
          <div className="flex items-end gap-2 rounded-xl border border-border-subtle bg-bg-base/60 px-2.5 py-1.5 focus-within:border-border-accent transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(input);
                }
              }}
              rows={1}
              placeholder={t('news.askPlaceholder')}
              className="flex-1 resize-none bg-transparent outline-none text-[13px] text-text-primary placeholder:text-text-tertiary max-h-32 py-1"
            />
            <button
              onClick={() => void ask(input)}
              disabled={!input.trim() || isRunning}
              className={clsx(
                'flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0 transition-colors',
                input.trim() && !isRunning
                  ? 'bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer'
                  : 'text-text-tertiary cursor-not-allowed',
              )}
              aria-label={t('news.askSend')}
            >
              {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
