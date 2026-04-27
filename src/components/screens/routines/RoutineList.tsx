import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Loader2, Search, RefreshCw, AlertCircle, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { useRoutines } from '../../../context/RoutineContext';
import type { CreateRoutineInput } from '../../../types/routines';
import RoutineCard from './RoutineCard';
import CreateRoutineDialog from './CreateRoutineDialog';
import TemplatesView from './TemplatesView';
import AlertModal from '../../ui/AlertModal';
import Tooltip from '../../ui/Tooltip';

type Filter = 'all' | 'enabled' | 'scheduled' | 'manual';
type Tab = 'mine' | 'templates';

export default function RoutineList() {
  const { t } = useTranslation();
  const {
    routines,
    isLoading,
    loadError,
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
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [tab, setTab] = useState<Tab>('mine');

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

  if (loadError && routines.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20">
        <div className="w-16 h-16 rounded-xl border-2 border-dashed border-red-500/30 flex items-center justify-center mb-4">
          <AlertCircle size={24} className="text-red-400" />
        </div>
        <h3 className="text-sm font-medium text-text-primary mb-1.5">
          Failed to load routines
        </h3>
        <p className="text-xs text-text-tertiary mb-4 max-w-[280px] text-center">
          {loadError}
        </p>
        <Tooltip label={t('routineTooltips.retry')}>
          <button
            onClick={() => loadRoutines()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent bg-accent/10 hover:bg-accent/20 border border-accent/20 rounded-lg transition-colors"
          >
            <RefreshCw size={14} />
            {t('common.retry')}
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 px-6 pt-5 pb-4 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-text-primary">{t('routines.title')}</h1>
            <div className="flex items-center gap-1.5">
              <Tooltip label={t('routines.total', { count: routines.length })}>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-bg-elevated text-text-tertiary border border-border-subtle">
                  {t('routines.total', { count: routines.length })}
                </span>
              </Tooltip>
              {enabledCount > 0 && (
                <Tooltip label={t('routines.active', { count: enabledCount })}>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                    {t('routines.active', { count: enabledCount })}
                  </span>
                </Tooltip>
              )}
            </div>
          </div>

          <Tooltip label={t('routineTooltips.newRoutine')} shortcut="N">
            <button
              onClick={() => setShowCreate(true)}
              data-tour-id="routines-create"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
            >
              <Plus size={14} />
              {t('routines.newRoutine')}
            </button>
          </Tooltip>
        </div>

        {/* Tab bar: My routines | Templates */}
        <div className="flex items-center gap-1 mb-4 -mt-1">
          <button
            onClick={() => setTab('mine')}
            className={clsx(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              tab === 'mine'
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover border border-transparent',
            )}
          >
            My routines
          </button>
          <button
            onClick={() => setTab('templates')}
            className={clsx(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5',
              tab === 'templates'
                ? 'bg-accent/15 text-accent border border-accent/30'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover border border-transparent',
            )}
          >
            <Sparkles size={11} />
            Templates
          </button>
        </div>

        {/* Filter pills + search — hidden on Templates tab */}
        {tab === 'mine' && <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            {([
              { key: 'all' as const, labelKey: 'routines.filterAll', tipKey: 'routineTooltips.filterAll', count: routines.length },
              { key: 'enabled' as const, labelKey: 'routines.filterEnabled', tipKey: 'routineTooltips.filterEnabled', count: enabledCount },
              { key: 'scheduled' as const, labelKey: 'routines.filterScheduled', tipKey: 'routineTooltips.filterScheduled', count: cronCount },
              { key: 'manual' as const, labelKey: 'routines.filterManual', tipKey: 'routineTooltips.filterManual', count: manualCount },
            ]).map((pill) => (
              <Tooltip key={pill.key} label={t(pill.tipKey)}>
                <button
                  onClick={() => setFilter(pill.key)}
                  className={clsx(
                    'px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors duration-150',
                    filter === pill.key
                      ? 'bg-accent/15 text-accent border border-accent/30'
                      : 'bg-bg-surface/80 text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {t(pill.labelKey)} ({pill.count})
                </button>
              </Tooltip>
            ))}
          </div>

          <div className="flex-1" />

          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <Tooltip label={t('routineTooltips.search')} side="bottom">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('common.search')}
                className="w-48 bg-bg-surface border border-border-subtle rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
              />
            </Tooltip>
          </div>
        </div>}
      </div>

      {/* Content */}
      {tab === 'templates' ? (
        <TemplatesView />
      ) : (
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {routines.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-20">
            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-border-default flex items-center justify-center mb-4">
              <RefreshCw size={24} className="text-text-tertiary" />
            </div>
            <h3 className="text-sm font-medium text-text-primary mb-1.5">
              {t('routines.noRoutinesYet')}
            </h3>
            <p className="text-xs text-text-tertiary mb-4 max-w-[240px] text-center">
              {t('routines.noRoutinesDescription')}
            </p>
            <Tooltip label={t('routineTooltips.newRoutine')}>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
              >
                <Plus size={14} />
                {t('routines.createFirst')}
              </button>
            </Tooltip>
          </div>
        ) : filteredRoutines.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <p className="text-xs text-text-tertiary">
              {search ? t('routines.noMatchSearch') : t('routines.noMatchFilter')}
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
                onDelete={() => setDeleteTarget({ id: routine.id, name: routine.name })}
              />
            ))}
          </div>
        )}
      </div>
      )}

      {/* Create Dialog */}
      <CreateRoutineDialog
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
      />

      {/* Delete Confirm Dialog */}
      {deleteTarget && (
        <AlertModal
          title={t('routines.deleteRoutine')}
          message={t('routines.deleteConfirm', { name: deleteTarget.name })}
          onClose={() => setDeleteTarget(null)}
          actions={[
            { label: t('common.cancel'), onClick: () => setDeleteTarget(null) },
            {
              label: t('common.delete'),
              primary: true,
              variant: 'danger',
              onClick: () => {
                deleteRoutine(deleteTarget.id);
                setDeleteTarget(null);
              },
            },
          ]}
        />
      )}
    </div>
  );
}
