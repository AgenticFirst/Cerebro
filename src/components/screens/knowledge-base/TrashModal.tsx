import { useCallback, useEffect, useState } from 'react';
import { Trash2, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useKnowledgeBase, type KbTrashItem } from '../../../context/KnowledgeBaseContext';
import { PageIcon } from './PageIcon';

/**
 * Trash view for archived Knowledge Base pages. Restore puts a page (and its
 * subtree) back in the tree; permanent delete removes it for good.
 */
export function TrashModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { loadTrash, restorePage, deletePage } = useKnowledgeBase();
  const [items, setItems] = useState<KbTrashItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setItems(await loadTrash());
    setLoading(false);
  }, [loadTrash]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRestore = async (id: string) => {
    await restorePage(id);
    await refresh();
  };
  const handleDelete = async (id: string) => {
    await deletePage(id);
    await refresh();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-h-[70vh] flex flex-col rounded-xl border border-border-default bg-bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
            <Trash2 size={15} className="text-text-tertiary" />
            {t('knowledgeBase.trash')}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer"
            aria-label={t('common.dismiss')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
          {loading ? (
            <p className="text-center text-[12px] text-text-tertiary py-8">{t('common.loading')}</p>
          ) : items.length === 0 ? (
            <p className="text-center text-[12px] text-text-tertiary py-8">{t('knowledgeBase.trashEmpty')}</p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="group/trash flex items-center gap-2 px-2 py-2 rounded-md hover:bg-white/[0.03]"
              >
                <PageIcon icon={item.icon} />
                <span className="flex-1 truncate text-[13px] text-text-secondary">
                  {item.title.trim() || t('knowledgeBase.untitled')}
                </span>
                <button
                  onClick={() => void handleRestore(item.id)}
                  className="opacity-0 group-hover/trash:opacity-100 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary hover:text-text-primary hover:bg-white/[0.06] cursor-pointer transition"
                  title={t('knowledgeBase.restore')}
                >
                  <RotateCcw size={12} /> {t('knowledgeBase.restore')}
                </button>
                <button
                  onClick={() => void handleDelete(item.id)}
                  className="opacity-0 group-hover/trash:opacity-100 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary hover:text-red-400 hover:bg-red-400/10 cursor-pointer transition"
                  title={t('knowledgeBase.deletePermanently')}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
