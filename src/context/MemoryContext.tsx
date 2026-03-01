import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type {
  ContextFile,
  MemoryItem,
  MemoryScope,
  KnowledgeEntry,
  KnowledgeFilters,
} from '../types/memory';
import type { BackendResponse } from '../types/ipc';

interface MemoryContextValue {
  // State
  contextFiles: Record<string, ContextFile>;
  memoryItems: MemoryItem[];
  knowledgeEntries: KnowledgeEntry[];
  totalMemoryItems: number;
  totalKnowledgeEntries: number;
  isLoading: boolean;

  // Actions — Context Files
  loadContextFiles: () => Promise<void>;
  loadContextFile: (key: string) => Promise<void>;
  saveContextFile: (key: string, content: string) => Promise<void>;
  deleteContextFile: (key: string) => Promise<void>;

  // Actions — Learned Facts
  loadMemoryItems: (scope?: MemoryScope, search?: string, offset?: number) => Promise<void>;
  deleteMemoryItem: (id: string) => Promise<void>;

  // Actions — Knowledge Entries
  loadKnowledgeEntries: (filters?: KnowledgeFilters) => Promise<void>;
  deleteKnowledgeEntry: (id: string) => Promise<void>;

  // System prompt
  getSystemPrompt: (
    recentMessages: Array<{ role: string; content: string }>,
  ) => Promise<string | null>;

  // Extraction
  triggerExtraction: (
    conversationId: string | null,
    messages: Array<{ role: string; content: string }>,
  ) => void;
}

const MemoryContext = createContext<MemoryContextValue | null>(null);

// ── API response types ──────────────────────────────────────────

interface ApiContextFile {
  key: string;
  content: string;
  updated_at: string;
}

interface ApiMemoryItem {
  id: string;
  scope: string;
  scope_id: string | null;
  content: string;
  source_conversation_id: string | null;
  created_at: string;
}

interface ApiKnowledgeEntry {
  id: string;
  scope: string;
  scope_id: string | null;
  entry_type: string;
  occurred_at: string;
  summary: string;
  content: string;
  source: string;
  source_conversation_id: string | null;
  created_at: string;
}

function toContextFile(api: ApiContextFile): ContextFile {
  return { key: api.key, content: api.content, updatedAt: api.updated_at };
}

function toMemoryItem(api: ApiMemoryItem): MemoryItem {
  return {
    id: api.id,
    scope: api.scope as MemoryScope,
    scopeId: api.scope_id,
    content: api.content,
    sourceConversationId: api.source_conversation_id,
    createdAt: api.created_at,
  };
}

function toKnowledgeEntry(api: ApiKnowledgeEntry): KnowledgeEntry {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(api.content);
  } catch {
    // content may not be valid JSON
  }
  return {
    id: api.id,
    scope: api.scope as MemoryScope,
    scopeId: api.scope_id,
    entryType: api.entry_type,
    occurredAt: api.occurred_at,
    summary: api.summary,
    content: parsed,
    source: api.source,
    sourceConversationId: api.source_conversation_id,
    createdAt: api.created_at,
  };
}

