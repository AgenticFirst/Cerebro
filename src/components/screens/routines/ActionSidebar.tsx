import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Search, Plus } from 'lucide-react';
import {
  ACTION_META,
  ACTION_CATEGORIES,
  type ActionMeta,
  type ActionCategory,
} from '../../../utils/step-defaults';
import ActionCategoryGroup from './ActionCategoryGroup';
import Tooltip from '../../ui/Tooltip';

interface ActionSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
}

export default function ActionSidebar({ isOpen, onClose, onOpen }: ActionSidebarProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Focus search when opening; reset when closing
  useEffect(() => {
    if (isOpen) {
      searchRef.current?.focus();
    } else {
      setSearch('');
    }
  }, [isOpen]);

  const filteredCategories = useMemo(() => {
    const query = search.toLowerCase().trim();

    return ACTION_CATEGORIES.map((category) => {
      const matches = Object.entries(ACTION_META).filter(([, meta]) => {
        if (meta.category !== category.id) return false;
        // Don't show triggers in sidebar — they're managed via toolbar
        if (meta.category === 'triggers') return false;
        if (!query) return true;
        return (
          meta.name.toLowerCase().includes(query) ||
          meta.description.toLowerCase().includes(query) ||
          meta.keywords.some((kw) => kw.includes(query))
        );
      });
      const actions = [
        ...matches.filter(([, meta]) => meta.isAvailable),
        ...matches.filter(([, meta]) => !meta.isAvailable),
      ];
      return { category, actions } as { category: ActionCategory; actions: [string, ActionMeta][] };
    }).filter((group) => group.actions.length > 0);
  }, [search]);

  return (
    <>
      {/* Floating "Add Action" pill — visible when sidebar is closed */}
      {!isOpen && (
        <div className="absolute bottom-4 left-4 z-20">
          <Tooltip label={t('routineTooltips.addAction')} side="right">
            <button
              onClick={onOpen}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-bg-surface border border-border-subtle text-text-secondary hover:text-accent hover:border-accent/30 transition-colors shadow-lg"
              aria-label={t('routineTooltips.addAction')}
            >
              <Plus size={16} />
              <span className="text-sm font-medium">Add Action</span>
            </button>
          </Tooltip>
        </div>
      )}

      {/* Sidebar panel — always in DOM, revealed via clip-path (no translateX).
          clip-path is a paint-level op: it cannot affect layout or scroll geometry. */}
      <div
        style={{
          clipPath: isOpen ? 'inset(0 0 0 0)' : 'inset(0 0 0 100%)',
          transition: 'clip-path 0.2s ease-out',
        }}
        className={`absolute top-0 right-0 bottom-0 w-[320px] z-20 bg-bg-surface border-l border-border-subtle shadow-xl flex flex-col ${!isOpen ? 'pointer-events-none' : ''}`}
        aria-hidden={!isOpen}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-sm font-semibold text-text-primary">Add Action</span>
          <Tooltip label={t('routineTooltips.closeSidebar')} shortcut="Esc">
            <button
              onClick={onClose}
              aria-label={t('routineTooltips.closeSidebar')}
              className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <X size={14} />
            </button>
          </Tooltip>
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-border-subtle">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <Tooltip label={t('routineTooltips.searchActions')} side="bottom">
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full h-8 pl-8 pr-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
                tabIndex={isOpen ? 0 : -1}
              />
            </Tooltip>
          </div>
        </div>

        {/* Category groups */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredCategories.length > 0 ? (
            filteredCategories.map(({ category, actions }) => (
              <ActionCategoryGroup
                key={category.id}
                category={category}
                actions={actions}
              />
            ))
          ) : (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-text-tertiary">No actions match &ldquo;{search}&rdquo;</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
