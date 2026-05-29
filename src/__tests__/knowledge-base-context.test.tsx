import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  KnowledgeBaseProvider,
  useKnowledgeBase,
} from '../context/KnowledgeBaseContext';

/* Mock the IPC bridge the context calls. Each test sets `invoke`'s behaviour. */
const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  // Attach onto the existing jsdom window — do NOT replace it (RTL needs document).
  (window as unknown as { cerebro: { invoke: typeof invoke } }).cerebro = { invoke };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <KnowledgeBaseProvider>{children}</KnowledgeBaseProvider>
);

function ok<T>(data: T) {
  return { ok: true, status: 200, data };
}

describe('KnowledgeBaseContext', () => {
  it('loadTree maps snake_case tree into camelCase nodes', async () => {
    invoke.mockResolvedValueOnce(
      ok({
        pages: [
          {
            id: 'p1',
            parent_id: null,
            title: 'Root',
            icon: '📘',
            sort_order: 1,
            has_children: true,
            children: [
              { id: 'p2', parent_id: 'p1', title: 'Child', icon: null, sort_order: 1, has_children: false, children: [] },
            ],
          },
        ],
      }),
    );

    const { result } = renderHook(() => useKnowledgeBase(), { wrapper });
    await act(async () => {
      await result.current.loadTree();
    });

    expect(invoke).toHaveBeenCalledWith({ method: 'GET', path: '/knowledge/pages' });
    expect(result.current.tree).toHaveLength(1);
    expect(result.current.tree[0]).toMatchObject({ id: 'p1', icon: '📘', hasChildren: true });
    expect(result.current.tree[0].children[0]).toMatchObject({ id: 'p2', parentId: 'p1' });
  });

  it('createPage POSTs with parent_id and opens the new page', async () => {
    invoke
      .mockResolvedValueOnce(ok({ id: 'new1', parent_id: 'p1', title: '', icon: null, cover_url: null, content_json: null, content_markdown: null, sort_order: 2, is_archived: false }))
      .mockResolvedValueOnce(ok({ pages: [] })); // loadTree refetch

    const { result } = renderHook(() => useKnowledgeBase(), { wrapper });
    let createdId: string | null = null;
    await act(async () => {
      createdId = await result.current.createPage('p1');
    });

    expect(createdId).toBe('new1');
    expect(invoke).toHaveBeenCalledWith({
      method: 'POST',
      path: '/knowledge/pages',
      body: { parent_id: 'p1', title: '' },
    });
    expect(result.current.activePageId).toBe('new1');
  });

  it('renamePage PATCHes title and optimistically updates the tree', async () => {
    invoke.mockResolvedValueOnce(
      ok({
        pages: [
          { id: 'p1', parent_id: null, title: 'Old', icon: null, sort_order: 1, has_children: false, children: [] },
        ],
      }),
    );
    const { result } = renderHook(() => useKnowledgeBase(), { wrapper });
    await act(async () => {
      await result.current.loadTree();
    });

    invoke.mockResolvedValueOnce(ok({}));
    await act(async () => {
      await result.current.renamePage('p1', 'New Title');
    });

    expect(invoke).toHaveBeenLastCalledWith({
      method: 'PATCH',
      path: '/knowledge/pages/p1',
      body: { title: 'New Title' },
    });
    expect(result.current.tree[0].title).toBe('New Title');
  });

  it('savePageContent PATCHes both json and markdown', async () => {
    invoke.mockResolvedValueOnce(ok({}));
    const { result } = renderHook(() => useKnowledgeBase(), { wrapper });
    await act(async () => {
      await result.current.savePageContent('p1', '[{"x":1}]', '# Hi');
    });
    expect(invoke).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/knowledge/pages/p1',
      body: { content_json: '[{"x":1}]', content_markdown: '# Hi' },
    });
  });

  it('archivePage clears the active page and reloads the tree', async () => {
    // open p1 first
    invoke.mockResolvedValueOnce(ok({ id: 'p1', parent_id: null, title: 'X', icon: null, cover_url: null, content_json: null, content_markdown: null, sort_order: 1, is_archived: false }));
    const { result } = renderHook(() => useKnowledgeBase(), { wrapper });
    await act(async () => {
      await result.current.openPage('p1');
    });
    expect(result.current.activePageId).toBe('p1');

    invoke
      .mockResolvedValueOnce(ok({})) // PATCH is_archived
      .mockResolvedValueOnce(ok({ pages: [] })); // loadTree
    await act(async () => {
      await result.current.archivePage('p1');
    });

    expect(result.current.activePageId).toBeNull();
    expect(invoke).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/knowledge/pages/p1',
      body: { is_archived: true },
    });
  });
});
