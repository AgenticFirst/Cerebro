import clsx from 'clsx';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileItem } from '../../../types/files';
import { formatBytes, formatRelative } from './utils';

interface FileListProps {
  items: FileItem[];
  selectedItemIds: Set<string>;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onOpen: (item: FileItem) => void;
  onContextMenu: (item: FileItem, e: React.MouseEvent) => void;
}

export default function FileList({ items, selectedItemIds, onSelect, onOpen, onContextMenu }: FileListProps) {
  const { t } = useTranslation();
  return (
    <div className="px-4 py-2">
      <div className="grid grid-cols-[1fr_80px_120px_120px] gap-3 px-3 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-text-tertiary">
        <span>{t('files.sortName')}</span>
        <span className="text-right">Size</span>
        <span>Created</span>
        <span>Updated</span>
      </div>
      <div className="space-y-px">
        {items.map((item) => {
          const isSelected = selectedItemIds.has(item.id);
          return (
            <button
              key={item.id}
              onClick={(e) => onSelect(item.id, e)}
              onDoubleClick={() => onOpen(item)}
              onContextMenu={(e) => onContextMenu(item, e)}
              className={clsx(
                'w-full grid grid-cols-[1fr_80px_120px_120px] gap-3 px-3 py-2 rounded-md text-left transition-colors cursor-pointer items-center',
                isSelected
                  ? 'bg-accent/10 text-text-primary'
                  : 'hover:bg-white/[0.03] text-text-secondary',
              )}
            >
              <span className="flex items-center gap-2 min-w-0">
                {item.starred && <Star size={11} className="text-amber-400 flex-shrink-0" fill="currentColor" />}
                <span className="text-[12px] truncate">{item.name}</span>
                <span className="text-[10px] uppercase font-mono text-text-tertiary flex-shrink-0">
                  {item.ext}
                </span>
              </span>
              <span className="text-[11px] text-text-tertiary text-right tabular-nums">
                {formatBytes(item.sizeBytes)}
              </span>
              <span className="text-[11px] text-text-tertiary">{formatRelative(item.createdAt)}</span>
              <span className="text-[11px] text-text-tertiary">{formatRelative(item.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
