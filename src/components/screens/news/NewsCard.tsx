import { useState } from 'react';
import clsx from 'clsx';
import type { NewsArticle } from './news-api';
import { relativeTime } from './news-api';

interface NewsCardProps {
  article: NewsArticle;
  index: number;
  isSelected: boolean;
  onClick: () => void;
}

// Deterministic gradient per source so the broken-image fallback still looks
// intentional rather than empty.
const GRADIENTS = [
  'from-cyan-500/25 to-blue-600/25',
  'from-violet-500/25 to-fuchsia-600/25',
  'from-amber-500/25 to-orange-600/25',
  'from-emerald-500/25 to-teal-600/25',
  'from-rose-500/25 to-pink-600/25',
];

function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return GRADIENTS[h % GRADIENTS.length];
}

export default function NewsCard({ article, index, isSelected, onClick }: NewsCardProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = article.imageUrl && !imgFailed;
  const time = relativeTime(article.publishedAt);

  return (
    <button
      onClick={onClick}
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
      className={clsx(
        'group text-left rounded-xl border bg-bg-surface overflow-hidden animate-card-in',
        'transition-all duration-150 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 cursor-pointer',
        isSelected ? 'border-border-accent' : 'border-border-subtle hover:border-border-default',
      )}
    >
      {/* Image / fallback */}
      <div className="relative aspect-[16/9] overflow-hidden bg-bg-elevated">
        {showImage ? (
          <img
            src={article.imageUrl ?? undefined}
            alt=""
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <div className={clsx('w-full h-full bg-gradient-to-br flex items-center justify-center', gradientFor(article.sourceName))}>
            <span className="text-2xl font-semibold text-text-primary/70">
              {article.sourceName.charAt(0)}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-3.5">
        <div className="flex items-center gap-2 mb-1.5 text-[11px]">
          <span className="font-medium text-accent truncate">{article.sourceName}</span>
          {time && (
            <>
              <span className="text-text-tertiary/50">·</span>
              <span className="text-text-tertiary flex-shrink-0">{time}</span>
            </>
          )}
        </div>
        <h3 className="text-[14px] font-semibold text-text-primary leading-snug line-clamp-2 group-hover:text-accent transition-colors">
          {article.title}
        </h3>
        {article.summary && (
          <p className="mt-1.5 text-[12px] text-text-secondary leading-relaxed line-clamp-3">
            {article.summary}
          </p>
        )}
      </div>
    </button>
  );
}
