import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';

/* ── Types ─────────────────────────────────────────────────────── */

export interface KbTreeNode {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  sortOrder: number;
  hasChildren: boolean;
  children: KbTreeNode[];
}

export interface KbPage {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverUrl: string | null;
  contentJson: string | null;
  contentMarkdown: string | null;
  sortOrder: number;
  isArchived: boolean;
}

export interface KbTrashItem {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
}

export interface KbSearchHit {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  /** Snippet with matched spans wrapped in \x01 (start) / \x02 (end) sentinels. */
  snippet: string;
}

/* ── API (snake_case) → app (camelCase) mappers ───────────────────── */

interface ApiTreeNode {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  sort_order: number;
  has_children: boolean;
  children: ApiTreeNode[];
}

interface ApiPage {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  cover_url: string | null;
  content_json: string | null;
  content_markdown: string | null;
  sort_order: number;
  is_archived: boolean;
}

function toNode(n: ApiTreeNode): KbTreeNode {
  return {
    id: n.id,
    parentId: n.parent_id,
    title: n.title,
    icon: n.icon,
    sortOrder: n.sort_order,
    hasChildren: n.has_children,
    children: (n.children ?? []).map(toNode),
  };
}

function toPage(p: ApiPage): KbPage {
  return {
    id: p.id,
    parentId: p.parent_id,
    title: p.title,
    icon: p.icon,
    coverUrl: p.cover_url,
    contentJson: p.content_json,
    contentMarkdown: p.content_markdown,
    sortOrder: p.sort_order,
    isArchived: p.is_archived,
  };
}

/* ── Context ───────────────────────────────────────────────────── */

interface KnowledgeBaseContextValue {
  tree: KbTreeNode[];
  activePageId: string | null;
  activePage: KbPage | null;
  isLoading: boolean;

  loadTree: () => Promise<void>;
  openPage: (id: string) => Promise<void>;
  createPage: (parentId?: string | null) => Promise<string | null>;
  renamePage: (id: string, title: string) => Promise<void>;
  setPageIcon: (id: string, icon: string | null) => Promise<void>;
  setPageCover: (id: string, coverUrl: string | null) => Promise<void>;
  movePage: (id: string, parentId: string | null, sortOrder: number) => Promise<void>;
  savePageContent: (id: string, contentJson: string, contentMarkdown: string) => Promise<void>;
  archivePage: (id: string) => Promise<void>;
  restorePage: (id: string) => Promise<void>;
  deletePage: (id: string) => Promise<void>;
  loadTrash: () => Promise<KbTrashItem[]>;
  searchPages: (q: string) => Promise<KbSearchHit[]>;
}

const KnowledgeBaseContext = createContext<KnowledgeBaseContextValue | null>(null);

/** Walk a tree, applying `fn` to the node with the given id (in place on a copy). */
function patchNode(nodes: KbTreeNode[], id: string, fn: (n: KbTreeNode) => KbTreeNode): KbTreeNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.children.length) return { ...n, children: patchNode(n.children, id, fn) };
    return n;
  });
}

