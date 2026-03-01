import { Trash2 } from 'lucide-react';
import type { MemoryItem } from '../../../types/memory';

interface MemoryItemRowProps {
  item: MemoryItem;
  onDelete: (id: string) => void;
}

export default function MemoryItemRow({ item, onDelete }: MemoryItemRowProps) {
  const date = new Date(item.createdAt);
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="group flex items-start justify-between gap-3 py-2.5 px-3 rounded-md hover:bg-white/[0.03] transition-colors">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-secondary leading-snug">
          &ldquo;{item.content}&rdquo;
        </p>
        <p className="text-[11px] text-text-tertiary mt-1">
          {dateStr}
        </p>
      </div>
      <button
        onClick={() => onDelete(item.id)}
        className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded text-text-tertiary
                   hover:text-red-400 hover:bg-red-400/10 transition-all cursor-pointer"
        title="Delete fact"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