export function MemoryProvider({ children }: { children: ReactNode }) {
  const [contextFiles, setContextFiles] = useState<Record<string, ContextFile>>({});
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([]);
  const [knowledgeEntries, setKnowledgeEntries] = useState<KnowledgeEntry[]>([]);
  const [totalMemoryItems, setTotalMemoryItems] = useState(0);
  const [totalKnowledgeEntries, setTotalKnowledgeEntries] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // ── Context Files ───────────────────────────────────────────

  const loadContextFiles = useCallback(async () => {
    try {
      const res: BackendResponse<ApiContextFile[]> = await window.cerebro.invoke({
        method: 'GET',
        path: '/memory/context-files',
      });
      if (res.ok) {
        const map: Record<string, ContextFile> = {};
        for (const f of res.data) {
          map[f.key] = toContextFile(f);
        }
        setContextFiles(map);
      }
    } catch {
      // Backend not ready
    }
  }, []);

  const loadContextFile = useCallback(async (key: string) => {
    try {
      const res: BackendResponse<ApiContextFile> = await window.cerebro.invoke({
        method: 'GET',
        path: `/memory/context-files/${key}`,
      });
      if (res.ok) {
        setContextFiles((prev) => ({ ...prev, [key]: toContextFile(res.data) }));
      }
    } catch {
      // Not found or backend not ready
    }
  }, []);

  const saveContextFile = useCallback(async (key: string, content: string) => {
    try {
      const res: BackendResponse<ApiContextFile> = await window.cerebro.invoke({
        method: 'PUT',
        path: `/memory/context-files/${key}`,
        body: { content },
      });
      if (res.ok) {
        setContextFiles((prev) => ({ ...prev, [key]: toContextFile(res.data) }));
      }
    } catch (e) {
      console.error('Failed to save context file:', e);
    }
  }, []);

  const deleteContextFile = useCallback(async (key: string) => {
    try {
      await window.cerebro.invoke({
        method: 'DELETE',
        path: `/memory/context-files/${key}`,
      });
      setContextFiles((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (e) {
      console.error('Failed to delete context file:', e);
    }
  }, []);

  // ── Learned Facts ───────────────────────────────────────────

  const loadMemoryItems = useCallback(
    async (scope: MemoryScope = 'personal', search?: string, offset = 0) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams({ scope, offset: String(offset), limit: '50' });
        if (search) params.set('search', search);
        const res: BackendResponse<{ items: ApiMemoryItem[]; total: number }> =
          await window.cerebro.invoke({
            method: 'GET',
            path: `/memory/items?${params}`,
          });
        if (res.ok) {
          setMemoryItems(res.data.items.map(toMemoryItem));
          setTotalMemoryItems(res.data.total);
        }
      } catch {
        // Backend not ready
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const deleteMemoryItem = useCallback(async (id: string) => {
    try {
      await window.cerebro.invoke({
        method: 'DELETE',
        path: `/memory/items/${id}`,
      });
      setMemoryItems((prev) => prev.filter((item) => item.id !== id));
      setTotalMemoryItems((prev) => Math.max(0, prev - 1));
    } catch (e) {
      console.error('Failed to delete memory item:', e);
    }
  }, []);

  // ── Knowledge Entries ───────────────────────────────────────

  const loadKnowledgeEntries = useCallback(async (filters?: KnowledgeFilters) => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        scope: filters?.scope ?? 'personal',
        offset: String(filters?.offset ?? 0),
        limit: String(filters?.limit ?? 50),
      });
      if (filters?.scopeId) params.set('scope_id', filters.scopeId);
      if (filters?.entryType) params.set('entry_type', filters.entryType);
      if (filters?.search) params.set('search', filters.search);

      const res: BackendResponse<{ entries: ApiKnowledgeEntry[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: `/memory/knowledge?${params}`,
        });
      if (res.ok) {
        setKnowledgeEntries(res.data.entries.map(toKnowledgeEntry));
        setTotalKnowledgeEntries(res.data.total);
      }
    } catch {
      // Backend not ready
    } finally {
      setIsLoading(false);
    }
  }, []);

  const deleteKnowledgeEntry = useCallback(async (id: string) => {
    try {
      await window.cerebro.invoke({
        method: 'DELETE',
        path: `/memory/knowledge/${id}`,
      });
      setKnowledgeEntries((prev) => prev.filter((e) => e.id !== id));
      setTotalKnowledgeEntries((prev) => Math.max(0, prev - 1));
    } catch (e) {
      console.error('Failed to delete knowledge entry:', e);
    }
  }, []);

  // ── System Prompt ───────────────────────────────────────────

  const getSystemPrompt = useCallback(
    async (
      recentMessages: Array<{ role: string; content: string }>,
    ): Promise<string | null> => {
      try {
        const res: BackendResponse<{ system_prompt: string }> =
          await window.cerebro.invoke({
            method: 'POST',
            path: '/memory/context',
            body: { messages: recentMessages },
          });
        if (res.ok && res.data.system_prompt) {
          return res.data.system_prompt;
        }
      } catch {
        // Memory is non-critical
      }
      return null;
    },
    [],
  );

  // ── Extraction (fire-and-forget) ────────────────────────────

  const triggerExtraction = useCallback(
    (
      conversationId: string | null,
      messages: Array<{ role: string; content: string }>,
    ) => {
      window.cerebro
        .invoke({
          method: 'POST',
          path: '/memory/extract',
          body: { conversation_id: conversationId, messages },
        })
        .catch(() => {});
    },
    [],
  );

  return (
    <MemoryContext.Provider
      value={{
        contextFiles,
        memoryItems,
        knowledgeEntries,
        totalMemoryItems,
        totalKnowledgeEntries,
        isLoading,
        loadContextFiles,
        loadContextFile,
        saveContextFile,
        deleteContextFile,
        loadMemoryItems,
        deleteMemoryItem,
        loadKnowledgeEntries,
        deleteKnowledgeEntry,
        getSystemPrompt,
        triggerExtraction,
      }}
    >
      {children}
    </MemoryContext.Provider>
  );
}

export function useMemory(): MemoryContextValue {
  const ctx = useContext(MemoryContext);
  if (!ctx) throw new Error('useMemory must be used within MemoryProvider');
  return ctx;
}
