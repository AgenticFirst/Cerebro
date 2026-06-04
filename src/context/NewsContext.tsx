import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useQualityTier } from './QualityContext';
import type { RendererAgentEvent } from '../types/ipc';
import {
  fetchNews,
  buildNewsAskPrompt,
  type NewsArticle,
  type NewsCategory,
  type NewsQaMessage,
} from '../components/screens/news/news-api';

/**
 * News feed cache + ephemeral per-article Q&A, lifted above the screen so an
 * in-flight answer survives the reader panel mounting/unmounting and category
 * switches. Deliberately does NOT poll — each category is fetched once on first
 * view (and on explicit refresh); the backend's stale-while-revalidate TTL is
 * the real freshness guard. Q&A is ephemeral: closing an article discards its
 * conversation (no persistence).
 */

type ToolStatus = 'reading' | 'searching' | null;

interface CategoryState {
  articles: NewsArticle[];
  fetchedAt: string | null;
  stale: boolean;
}

interface Streaming {
  text: string;
  toolStatus: ToolStatus;
  sources: string[];
}

interface NewsContextValue {
  activeCategory: NewsCategory;
  articles: NewsArticle[];
  fetchedAt: string | null;
  stale: boolean;
  isLoading: boolean;
  loadError: boolean;

  selectedArticle: NewsArticle | null;
  messages: NewsQaMessage[];
  input: string;
  streaming: Streaming | null;
  isRunning: boolean;

  setActiveCategory: (c: NewsCategory) => void;
  refresh: () => Promise<void>;
  retry: () => Promise<void>;
  openArticle: (a: NewsArticle) => void;
  closeArticle: () => void;
  setInput: (v: string) => void;
  ask: (question: string) => Promise<void>;
}

const NewsContext = createContext<NewsContextValue | null>(null);

export function NewsProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { tier, model } = useQualityTier();

  const [activeCategory, setActiveCategoryState] = useState<NewsCategory>('top');
  const [cache, setCache] = useState<Record<string, CategoryState>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Categories we've already fetched this session — so switching tabs back and
  // forth never re-hits the network (no polling, ever).
  const loadedRef = useRef<Set<string>>(new Set());

  const [selectedArticle, setSelectedArticle] = useState<NewsArticle | null>(null);
  const [messages, setMessages] = useState<NewsQaMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<Streaming | null>(null);

  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const isRunning = streaming !== null;

  const current = cache[activeCategory];

  const load = useCallback(async (category: NewsCategory, force: boolean) => {
    if (!force && loadedRef.current.has(category)) return;
    setIsLoading(true);
    setLoadError(false);
    const feed = await fetchNews(category, force);
    if (feed) {
      loadedRef.current.add(category);
      setCache((prev) => ({
        ...prev,
        [category]: { articles: feed.articles, fetchedAt: feed.fetchedAt, stale: feed.stale },
      }));
    } else if (!loadedRef.current.has(category)) {
      setLoadError(true);
    }
    setIsLoading(false);
  }, []);

  const setActiveCategory = useCallback(
    (c: NewsCategory) => {
      setActiveCategoryState(c);
      void load(c, false);
    },
    [load],
  );

  const refresh = useCallback(() => load(activeCategory, true), [load, activeCategory]);
  const retry = useCallback(() => load(activeCategory, false), [load, activeCategory]);

  const closeArticle = useCallback(() => {
    // Abort any in-flight run and discard the ephemeral conversation.
    if (runIdRef.current) {
      void window.cerebro.agent.cancelAssistant(runIdRef.current).catch(() => {});
    }
    unsubRef.current?.();
    unsubRef.current = null;
    runIdRef.current = null;
    setSelectedArticle(null);
    setMessages([]);
    setInput('');
    setStreaming(null);
  }, []);

  const openArticle = useCallback(
    (a: NewsArticle) => {
      if (selectedArticle?.id === a.id) return;
      // Switching articles starts a fresh ephemeral thread.
      if (runIdRef.current) {
        void window.cerebro.agent.cancelAssistant(runIdRef.current).catch(() => {});
      }
      unsubRef.current?.();
      unsubRef.current = null;
      runIdRef.current = null;
      setSelectedArticle(a);
      setMessages([]);
      setInput('');
      setStreaming(null);
    },
    [selectedArticle?.id],
  );

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      const article = selectedArticle;
      if (!question || isRunning || !article) return;
      setInput('');

      const history = messages;
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: question }]);

      const prompt = buildNewsAskPrompt(article, history, question);
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      const sources: string[] = [article.url];
      setStreaming({ text: '', toolStatus: null, sources: [...sources] });

      const finalize = (assistantText: string) => {
        unsubRef.current?.();
        unsubRef.current = null;
        runIdRef.current = null;
        setStreaming(null);
        if (assistantText.trim()) {
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: 'assistant',
              content: assistantText,
              sources: [...sources],
            },
          ]);
        }
      };

      let acc = '';
      unsubRef.current = window.cerebro.agent.onEvent(runId, (event: RendererAgentEvent) => {
        switch (event.type) {
          case 'text_delta':
            acc += event.delta;
            setStreaming((s) => (s ? { ...s, text: acc } : s));
            break;
          case 'tool_start': {
            if (event.toolName === 'WebFetch') {
              const url = extractUrl(event.args);
              if (url && !sources.includes(url)) sources.push(url);
              setStreaming((s) => (s ? { ...s, toolStatus: 'reading', sources: [...sources] } : s));
            } else if (event.toolName === 'WebSearch') {
              setStreaming((s) => (s ? { ...s, toolStatus: 'searching' } : s));
            }
            break;
          }
          case 'tool_end':
            setStreaming((s) => (s ? { ...s, toolStatus: null } : s));
            break;
          case 'done':
            finalize(event.messageContent || acc);
            break;
          case 'error': {
            unsubRef.current?.();
            unsubRef.current = null;
            runIdRef.current = null;
            setStreaming(null);
            const detail = event.error?.trim() || t('news.askError');
            setMessages((prev) => [
              ...prev,
              { id: `e-${Date.now()}`, role: 'assistant', content: `⚠️ ${detail}` },
            ]);
            break;
          }
          default:
            break;
        }
      });

      try {
        await window.cerebro.agent.runAssistant({
          runId,
          prompt,
          model,
          qualityTier: tier,
          language: i18n.language !== 'en' ? i18n.language : undefined,
        });
      } catch {
        finalize('');
      }
    },
    [selectedArticle, isRunning, messages, model, tier, i18n.language, t],
  );

  const value = useMemo<NewsContextValue>(
    () => ({
      activeCategory,
      articles: current?.articles ?? [],
      fetchedAt: current?.fetchedAt ?? null,
      stale: current?.stale ?? false,
      isLoading,
      loadError,
      selectedArticle,
      messages,
      input,
      streaming,
      isRunning,
      setActiveCategory,
      refresh,
      retry,
      openArticle,
      closeArticle,
      setInput,
      ask,
    }),
    [
      activeCategory,
      current,
      isLoading,
      loadError,
      selectedArticle,
      messages,
      input,
      streaming,
      isRunning,
      setActiveCategory,
      refresh,
      retry,
      openArticle,
      closeArticle,
      ask,
    ],
  );

  return <NewsContext.Provider value={value}>{children}</NewsContext.Provider>;
}

function extractUrl(args: unknown): string | null {
  if (args && typeof args === 'object' && 'url' in args) {
    const url = (args as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return null;
}

export function useNews(): NewsContextValue {
  const ctx = useContext(NewsContext);
  if (!ctx) throw new Error('useNews must be used within NewsProvider');
  return ctx;
}
