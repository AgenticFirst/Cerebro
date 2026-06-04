import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  FileText,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
  Search,
  X,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragOverEvent,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  useKnowledgeBase,
  type KbTreeNode,
  type KbSearchHit,
} from '../../../context/KnowledgeBaseContext';
import { PageIcon } from './PageIcon';
import { TrashModal } from './TrashModal';
import { SearchResults } from './SearchResults';
import { computeDropTarget, findNode, positionAtPointer, type DropPosition } from './tree-dnd';

/** Live pointer Y from a dnd-kit event: activator pointer + accumulated delta. */
function pointerY(e: { activatorEvent: Event; delta: { y: number } }): number {
  const a = e.activatorEvent as PointerEvent | MouseEvent;
  return (typeof a?.clientY === 'number' ? a.clientY : 0) + e.delta.y;
}

interface DragInfo {
  activeDragId: string | null;
  overId: string | null;
  position: DropPosition | null;
}

/* ── Tree row ──────────────────────────────────────────────────── */

interface TreeRowProps {
  node: KbTreeNode;
  depth: number;
  activeId: string | null;
  expanded: Set<string>;
  drag: DragInfo;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
}

function TreeRow({
  node,
  depth,
  activeId,
  expanded,
  drag,
  onToggle,
  onSelect,
  onCreateChild,
  onRename,
  onArchive,
}: TreeRowProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { setNodeRef: setDropRef } = useDroppable({ id: node.id });
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging,
  } = useDraggable({ id: node.id });

  const isActive = activeId === node.id;
  const isOpen = expanded.has(node.id);
  const displayTitle = node.title.trim() || t('knowledgeBase.untitled');

  // Drop indicator for this row (only when it's the valid drop target).
  const indicator = drag.overId === node.id ? drag.position : null;

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const beginRename = () => {
    setMenuOpen(false);
    setDraft(node.title);
    setEditing(true);
  };
  const commitRename = () => {
    if (!editing) return;
    onRename(node.id, draft.trim());
    setEditing(false);
  };

  return (
    <div>
      <div
        ref={setDropRef}
        className={clsx('relative group/row', isDragging && 'opacity-40')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {/* Drop indicators */}
        {indicator === 'before' && (
          <div className="absolute left-1 right-1 -top-px h-0.5 rounded-full bg-accent z-10 pointer-events-none" />
        )}
        {indicator === 'after' && (
          <div className="absolute left-1 right-1 -bottom-px h-0.5 rounded-full bg-accent z-10 pointer-events-none" />
        )}
        {indicator === 'inside' && (
          <div className="absolute inset-x-0.5 inset-y-0 rounded-md ring-1 ring-accent/70 bg-accent/10 z-10 pointer-events-none" />
        )}

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            maxLength={200}
            className={clsx(
              'w-full px-2 py-[5px] my-px rounded-md text-[13px]',
              'bg-white/[0.06] text-text-primary',
              'border border-accent/40 outline-none',
            )}
          />
        ) : (
          <button
            ref={setDragRef}
            {...attributes}
            {...listeners}
            onClick={() => onSelect(node.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              beginRename();
            }}
            className={clsx(
              'w-full text-left flex items-center gap-1 pr-12 pl-1 py-[5px] my-px rounded-md text-[13px]',
              'transition-colors duration-150 cursor-pointer',
              isActive
                ? 'bg-white/[0.06] text-text-primary font-medium'
                : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.03]',
            )}
            title={displayTitle}
          >
            {/* Expand chevron — reserves space even when no children for alignment */}
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                if (node.hasChildren) onToggle(node.id);
              }}
              className={clsx(
                'flex items-center justify-center w-4 h-4 flex-shrink-0 rounded',
                node.hasChildren
                  ? 'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06]'
                  : 'opacity-0 pointer-events-none',
              )}
            >
              <ChevronRight
                size={12}
                className={clsx('transition-transform duration-150', isOpen && 'rotate-90')}
              />
            </span>

            <PageIcon icon={node.icon} />

            <span className="truncate">{displayTitle}</span>
          </button>
        )}

        {/* Hover actions */}
        {hovered && !editing && !drag.activeDragId && (
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCreateChild(node.id);
              }}
              className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
              title={t('knowledgeBase.newSubpage')}
              aria-label={t('knowledgeBase.newSubpage')}
            >
              <Plus size={13} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] transition-colors cursor-pointer"
              title={t('common.more')}
              aria-label="More actions"
            >
              <MoreHorizontal size={13} />
            </button>
          </div>
        )}

        {/* Context menu */}
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-1 top-7 z-50 min-w-[150px] rounded-lg border border-border-default bg-bg-elevated shadow-xl py-1">
              <button
                onClick={beginRename}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-text-secondary hover:text-text-primary hover:bg-white/[0.05] cursor-pointer"
              >
                <Pencil size={13} /> {t('knowledgeBase.rename')}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onArchive(node.id);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-text-secondary hover:text-red-400 hover:bg-red-400/10 cursor-pointer"
              >
                <Trash2 size={13} /> {t('knowledgeBase.moveToTrash')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Children */}
      {isOpen && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              expanded={expanded}
              drag={drag}
              onToggle={onToggle}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onRename={onRename}
              onArchive={onArchive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Sidebar ───────────────────────────────────────────────────── */

const NO_DRAG: DragInfo = { activeDragId: null, overId: null, position: null };

export default function PageTreeSidebar() {
  const { t } = useTranslation();
  const {
    tree,
    activePageId,
    loadTree,
    openPage,
    createPage,
    renamePage,
    archivePage,
    movePage,
    searchPages,
  } = useKnowledgeBase();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [trashOpen, setTrashOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KbSearchHit[]>([]);
  const [drag, setDrag] = useState<DragInfo>(NO_DRAG);
  const [collapsed, setCollapsed] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  // Debounced search: when the box is non-empty, fetch ranked hits.
  useEffect(() => {
    if (!trimmedQuery) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      void searchPages(trimmedQuery).then(setResults);
    }, 200);
    return () => clearTimeout(handle);
  }, [trimmedQuery, searchPages]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreateChild = async (parentId: string) => {
    setExpanded((prev) => new Set(prev).add(parentId));
    await createPage(parentId);
  };

  /* ── Drag-and-drop ── */
  const handleDragStart = (e: DragStartEvent) => {
    setDrag({ activeDragId: String(e.active.id), overId: null, position: null });
  };

  const handleDragOver = (e: DragOverEvent) => {
    const activeDragId = String(e.active.id);
    const over = e.over;
    const overId = over ? String(over.id) : null;
    const rawPosition =
      over && over.rect
        ? positionAtPointer(pointerY(e), over.rect.top, over.rect.height)
        : 'inside';
    // Only surface an indicator when the move is actually valid.
    const valid =
      overId !== null && computeDropTarget(tree, activeDragId, overId, rawPosition) !== null;
    const nextOverId = valid ? overId : null;
    const nextPosition = valid ? rawPosition : null;
    // Fires every pointer-move; skip the state update (and re-render) when the
    // resolved drop target hasn't changed.
    setDrag((d) =>
      d.activeDragId === activeDragId && d.overId === nextOverId && d.position === nextPosition
        ? d
        : { activeDragId, overId: nextOverId, position: nextPosition },
    );
  };

  const handleDragEnd = (e: DragEndEvent) => {
    setDrag(NO_DRAG);
    const over = e.over;
    if (!over) return;
    // Recompute the position from the drop event itself rather than reading
    // `drag.position` state (which can be one render stale at drop time).
    const activeDragId = String(e.active.id);
    const overId = String(over.id);
    const position: DropPosition = over.rect
      ? positionAtPointer(pointerY(e), over.rect.top, over.rect.height)
      : 'inside';
    const target = computeDropTarget(tree, activeDragId, overId, position);
    if (target) {
      if (position === 'inside') {
        setExpanded((prev) => new Set(prev).add(overId));
      }
      void movePage(activeDragId, target.parentId, target.sortOrder);
    }
  };

  // The dragged node, for the overlay label. Memoized so the tree walk runs
  // only when the drag target or tree changes — not on every pointer-move render.
  const draggedNode = useMemo(
    () => (drag.activeDragId ? findNode(tree, drag.activeDragId) : null),
    [drag.activeDragId, tree],
  );

  // Collapsed: a slim rail with expand + new-page, reclaiming editor width.
  if (collapsed) {
    return (
      <div className="w-11 flex-shrink-0 flex flex-col items-center border-r border-white/[0.06] bg-bg-surface h-full">
        <div className="app-drag-region h-11 w-full flex-shrink-0" />
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="mt-1 flex items-center justify-center w-9 h-9 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer transition-colors"
          title={t('knowledgeBase.expandPages')}
          aria-label={t('knowledgeBase.expandPages')}
        >
          <PanelLeftOpen size={16} />
        </button>
        <button
          type="button"
          onClick={() => void createPage(null)}
          className="mt-1 flex items-center justify-center w-9 h-9 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer transition-colors"
          title={t('knowledgeBase.newPage')}
          aria-label={t('knowledgeBase.newPage')}
        >
          <Plus size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-bg-surface h-full">
      {/* Draggable window strip (aligns content with the main nav sidebar) */}
      <div className="app-drag-region h-11 flex-shrink-0" />
      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary select-none">
          {t('knowledgeBase.pagesHeading')}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void createPage(null)}
            className={clsx(
              'flex items-center justify-center rounded-md p-1',
              'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06]',
              'transition-colors duration-150 cursor-pointer',
            )}
            title={t('knowledgeBase.newPage')}
            aria-label={t('knowledgeBase.newPage')}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className={clsx(
              'flex items-center justify-center rounded-md p-1',
              'text-text-tertiary hover:text-text-primary hover:bg-white/[0.06]',
              'transition-colors duration-150 cursor-pointer',
            )}
            title={t('knowledgeBase.collapsePages')}
            aria-label={t('knowledgeBase.collapsePages')}
          >
            <PanelLeftClose size={15} />
          </button>
        </div>
      </div>

      {/* Search box */}
      <div className="px-2.5 pb-2">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder={t('knowledgeBase.searchPlaceholder')}
            className={clsx(
              'w-full rounded-md bg-bg-base/60 border border-border-subtle',
              'pl-7 pr-7 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary',
              'outline-none focus:border-border-accent transition-colors',
            )}
          />
          {isSearching && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer"
              aria-label={t('common.dismiss')}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        {isSearching ? (
          <SearchResults
            hits={results}
            query={query.trim()}
            onOpen={(id) => {
              void openPage(id);
              setQuery('');
            }}
          />
        ) : tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center gap-2 px-4 py-10">
            <FileText size={20} className="text-text-tertiary" strokeWidth={1.5} />
            <p className="text-[12px] font-medium text-text-secondary">
              {t('knowledgeBase.emptyTreeTitle')}
            </p>
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              {t('knowledgeBase.emptyTreeSubtitle')}
            </p>
            <button
              type="button"
              onClick={() => void createPage(null)}
              className="mt-2 px-3 py-1.5 rounded-md text-[12px] font-medium bg-accent/10 hover:bg-accent/[0.18] border border-accent/20 text-text-primary cursor-pointer transition-colors"
            >
              {t('knowledgeBase.createFirstPage')}
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDrag(NO_DRAG)}
          >
            {tree.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                activeId={activePageId}
                expanded={expanded}
                drag={drag}
                onToggle={toggle}
                onSelect={(id) => void openPage(id)}
                onCreateChild={(id) => void handleCreateChild(id)}
                onRename={(id, title) => void renamePage(id, title)}
                onArchive={(id) => void archivePage(id)}
              />
            ))}
            <DragOverlay dropAnimation={null}>
              {draggedNode ? (
                <div className="flex items-center gap-1.5 px-2 py-[5px] rounded-md text-[13px] bg-bg-elevated border border-border-default shadow-xl text-text-primary">
                  <PageIcon icon={draggedNode.icon} />
                  <span className="truncate max-w-[180px]">
                    {draggedNode.title.trim() || t('knowledgeBase.untitled')}
                  </span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Footer: Trash */}
      <div className="px-2.5 py-2 border-t border-white/[0.04]">
        <button
          type="button"
          onClick={() => setTrashOpen(true)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-text-tertiary hover:text-text-secondary hover:bg-white/[0.03] cursor-pointer transition-colors"
        >
          <Trash2 size={14} />
          {t('knowledgeBase.trash')}
        </button>
      </div>

      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} />}
    </div>
  );
}
