import { useEffect, useState, useMemo } from 'react';
import { Plus, Loader2, Search, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useRoutines } from '../../../context/RoutineContext';
import type { CreateRoutineInput } from '../../../types/routines';
import RoutineCard from './RoutineCard';
import CreateRoutineDialog from './CreateRoutineDialog';

type Filter = 'all' | 'enabled' | 'scheduled' | 'manual';

export default function RoutineList() {
  const {
    routines,
    isLoading,
    enabledCount,
    cronCount,
    loadRoutines,
    createRoutine,
    deleteRoutine,
    toggleEnabled,
    runRoutine,
    setEditingRoutineId,
  } = useRoutines();

  const [showCreate, setShowCreate] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    loadRoutines();
  }, [loadRoutines]);

  const manualCount = useMemo(
    () => routines.filter((r) => r.triggerType === 'manual').length,
    [routines],
  );

  const filteredRoutines = useMemo(() => {
    let list = routines;

    switch (filter) {
      case 'enabled':
        list = list.filter((r) => r.isEnabled);
        break;
      case 'scheduled':
        list = list.filter((r) => r.triggerType === 'cron');
        break;
      case 'manual':
        list = list.filter((r) => r.triggerType === 'manual');
        break;
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      );
    }

    return list;
  }, [routines, filter, search]);

  const handleCreate = async (input: CreateRoutineInput): Promise<boolean> => {
    const created = await createRoutine(input);
    if (created) {
      setEditingRoutineId(created.id);
      return true;
    }
    return false;
  };

  if (isLoading && routines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-text-primary">Routines</h1>
            <div className="flex items-center gap-1.5">
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bg-elevated text-text-tertiary border border-border-subtle">
                {routines.length} total
              </span>
              {enabledCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                  {enabledCount} active
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
          >
            <Plus size={14} />
            New Routine
          </button>
        </div>

        {/* Filter pills + search */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            {([
              { key: 'all' as const, label: 'All', count: routines.length },
              { key: 'enabled' as const, label: 'Enabled', count: enabledCount },
              { key: 'scheduled' as const, label: 'Scheduled', count: cronCount },
              { key: 'manual' as const, label: 'Manual', count: manualCount },
            ]).map((pill) => (
              <button
                key={pill.key}
                onClick={() => setFilter(pill.key)}
                className={clsx(
                  'px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-150',
                  filter === pill.key
                    ? 'bg-accent/15 text-accent border border-accent/30'
                    : 'bg-bg-surface/80 text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
                )}
              >
                {pill.label} ({pill.count})
              </button>
            ))}
          </div>

          <div className="flex-1" />

          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-48 bg-bg-surface border border-border-subtle rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
            />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {routines.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-border-default flex items-center justify-center mb-4">
              <RefreshCw size={24} className="text-text-tertiary" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1.5">
              No routines yet
            </h3>
            <p className="text-xs text-text-tertiary mb-4 max-w-[240px] text-center">
              Routines automate multi-step tasks. Create your first routine to get started.
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
            >
              <Plus size={14} />
              Create your first routine
            </button>
          </div>
        ) : filteredRoutines.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-xs text-text-tertiary">
              No routines match your {search ? 'search' : 'filter'}.
            </p>
          </div>
        ) : (
          <div className="p-6 space-y-2">
            {filteredRoutines.map((routine, i) => (
              <RoutineCard
                key={routine.id}
                routine={routine}
                index={i}
                onClick={() => setEditingRoutineId(routine.id)}
                onToggle={() => toggleEnabled(routine)}
                onRun={() => runRoutine(routine.id)}
                onDelete={() => {
                  if (window.confirm(`Delete "${routine.name}"? This cannot be undone.`)) {
                    deleteRoutine(routine.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <CreateRoutineDialog
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
      />
    </div>
  );
}
