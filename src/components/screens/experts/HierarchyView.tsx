import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Brain, Loader2, Search, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import clsx from 'clsx';
import { useExperts, type Expert, type CreateExpertInput } from '../../../context/ExpertContext';
import ExpertDetailPanel from './ExpertDetailPanel';
import CreateExpertDialog from './CreateExpertDialog';
import ExpertContextMenu from './ExpertContextMenu';
import DepartmentCard from './DepartmentCard';
import SoloExpertCard from './SoloExpertCard';

type FilterKey = 'all' | 'active' | 'disabled' | 'pinned';

export default function HierarchyView() {
  const { t } = useTranslation();
  const {
    experts,
    isLoading,
    activeCount,
    pinnedCount,
    loadExperts,
    createExpert,
    updateExpert,
    deleteExpert,
    toggleEnabled,
    togglePinned,
    consumePendingDetailExpertId,
  } = useExperts();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    expert: Expert;
    position: { x: number; y: number };
  } | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [scale, setScale] = useState(1);

  useEffect(() => {
    loadExperts();
  }, [loadExperts]);

  useEffect(() => {
    const pending = consumePendingDetailExpertId();
    if (pending) setSelectedId(pending);
  }, [consumePendingDetailExpertId]);

  const disabledCount = useMemo(
    () => experts.filter((e) => !e.isEnabled).length,
    [experts],
  );

  // Filter pipeline: visibility first, then free-text search.
  const visibleExperts = useMemo(() => {
    const byVisibility = (() => {
      switch (filter) {
        case 'active': return experts.filter((e) => e.isEnabled);
        case 'disabled': return experts.filter((e) => !e.isEnabled);
        case 'pinned': return experts.filter((e) => e.isPinned);
        default: return experts;
      }
    })();
    const q = search.trim().toLowerCase();
    if (!q) return byVisibility;
    return byVisibility.filter(
      (e) =>
        e.name.toLowerCase().includes(q)
        || (e.domain ?? '').toLowerCase().includes(q)
        || (e.description ?? '').toLowerCase().includes(q),
    );
  }, [experts, filter, search]);

  // Split into departments (teams with members) and solo experts.
  const { departments, soloExperts } = useMemo(() => {
    const byId = new Map(visibleExperts.map((e) => [e.id, e]));
    const teams = visibleExperts.filter((e) => e.type === 'team');
    const teamMemberIds = new Set<string>();
    teams.forEach((t) => t.teamMembers?.forEach((m) => teamMemberIds.add(m.expertId)));

    const depts = teams.map((team) => {
      const members = (team.teamMembers ?? [])
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((m) => byId.get(m.expertId))
        .filter(Boolean) as Expert[];
      return { team, members };
    });

    const solos = visibleExperts.filter(
      (e) => e.type === 'expert' && !teamMemberIds.has(e.id),
    );

    return { departments: depts, soloExperts: solos };
  }, [visibleExperts]);

  const selectedExpert =
    selectedId && selectedId !== 'cerebro'
      ? experts.find((e) => e.id === selectedId) ?? null
      : null;
  const isCerebroSelected = selectedId === 'cerebro';

  const handleSelectId = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const handleContextMenu = useCallback(
    (expert: Expert, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ expert, position: { x: e.clientX, y: e.clientY } });
    },
    [],
  );

  const handleContextMenuDelete = useCallback(
    async (id: string) => {
      setSelectedId((prev) => (prev === id ? null : prev));
      await deleteExpert(id);
    },
    [deleteExpert],
  );

  const handleCreate = async (input: CreateExpertInput) => {
    await createExpert(input);
  };

  const handleUpdate = async (id: string, fields: Record<string, unknown>) => {
    await updateExpert(id, fields);
  };

  const handleDelete = async (id: string) => {
    setSelectedId(null);
    await deleteExpert(id);
  };

  const zoomIn = () => setScale((s) => Math.min(1.5, +(s + 0.1).toFixed(2)));
  const zoomOut = () => setScale((s) => Math.max(0.6, +(s - 0.1).toFixed(2)));
  const resetZoom = () => setScale(1);

  if (isLoading && experts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-accent animate-spin" />
      </div>
    );
  }

  const isEmpty = experts.length === 0;

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      <div className="canvas-toolbar flex items-center justify-between gap-3 px-4 py-3 border-b border-border-subtle bg-bg-base/60">
        <div className="flex items-center gap-1.5 flex-wrap">
          {([
            { key: 'all' as const, labelKey: 'experts.filterAll', count: experts.length },
            { key: 'active' as const, labelKey: 'experts.filterActive', count: activeCount },
            { key: 'disabled' as const, labelKey: 'experts.filterDisabled', count: disabledCount },
            { key: 'pinned' as const, labelKey: 'experts.filterPinned', count: pinnedCount },
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
              {t(pill.labelKey)} ({pill.count})
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('experts.searchPlaceholder', 'Search experts…')}
              className="w-56 pl-7 pr-2.5 py-1 bg-bg-surface border border-border-subtle rounded-full text-[11px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40"
            />
          </div>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
          >
            <Plus size={14} />
            {t('experts.newExpert')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto canvas-grid">
        <div
          className="min-h-full flex flex-col items-center px-6 py-8"
          style={{
            transform: scale === 1 ? undefined : `scale(${scale})`,
            transformOrigin: 'top center',
          }}
        >
          <CerebroHeader
            isSelected={isCerebroSelected}
            onClick={() => handleSelectId('cerebro')}
          />

          <div className="w-px h-8 bg-gradient-to-b from-accent/30 to-transparent" />

          {isEmpty ? (
            <EmptyState onCreate={() => setShowCreate(true)} />
          ) : (
            <div className="w-full max-w-[1400px] space-y-10">
              {departments.length > 0 && (
                <section>
                  <SectionHeader
                    title={t('experts.departmentsTitle', 'Departments')}
                    count={departments.length}
                  />
                  <div className="grid gap-4 items-start grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                    {departments.map(({ team, members }) => (
                      <DepartmentCard
                        key={team.id}
                        team={team}
                        members={members}
                        isSelected={selectedId === team.id}
                        selectedMemberId={selectedId}
                        onSelectTeam={() => handleSelectId(team.id)}
                        onSelectMember={(id) => handleSelectId(id)}
                        onMemberContextMenu={handleContextMenu}
                        onTeamContextMenu={handleContextMenu}
                      />
                    ))}
                  </div>
                </section>
              )}

              {soloExperts.length > 0 && (
                <section>
                  <SectionHeader
                    title={t('experts.soloExpertsTitle', 'Independent Contributors')}
                    count={soloExperts.length}
                  />
                  <div className="grid gap-3 items-start grid-cols-[repeat(auto-fill,minmax(220px,1fr))]">
                    {soloExperts.map((expert) => (
                      <SoloExpertCard
                        key={expert.id}
                        expert={expert}
                        isSelected={selectedId === expert.id}
                        onClick={() => handleSelectId(expert.id)}
                        onContextMenu={(e) => handleContextMenu(expert, e)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {departments.length === 0 && soloExperts.length === 0 && (
                <div className="text-center py-12 text-text-tertiary text-sm">
                  {t('experts.noResults', 'No experts match the current filter.')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="canvas-toolbar absolute bottom-4 right-4 flex items-center gap-0.5 bg-bg-surface/80 backdrop-blur-sm rounded-lg border border-border-subtle p-1">
        <button
          onClick={zoomOut}
          className="p-1.5 rounded hover:bg-bg-hover transition-colors text-text-tertiary hover:text-text-secondary"
          title={t('experts.zoomOut')}
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-[10px] text-text-tertiary w-10 text-center select-none">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={zoomIn}
          className="p-1.5 rounded hover:bg-bg-hover transition-colors text-text-tertiary hover:text-text-secondary"
          title={t('experts.zoomIn')}
        >
          <ZoomIn size={14} />
        </button>
        <div className="w-px h-4 bg-border-subtle mx-0.5" />
        <button
          onClick={resetZoom}
          className="p-1.5 rounded hover:bg-bg-hover transition-colors text-text-tertiary hover:text-text-secondary"
          title={t('experts.resetView')}
        >
          <Maximize2 size={14} />
        </button>
      </div>

      {selectedId && (
        <ExpertDetailPanel
          expert={selectedExpert}
          isCerebro={isCerebroSelected}
          allExperts={experts}
          onClose={() => setSelectedId(null)}
          onUpdate={handleUpdate}
          onDelete={handleDelete}
          onToggleEnabled={toggleEnabled}
          onTogglePinned={togglePinned}
          activeCount={activeCount}
          pinnedCount={pinnedCount}
        />
      )}

      <CreateExpertDialog
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        experts={experts}
      />

      {contextMenu && (
        <ExpertContextMenu
          expert={contextMenu.expert}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onToggleEnabled={toggleEnabled}
          onTogglePinned={togglePinned}
          onDelete={handleContextMenuDelete}
        />
      )}
    </div>
  );
}

// ── Cerebro header node ──────────────────────────────────────────

function CerebroHeader({
  isSelected,
  onClick,
}: {
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="expert-node flex flex-col items-center gap-2 cursor-pointer group"
    >
      <div
        className={clsx(
          'relative w-20 h-20 rounded-2xl flex items-center justify-center transition-all duration-200',
        )}
        style={{
          backgroundColor: 'rgba(13, 13, 16, 0.95)',
          border: '2.5px solid rgba(245, 158, 11, 0.65)',
          boxShadow: isSelected
            ? '0 0 24px rgba(245, 158, 11, 0.55), 0 0 64px rgba(245, 158, 11, 0.18), 0 0 0 3px rgba(245, 158, 11, 0.4)'
            : '0 0 20px rgba(245, 158, 11, 0.35), 0 0 56px rgba(245, 158, 11, 0.1)',
        }}
      >
        <Brain size={38} style={{ color: '#f59e0b' }} />
      </div>
      <div className="flex flex-col items-center">
        <span className="text-sm font-semibold text-text-primary">Cerebro</span>
        <span className="text-[10px] uppercase tracking-widest text-text-tertiary mt-0.5">
          Lead
        </span>
      </div>
    </button>
  );
}

// ── Section header ───────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-3 px-1">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
        {title}
      </h3>
      <span className="text-[11px] text-text-tertiary">{count}</span>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onCreate}
      className="flex flex-col items-center gap-2 cursor-pointer group mt-4"
    >
      <div className="w-20 h-20 rounded-2xl border-2 border-dashed border-border-default flex items-center justify-center group-hover:border-accent/40 transition-colors">
        <Plus
          size={28}
          className="text-text-tertiary group-hover:text-accent transition-colors"
        />
      </div>
      <span className="text-xs text-text-tertiary group-hover:text-text-secondary transition-colors">
        {t('experts.addExpert')}
      </span>
    </button>
  );
}