export function KnowledgeBaseProvider({ children }: { children: ReactNode }) {
  const [tree, setTree] = useState<KbTreeNode[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<KbPage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadTree = useCallback(async () => {
    setIsLoading(true);
    try {
      const res: BackendResponse<{ pages: ApiTreeNode[] }> = await window.cerebro.invoke({
        method: 'GET',
        path: '/knowledge/pages',
      });
      if (res.ok) setTree(res.data.pages.map(toNode));
    } catch {
      /* backend not ready */
    } finally {
      setIsLoading(false);
    }
  }, []);

  const openPage = useCallback(async (id: string) => {
    setActivePageId(id);
    try {
      const res: BackendResponse<ApiPage> = await window.cerebro.invoke({
        method: 'GET',
        path: `/knowledge/pages/${id}`,
      });
      if (res.ok) setActivePage(toPage(res.data));
    } catch {
      /* ignore */
    }
  }, []);

  const createPage = useCallback(
    async (parentId: string | null = null): Promise<string | null> => {
      try {
        const res: BackendResponse<ApiPage> = await window.cerebro.invoke({
          method: 'POST',
          path: '/knowledge/pages',
          body: { parent_id: parentId, title: '' },
        });
        if (res.ok) {
          await loadTree();
          const page = toPage(res.data);
          setActivePageId(page.id);
          setActivePage(page);
          return page.id;
        }
      } catch {
        /* ignore */
      }
      return null;
    },
    [loadTree],
  );

  const renamePage = useCallback(async (id: string, title: string) => {
    // Optimistic: update tree + active page immediately.
    setTree((prev) => patchNode(prev, id, (n) => ({ ...n, title })));
    setActivePage((prev) => (prev && prev.id === id ? { ...prev, title } : prev));
    try {
      await window.cerebro.invoke({
        method: 'PATCH',
        path: `/knowledge/pages/${id}`,
        body: { title },
      });
    } catch {
      /* ignore */
    }
  }, []);

  const setPageIcon = useCallback(async (id: string, icon: string | null) => {
    setTree((prev) => patchNode(prev, id, (n) => ({ ...n, icon })));
    setActivePage((prev) => (prev && prev.id === id ? { ...prev, icon } : prev));
    try {
      await window.cerebro.invoke({
        method: 'PATCH',
        path: `/knowledge/pages/${id}`,
        body: { icon },
      });
    } catch {
      /* ignore */
    }
  }, []);

  const setPageCover = useCallback(async (id: string, coverUrl: string | null) => {
    setActivePage((prev) => (prev && prev.id === id ? { ...prev, coverUrl } : prev));
    try {
      await window.cerebro.invoke({
        method: 'PATCH',
        path: `/knowledge/pages/${id}`,
        body: { cover_url: coverUrl },
      });
    } catch {
      /* ignore */
    }
  }, []);

  const movePage = useCallback(
    async (id: string, parentId: string | null, sortOrder: number) => {
      try {
        await window.cerebro.invoke({
          method: 'POST',
          path: '/knowledge/pages/reorder',
          body: { items: [{ id, parent_id: parentId, sort_order: sortOrder }] },
        });
        await loadTree();
      } catch {
        /* ignore */
      }
    },
    [loadTree],
  );

  const savePageContent = useCallback(
    async (id: string, contentJson: string, contentMarkdown: string) => {
      try {
        await window.cerebro.invoke({
          method: 'PATCH',
          path: `/knowledge/pages/${id}`,
          body: { content_json: contentJson, content_markdown: contentMarkdown },
        });
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const archivePage = useCallback(
    async (id: string) => {
      try {
        await window.cerebro.invoke({
          method: 'PATCH',
          path: `/knowledge/pages/${id}`,
          body: { is_archived: true },
        });
      } catch {
        /* ignore */
      }
      if (activePageId === id) {
        setActivePageId(null);
        setActivePage(null);
      }
      await loadTree();
    },
    [activePageId, loadTree],
  );

  const restorePage = useCallback(
    async (id: string) => {
      try {
        await window.cerebro.invoke({
          method: 'PATCH',
          path: `/knowledge/pages/${id}`,
          body: { is_archived: false },
        });
      } catch {
        /* ignore */
      }
      await loadTree();
    },
    [loadTree],
  );

  const deletePage = useCallback(
    async (id: string) => {
      try {
        await window.cerebro.invoke({
          method: 'DELETE',
          path: `/knowledge/pages/${id}`,
        });
      } catch {
        /* ignore */
      }
      if (activePageId === id) {
        setActivePageId(null);
        setActivePage(null);
      }
      await loadTree();
    },
    [activePageId, loadTree],
  );

  const loadTrash = useCallback(async (): Promise<KbTrashItem[]> => {
    try {
      const res: BackendResponse<{ pages: Array<{ id: string; parent_id: string | null; title: string; icon: string | null }> }> =
        await window.cerebro.invoke({ method: 'GET', path: '/knowledge/trash' });
      if (res.ok) {
        return res.data.pages.map((p) => ({
          id: p.id,
          parentId: p.parent_id,
          title: p.title,
          icon: p.icon,
        }));
      }
    } catch {
      /* ignore */
    }
    return [];
  }, []);

  const searchPages = useCallback(async (q: string): Promise<KbSearchHit[]> => {
    const query = q.trim();
    if (!query) return [];
    try {
      const res: BackendResponse<{
        results: Array<{ id: string; parent_id: string | null; title: string; icon: string | null; snippet: string }>;
      }> = await window.cerebro.invoke({
        method: 'GET',
        path: `/knowledge/search?q=${encodeURIComponent(query)}`,
      });
      if (res.ok) {
        return res.data.results.map((r) => ({
          id: r.id,
          parentId: r.parent_id,
          title: r.title,
          icon: r.icon,
          snippet: r.snippet,
        }));
      }
    } catch {
      /* ignore */
    }
    return [];
  }, []);

  const value = useMemo<KnowledgeBaseContextValue>(
    () => ({
      tree,
      activePageId,
      activePage,
      isLoading,
      loadTree,
      openPage,
      createPage,
      renamePage,
      setPageIcon,
      setPageCover,
      movePage,
      savePageContent,
      archivePage,
      restorePage,
      deletePage,
      loadTrash,
      searchPages,
    }),
    [
      tree,
      activePageId,
      activePage,
      isLoading,
      loadTree,
      openPage,
      createPage,
      renamePage,
      setPageIcon,
      setPageCover,
      movePage,
      savePageContent,
      archivePage,
      restorePage,
      deletePage,
      loadTrash,
      searchPages,
    ],
  );

  return <KnowledgeBaseContext.Provider value={value}>{children}</KnowledgeBaseContext.Provider>;
}

export function useKnowledgeBase(): KnowledgeBaseContextValue {
  const ctx = useContext(KnowledgeBaseContext);
  if (!ctx) throw new Error('useKnowledgeBase must be used within KnowledgeBaseProvider');
  return ctx;
}
