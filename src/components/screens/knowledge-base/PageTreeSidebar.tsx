import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  FileText,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useKnowledgeBase, type KbTreeNode } from '../../../context/KnowledgeBaseContext';
import { EmojiGlyph } from './EmojiGlyph';
import { TrashModal } from './TrashModal';

/* ── Tree row ──────────────────────────────────────────────────── */

interface TreeRowProps {
  node: KbTreeNode;
  depth: number;
  activeId: string | null;
  expanded: Set<string>;
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

  const isActive = activeId === node.id;
  const isOpen = expanded.has(node.id);
  const displayTitle = node.title.trim() || t('knowledgeBase.untitled');

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
        className="relative group/row"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
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

            {/* Icon */}
            <span className="flex items-center justify-center w-4 h-4 flex-shrink-0 text-text-tertiary">
              {node.icon ? (
                <EmojiGlyph emoji={node.icon} size={14} />
              ) : (
                <FileText size={13} strokeWidth={1.5} />
              )}
            </span>

            <span className="truncate">{displayTitle}</span>
          </button>
        )}

        {/* Hover actions */}
        {hovered && !editing && (
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
              title={t('common.more') ?? 'More'}
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

export default function PageTreeSidebar() {
  const { t } = useTranslation();
  const { tree, activePageId, loadTree, openPage, createPage, renamePage, archivePage } =
    useKnowledgeBase();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [trashOpen, setTrashOpen] = useState(false);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

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

  return (
    <div className="w-64 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-bg-surface h-full">
      <div className="flex items-center justify-between px-3 pt-4 pb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary select-none">
          {t('knowledgeBase.pagesHeading')}
        </span>
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
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        {tree.length === 0 ? (
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
          tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              activeId={activePageId}
              expanded={expanded}
              onToggle={toggle}
              onSelect={(id) => void openPage(id)}
              onCreateChild={(id) => void handleCreateChild(id)}
              onRename={(id, title) => void renamePage(id, title)}
              onArchive={(id) => void archivePage(id)}
            />
          ))
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
