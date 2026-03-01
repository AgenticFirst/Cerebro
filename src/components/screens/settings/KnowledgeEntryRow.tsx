import { Trash2 } from 'lucide-react';
import type { KnowledgeEntry } from '../../../types/memory';

interface KnowledgeEntryRowProps {
  entry: KnowledgeEntry;
  onDelete: (id: string) => void;
}

export default function KnowledgeEntryRow({ entry, onDelete }: KnowledgeEntryRowProps) {
  const date = new Date(entry.occurredAt);
  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="group flex items-start justify-between gap-3 py-2.5 px-3 rounded-md hover:bg-white/[0.03] transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[11px] text-text-tertiary">{dateStr}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium">
            {entry.entryType}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-text-tertiary">
            {entry.source}
          </span>
        </div>
        <p className="text-sm text-text-secondary leading-snug">
          &ldquo;{entry.summary}&rdquo;
        </p>
      </div>
      <button
        onClick={() => onDelete(entry.id)}
        className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-1 rounded text-text-tertiary
                   hover:text-red-400 hover:bg-red-400/10 transition-all cursor-pointer"
        title="Delete entry"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
