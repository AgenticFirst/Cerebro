import { useState, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useMemory } from '../../../context/MemoryContext';
import MemoryItemRow from './MemoryItemRow';

export default function MemoryItemsList() {
  const { memoryItems, totalMemoryItems, loadMemoryItems, deleteMemoryItem, isLoading } =
    useMemory();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      setOffset(0);
      loadMemoryItems('personal', value || undefined, 0);
    },
    [loadMemoryItems],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteMemoryItem(id);
    },
    [deleteMemoryItem],
  );

  const handleLoadMore = useCallback(() => {
    const newOffset = offset + 50;
    setOffset(newOffset);
    loadMemoryItems('personal', search || undefined, newOffset);
  }, [offset, search, loadMemoryItems]);

  if (totalMemoryItems === 0 && !search) {
    return (
      <p className="text-sm text-text-tertiary py-4">
        No learned facts yet. Cerebro will automatically extract facts from your conversations.
      </p>
    );
  }

  return (
    <div>
      {/* Search */}
      <div className="relative mb-3">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search facts..."
          className="w-full bg-bg-base border border-border-subtle rounded-md pl-9 pr-3 py-2
                     text-sm text-text-secondary placeholder:text-text-tertiary/50
                     focus:outline-none focus:border-accent/40 transition-colors"
        />
      </div>

      {/* List */}
      <div className="space-y-px">
        {memoryItems.map((item) => (
          <MemoryItemRow key={item.id} item={item} onDelete={handleDelete} />
        ))}
      </div>

      {/* Load more */}
      {memoryItems.length < totalMemoryItems && (
        <button
          onClick={handleLoadMore}
          disabled={isLoading}
          className="mt-3 text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer disabled:opacity-50"
        >
          {isLoading ? 'Loading...' : `Load more (${totalMemoryItems - memoryItems.length} remaining)`}
        </button>
      )}
    </div>
  );
}
