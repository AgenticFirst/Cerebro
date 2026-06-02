import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Newspaper, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useNews } from '../../../context/NewsContext';
import { NEWS_CATEGORIES, relativeTime } from './news-api';
import NewsCard from './NewsCard';
import NewsCardSkeleton from './NewsCardSkeleton';
import NewsReaderPanel from './NewsReaderPanel';

export default function NewsScreen() {
  const { t } = useTranslation();
  const {
    activeCategory,
    articles,
    fetchedAt,
    stale,
    isLoading,
    loadError,
    selectedArticle,
    setActiveCategory,
    refresh,
    retry,
    openArticle,
  } = useNews();

  // Load the default tab once on first mount (no polling; the backend TTL is
  // the freshness guard). Switching tabs is handled by setActiveCategory.
  useEffect(() => {
    setActiveCategory(activeCategory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showSkeletons = isLoading && articles.length === 0;
  const updated = relativeTime(fetchedAt);

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-3 border-b border-border-subtle">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent/10">
            <Newspaper size={17} className="text-accent" />
          </div>
          <h1 className="text-lg font-semibold text-text-primary">{t('news.title')}</h1>
          {updated && !showSkeletons && (
            <span className="text-[11px] text-text-tertiary">
              {stale ? t('news.cachedHint') : t('news.updatedAgo', { time: updated })}
            </span>
          )}
          <button
            onClick={() => void refresh()}
            disabled={isLoading}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-accent bg-bg-surface/80 hover:bg-bg-hover border border-border-subtle rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
            title={t('news.refresh')}
          >
            <RefreshCw size={13} className={clsx(isLoading && 'animate-spin')} />
            {t('news.refresh')}
          </button>
        </div>

        {/* Category tabs */}
        <div className="flex items-center flex-wrap gap-1.5">
          {NEWS_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setActiveCategory(c)}
              className={clsx(
                'px-3 py-1 rounded-full text-[12px] font-medium transition-colors duration-150',
                activeCategory === c
                  ? 'bg-accent/15 text-accent border border-accent/30'
                  : 'bg-bg-surface/80 text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
              )}
            >
              {t(`news.tabs.${c}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {showSkeletons ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 p-6">
            {Array.from({ length: 9 }).map((_, i) => (
              <NewsCardSkeleton key={i} />
            ))}
          </div>
        ) : loadError && articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-red-500/30 flex items-center justify-center mb-4">
              <AlertCircle size={24} className="text-red-400" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1.5">{t('news.failedToLoad')}</h3>
            <button
              onClick={() => void retry()}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-lg transition-colors cursor-pointer"
            >
              <RefreshCw size={14} />
              {t('common.retry')}
            </button>
          </div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-border-default flex items-center justify-center mb-4">
              <Newspaper size={24} className="text-text-tertiary" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1.5">{t('news.empty')}</h3>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 p-6">
            {articles.map((a, i) => (
              <NewsCard
                key={a.id}
                article={a}
                index={i}
                isSelected={selectedArticle?.id === a.id}
                onClick={() => openArticle(a)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Reader / Q&A overlay */}
      {selectedArticle && <NewsReaderPanel />}
    </div>
  );
}
