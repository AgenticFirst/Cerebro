import type { BackendResponse } from '../../../types/ipc';
import type { TFunction } from 'i18next';

/* ── Types ─────────────────────────────────────────────────────── */

export type NewsCategory =
  | 'top'
  | 'world'
  | 'tech'
  | 'business'
  | 'science'
  | 'sports'
  | 'entertainment'
  | 'health';

export const NEWS_CATEGORIES: NewsCategory[] = [
  'top',
  'world',
  'tech',
  'business',
  'science',
  'sports',
  'entertainment',
  'health',
];

export interface NewsArticle {
  id: string;
  feedId: string;
  sourceName: string;
  title: string;
  url: string;
  summary: string | null;
  imageUrl: string | null;
  category: string | null;
  publishedAt: string | null;
}

export interface NewsFeed {
  articles: NewsArticle[];
  fetchedAt: string | null;
  stale: boolean;
  category: string;
  count: number;
}

/** One Q&A turn in an article's ephemeral conversation. */
export interface NewsQaMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** URLs the assistant fetched while answering (assistant turns only). */
  sources?: string[];
}

interface ApiArticle {
  id: string;
  feed_id: string;
  source_name: string;
  title: string;
  url: string;
  summary: string | null;
  image_url: string | null;
  category: string | null;
  published_at: string | null;
}

interface ApiFeed {
  articles: ApiArticle[];
  fetched_at: string | null;
  stale: boolean;
  category: string;
  count: number;
}

const toArticle = (a: ApiArticle): NewsArticle => ({
  id: a.id,
  feedId: a.feed_id,
  sourceName: a.source_name,
  title: a.title,
  url: a.url,
  summary: a.summary,
  imageUrl: a.image_url,
  category: a.category,
  publishedAt: a.published_at,
});

/* ── Fetch (wraps window.cerebro.invoke against /news) ───────────── */

export async function fetchNews(category: NewsCategory, refresh = false): Promise<NewsFeed | null> {
  try {
    const params = new URLSearchParams({ category });
    if (refresh) params.set('refresh', 'true');
    const res: BackendResponse<ApiFeed> = await window.cerebro.invoke({
      method: 'GET',
      path: `/news?${params.toString()}`,
    });
    if (res.ok) {
      return {
        articles: res.data.articles.map(toArticle),
        fetchedAt: res.data.fetched_at,
        stale: res.data.stale,
        category: res.data.category,
        count: res.data.count,
      };
    }
  } catch {
    /* fall through to null — caller surfaces an error state */
  }
  return null;
}

/* ── Prompt building ─────────────────────────────────────────────── */

/**
 * Build the one-off prompt for an article Q&A run. We hand the model the story
 * metadata + RSS summary and instruct it to WebFetch the full article (and
 * WebSearch for context) before answering with inline citations — so we never
 * scrape article HTML ourselves.
 */
export function buildNewsAskPrompt(
  article: NewsArticle,
  history: NewsQaMessage[],
  question: string,
): string {
  const lines: string[] = [
    'You are a news research assistant answering a question about ONE news story.',
    'First, use your WebFetch tool to read the full article at the URL below.',
    'Then, if useful, use WebSearch to gather related context and corroborating',
    'sources. Answer concisely and ground every claim in what you read. Cite',
    'sources inline as markdown links. If the article is paywalled or WebFetch',
    'fails, say so briefly and answer from the summary plus a WebSearch instead.',
    'Do not create tasks, experts, or routines.',
    '',
    '# Story',
    `Source: ${article.sourceName}`,
    `Title: ${article.title}`,
    `URL: ${article.url}`,
  ];
  if (article.publishedAt) lines.push(`Published: ${article.publishedAt}`);
  lines.push('', '# RSS summary (may be partial)', '', article.summary?.trim() || '(no summary provided)');
  if (history.length > 0) {
    lines.push('', '# Conversation so far');
    for (const m of history) {
      lines.push('', `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
    }
  }
  lines.push('', '# Question', '', question.trim());
  return lines.join('\n');
}

/** Static starter questions shown as chips before the user types. */
export function deriveSuggestedQuestions(t: TFunction): { key: string; label: string }[] {
  return [
    { key: 'summarize', label: t('news.suggested.summarize') },
    { key: 'whyMatters', label: t('news.suggested.whyMatters') },
    { key: 'background', label: t('news.suggested.background') },
    { key: 'people', label: t('news.suggested.people') },
  ];
}

/* ── Formatting ──────────────────────────────────────────────────── */

/** Compact relative time, e.g. "12m", "3h", "2d". Falls back to '' if unknown. */
export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
