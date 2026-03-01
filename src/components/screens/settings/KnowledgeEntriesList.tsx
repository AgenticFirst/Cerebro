import { useState, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useMemory } from '../../../context/MemoryContext';
import KnowledgeEntryRow from './KnowledgeEntryRow';

export default function KnowledgeEntriesList() {
  const {
    knowledgeEntries,
    totalKnowledgeEntries,
    loadKnowledgeEntries,
    deleteKnowledgeEntry,
    isLoading,
  } = useMemory();
  const [search, setSearch] = useState('');
  const [entryType, setEntryType] = useState('');
  const [offset, setOffset] = useState(0);

  // Derive unique entry types from current results
  const entryTypes = Array.from(new Set(knowledgeEntries.map((e) => e.entryType))).sort();

  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);
      setOffset(0);
      loadKnowledgeEntries({
        search: value || undefined,
        entryType: entryType || undefined,
        offset: 0,
      });
    },
    [loadKnowledgeEntries, entryType],
  );

  const handleTypeFilter = useCallback(
    (type: string) => {
      setEntryType(type);
      setOffset(0);
      loadKnowledgeEntries({
        search: search || undefined,
        entryType: type || undefined,
        offset: 0,
      });
    },
    [loadKnowledgeEntries, search],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteKnowledgeEntry(id);
    },
    [deleteKnowledgeEntry],
  );

  const handleLoadMore = useCallback(() => {
    const newOffset = offset + 50;
    setOffset(newOffset);
    loadKnowledgeEntries({
      search: search || undefined,
      entryType: entryType || undefined,
      offset: newOffset,
    });
  }, [offset, search, entryType, loadKnowledgeEntries]);

  if (totalKnowledgeEntries === 0 && !search && !entryType) {
    return (
      <p className="text-sm text-text-tertiary py-4">
        No knowledge entries yet. Cerebro will extract structured records from your conversations,
        or they can be added by connectors.
      </p>
    );
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search entries..."
            className="w-full bg-bg-base border border-border-subtle rounded-md pl-9 pr-3 py-2
                       text-sm text-text-secondary placeholder:text-text-tertiary/50
                       focus:outline-none focus:border-accent/40 transition-colors"
          />
        </div>
        {entryTypes.length > 1 && (
          <select
            value={entryType}
            onChange={(e) => handleTypeFilter(e.target.value)}
            className="bg-bg-base border border-border-subtle rounded-md px-3 py-2
                       text-sm text-text-secondary focus:outline-none focus:border-accent/40
                       transition-colors cursor-pointer"
          >
            <option value="">All types</option>
            {entryTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* List */}
      <div className="space-y-px">
        {knowledgeEntries.map((entry) => (
          <KnowledgeEntryRow key={entry.id} entry={entry} onDelete={handleDelete} />
        ))}
      </div>

      {/* Load more */}
      {knowledgeEntries.length < totalKnowledgeEntries && (
        <button
          onClick={handleLoadMore}
          disabled={isLoading}
          className="mt-3 text-xs text-accent hover:text-accent-hover transition-colors cursor-pointer disabled:opacity-50"
        >
          {isLoading
            ? 'Loading...'
            : `Load more (${totalKnowledgeEntries - knowledgeEntries.length} remaining)`}
        </button>
      )}
    </div>
  );
}
