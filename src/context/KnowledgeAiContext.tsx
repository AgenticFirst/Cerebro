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
import { useKnowledgeBase, type KbPage } from './KnowledgeBaseContext';
import type { RendererAgentEvent } from '../types/ipc';
import {
  listThreads,
  createThread,
  deleteThread,
  listMessages,
  appendMessage,
  fetchPageContent,
  buildAskPrompt,
  deriveThreadTitle,
  type KbAiThread,
  type KbAiMessage,
} from '../components/screens/knowledge-base/knowledge-ai-api';

/**
 * Per-page "Ask AI" assistant state, lifted out of the panel so a run survives
 * page switches and panel collapse (the panel UI mounts/unmounts; the run, its
 * event subscription, and persistence live here). The provider sits above the
 * Knowledge Base screen so navigating the tree — or collapsing the panel —
 * never aborts an in-flight answer.
 */

interface AnchorPage {
  id: string;
  title: string;
  contentMarkdown: string;
}

interface Streaming {
  text: string;
  searching: boolean;
}

interface KnowledgeAiContextValue {
  isOpen: boolean;
  isCollapsed: boolean;
  anchor: AnchorPage | null;
  threads: KbAiThread[];
  threadId: string | null;
  messages: KbAiMessage[];
  input: string;
  streaming: Streaming | null;
  isRunning: boolean;

  setInput: (v: string) => void;
  openForPage: (page: KbPage) => void;
  close: () => void;
  collapse: () => void;
  expand: () => void;
  openThread: (id: string) => Promise<void>;
  startNewThread: () => void;
  removeThread: (id: string) => Promise<void>;
  send: () => Promise<void>;
}

const KnowledgeAiContext = createContext<KnowledgeAiContextValue | null>(null);

export function KnowledgeAiProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { tier, model } = useQualityTier();
  const { loadTree, openPage, activePageId } = useKnowledgeBase();

  const [isOpen, setIsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [anchor, setAnchor] = useState<AnchorPage | null>(null);
  const [threads, setThreads] = useState<KbAiThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<KbAiMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<Streaming | null>(null);

  const runIdRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const isRunning = streaming !== null;

  const loadThreadsFor = useCallback(async (pageId: string) => {
    const ts = await listThreads(pageId);
    setThreads(ts);
    if (ts.length > 0) {
      setThreadId(ts[0].id);
      setMessages(await listMessages(ts[0].id));
    } else {
      setThreadId(null);
      setMessages([]);
    }
  }, []);

  const openForPage = useCallback(
    (page: KbPage) => {
      setIsOpen(true);
      setIsCollapsed(false);
      const next: AnchorPage = {
        id: page.id,
        title: page.title,
        contentMarkdown: page.contentMarkdown ?? '',
      };
      // Don't disrupt an in-flight run; just reveal it. Re-anchor only when idle
      // and the user opened the panel on a different page than it's bound to.
      if (runIdRef.current) return;
      if (anchor?.id === page.id) {
        setAnchor(next); // refresh title/content for the same page
        return;
      }
      setAnchor(next);
      void loadThreadsFor(page.id);
    },
    [anchor?.id, loadThreadsFor],
  );

  const close = useCallback(() => setIsOpen(false), []);
  const collapse = useCallback(() => setIsCollapsed(true), []);
  const expand = useCallback(() => setIsCollapsed(false), []);

  const openThread = useCallback(async (id: string) => {
    setThreadId(id);
    setMessages(await listMessages(id));
  }, []);

  const startNewThread = useCallback(() => {
    setThreadId(null);
    setMessages([]);
  }, []);

  const removeThread = useCallback(
    async (id: string) => {
      await deleteThread(id);
      setThreads((prev) => {
        const remaining = prev.filter((th) => th.id !== id);
        if (threadId === id) {
          if (remaining.length > 0) void openThread(remaining[0].id);
          else startNewThread();
        }
        return remaining;
      });
    },
    [threadId, openThread, startNewThread],
  );

  const send = useCallback(async () => {
    const question = input.trim();
    const page = anchor;
    if (!question || isRunning || !page) return;
    setInput('');

    // Ensure a thread exists (created lazily on the first message).
    let resolved = threadId;
    if (!resolved) {
      const created = await createThread(page.id, deriveThreadTitle(question));
      if (!created) return;
      resolved = created.id;
      setThreadId(resolved);
      setThreads((prev) => [created, ...prev]);
    }
    const tid: string = resolved;

    const history = messages;
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, threadId: tid, role: 'user', content: question },
    ]);
    void appendMessage(tid, 'user', question);

    // Pull the freshest persisted content (in-editor autosave may be ahead of
    // the KB context copy) so the assistant answers about what's actually there.
    const fresh = await fetchPageContent(page.id, page.title, page.contentMarkdown);
    const prompt = buildAskPrompt(fresh.title, fresh.markdown, history, question);
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setStreaming({ text: '', searching: false });

    const finalize = (assistantText: string) => {
      unsubRef.current?.();
      unsubRef.current = null;
      runIdRef.current = null;
      setStreaming(null);
      if (assistantText.trim()) {
        setMessages((prev) => [
          ...prev,
          { id: `local-a-${Date.now()}`, threadId: tid, role: 'assistant', content: assistantText },
        ]);
        void appendMessage(tid, 'assistant', assistantText);
      }
      // The assistant may have created/edited pages via its tools — refresh the
      // tree so new pages appear, and reload the open page so the editor picks
      // up content changes (its key includes a content signature).
      void loadTree();
      if (activePageId) void openPage(activePageId);
    };

    let acc = '';
    unsubRef.current = window.cerebro.agent.onEvent(runId, (event: RendererAgentEvent) => {
      switch (event.type) {
        case 'text_delta':
          acc += event.delta;
          setStreaming((s) => (s ? { ...s, text: acc } : s));
          break;
        case 'tool_start':
          if (event.toolName === 'WebSearch' || event.toolName === 'WebFetch') {
            setStreaming((s) => (s ? { ...s, searching: true } : s));
          }
          break;
        case 'tool_end':
          setStreaming((s) => (s ? { ...s, searching: false } : s));
          break;
        case 'done':
          finalize(event.messageContent || acc);
          break;
        case 'error': {
          unsubRef.current?.();
          unsubRef.current = null;
          runIdRef.current = null;
          setStreaming(null);
          const detail = event.error?.trim() || t('knowledgeBase.askAiError');
          setMessages((prev) => [
            ...prev,
            {
              id: `local-e-${Date.now()}`,
              threadId: tid,
              role: 'assistant',
              content: `⚠️ ${detail}`,
            },
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
  }, [
    input,
    anchor,
    isRunning,
    threadId,
    messages,
    model,
    tier,
    i18n.language,
    t,
    loadTree,
    openPage,
    activePageId,
  ]);

  const value = useMemo<KnowledgeAiContextValue>(
    () => ({
      isOpen,
      isCollapsed,
      anchor,
      threads,
      threadId,
      messages,
      input,
      streaming,
      isRunning,
      setInput,
      openForPage,
      close,
      collapse,
      expand,
      openThread,
      startNewThread,
      removeThread,
      send,
    }),
    [
      isOpen,
      isCollapsed,
      anchor,
      threads,
      threadId,
      messages,
      input,
      streaming,
      isRunning,
      openForPage,
      close,
      collapse,
      expand,
      openThread,
      startNewThread,
      removeThread,
      send,
    ],
  );

  return <KnowledgeAiContext.Provider value={value}>{children}</KnowledgeAiContext.Provider>;
}

export function useKnowledgeAi(): KnowledgeAiContextValue {
  const ctx = useContext(KnowledgeAiContext);
  if (!ctx) throw new Error('useKnowledgeAi must be used within KnowledgeAiProvider');
  return ctx;
}
