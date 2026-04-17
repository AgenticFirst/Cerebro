import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ZoomIn, ZoomOut, Maximize2, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useExperts, type Expert, type CreateExpertInput } from '../../../context/ExpertContext';
import ExpertNode from './ExpertNode';
import ExpertDetailPanel from './ExpertDetailPanel';
import CreateExpertDialog from './CreateExpertDialog';
import ExpertContextMenu from './ExpertContextMenu';

// ── Layout Constants ───────────────────────────────────────────

const NODE_W = 140;
const CEREBRO_ICON = 80;
const EXPERT_ICON = 64;
const CEREBRO_TOTAL_H = CEREBRO_ICON + 40;
const EXPERT_TOTAL_H = EXPERT_ICON + 36;
const H_GAP = 80;
const V_GAP = 100;
const TEAM_PAD_X = 40;
const TEAM_PAD_Y = 30;
const TEAM_LABEL_H = 22;

interface LayoutNode {
  id: string;
  expert?: Expert;
  isCerebro?: boolean;
  x: number;
  y: number;
  index: number;
}

interface Connector {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

interface TeamGroupBox {
  teamId: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  domain: string | null;
}

const TEAM_DOMAIN_COLORS: Record<string, { bg: string; border: string; label: string }> = {
  productivity: { bg: 'rgba(59, 130, 246, 0.04)', border: 'rgba(59, 130, 246, 0.15)', label: 'rgba(59, 130, 246, 0.5)' },
  health: { bg: 'rgba(16, 185, 129, 0.04)', border: 'rgba(16, 185, 129, 0.15)', label: 'rgba(16, 185, 129, 0.5)' },
  finance: { bg: 'rgba(245, 158, 11, 0.04)', border: 'rgba(245, 158, 11, 0.15)', label: 'rgba(245, 158, 11, 0.5)' },
  creative: { bg: 'rgba(168, 85, 247, 0.04)', border: 'rgba(168, 85, 247, 0.15)', label: 'rgba(168, 85, 247, 0.5)' },
  engineering: { bg: 'rgba(249, 115, 22, 0.04)', border: 'rgba(249, 115, 22, 0.15)', label: 'rgba(249, 115, 22, 0.5)' },
  research: { bg: 'rgba(99, 102, 241, 0.04)', border: 'rgba(99, 102, 241, 0.15)', label: 'rgba(99, 102, 241, 0.5)' },
};

const DEFAULT_TEAM_COLOR = {
  bg: 'rgba(6, 182, 212, 0.03)',
  border: 'rgba(6, 182, 212, 0.12)',
  label: 'rgba(6, 182, 212, 0.45)',
};

function getTeamColor(domain: string | null) {
  if (domain) return TEAM_DOMAIN_COLORS[domain.toLowerCase()] ?? DEFAULT_TEAM_COLOR;
  return DEFAULT_TEAM_COLOR;
}

function computeLayout(experts: Expert[]) {
  const nodes: LayoutNode[] = [];
  const connectors: Connector[] = [];
  const teamGroups: TeamGroupBox[] = [];
  let nodeIndex = 0;

  const teamMemberIds = new Set<string>();
  const teams = experts.filter((e) => e.type === 'team');
  teams.forEach((t) => t.teamMembers?.forEach((m) => teamMemberIds.add(m.expertId)));

  const standalone = experts.filter(
    (e) => e.type === 'expert' && !teamMemberIds.has(e.id),
  );

  nodes.push({ id: 'cerebro', isCerebro: true, x: 0, y: 0, index: nodeIndex++ });

  const level1Items = [...teams, ...standalone];
  if (level1Items.length === 0) return { nodes, connectors, teamGroups };

  const level1Y = CEREBRO_TOTAL_H + V_GAP;
  const totalLevel1W = level1Items.length * NODE_W + (level1Items.length - 1) * H_GAP;
  const level1StartX = -(totalLevel1W - NODE_W) / 2;

  level1Items.forEach((item, i) => {
    const x = level1StartX + i * (NODE_W + H_GAP);
    nodes.push({ id: item.id, expert: item, x, y: level1Y, index: nodeIndex++ });

    connectors.push({
      fromX: 0,
      fromY: CEREBRO_ICON + 4,
      toX: x,
      toY: level1Y,
    });

    if (item.type === 'team' && item.teamMembers && item.teamMembers.length > 0) {
      const members = item.teamMembers
        .map((tm) => experts.find((e) => e.id === tm.expertId))
        .filter(Boolean) as Expert[];

      if (members.length > 0) {
        const level2Y = level1Y + EXPERT_TOTAL_H + V_GAP;
        const totalMembersW =
          members.length * NODE_W + (members.length - 1) * H_GAP;
        const membersStartX = x - (totalMembersW - NODE_W) / 2;

        members.forEach((member, j) => {
          const mx = membersStartX + j * (NODE_W + H_GAP);
          nodes.push({
            id: member.id,
            expert: member,
            x: mx,
            y: level2Y,
            index: nodeIndex++,
          });

          connectors.push({
            fromX: x,
            fromY: level1Y + EXPERT_ICON + 4,
            toX: mx,
            toY: level2Y,
          });
        });

        const leftMostX = membersStartX - NODE_W / 2;
        const rightMostX = membersStartX + (members.length - 1) * (NODE_W + H_GAP) + NODE_W / 2;
        teamGroups.push({
          teamId: item.id,
          label: item.name.toUpperCase(),
          x: leftMostX - TEAM_PAD_X,
          y: level2Y - TEAM_PAD_Y - TEAM_LABEL_H,
          width: rightMostX - leftMostX + TEAM_PAD_X * 2,
          height: EXPERT_TOTAL_H + TEAM_PAD_Y * 2 + TEAM_LABEL_H,
          domain: item.domain,
        });
      }
    }
  });

  return { nodes, connectors, teamGroups };
}

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

  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ expert: Expert; position: { x: number; y: number } } | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'disabled' | 'pinned'>('all');

  useEffect(() => {
    loadExperts();
  }, [loadExperts]);

  useEffect(() => {
    if (!initialized && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setOffset({ x: rect.width / 2, y: 80 });
      setInitialized(true);
    }
  }, [initialized]);

  // Cross-tab nav: if the user hit "Edit" in the Messages tab's profile
  // drawer, pop open the detail panel for that expert here.
  useEffect(() => {
    const pending = consumePendingDetailExpertId();
    if (pending) setSelectedId(pending);
  }, [consumePendingDetailExpertId]);

  const filteredExperts = useMemo(() => {
    switch (filter) {
      case 'active': return experts.filter((e) => e.isEnabled);
      case 'disabled': return experts.filter((e) => !e.isEnabled);
      case 'pinned': return experts.filter((e) => e.isPinned);
      default: return experts;
    }
  }, [experts, filter]);

  const disabledCount = useMemo(() => experts.filter((e) => !e.isEnabled).length, [experts]);

  const layout = useMemo(() => computeLayout(filteredExperts), [filteredExperts]);

  const selectedExpert =
    selectedId && selectedId !== 'cerebro'
      ? experts.find((e) => e.id === selectedId) ?? null
      : null;
  const isCerebroSelected = selectedId === 'cerebro';

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.expert-node')) return;
      if ((e.target as HTMLElement).closest('.canvas-toolbar')) return;
      setIsPanning(true);
      panStartRef.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
    },
    [offset],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isPanning) return;
      setOffset({
        x: e.clientX - panStartRef.current.x,
        y: e.clientY - panStartRef.current.y,
      });
    },
    [isPanning],
  );

  const handleMouseUp = useCallback(() => setIsPanning(false), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.06 : 0.06;
      setScale((s) => Math.min(2, Math.max(0.25, s + delta)));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const handleNodeClick = useCallback((id: string) => {
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

  const zoomIn = () => setScale((s) => Math.min(2, s + 0.2));
  const zoomOut = () => setScale((s) => Math.max(0.25, s - 0.2));
  const resetView = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setOffset({ x: rect.width / 2, y: 80 });
      setScale(1);
    }
  };

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

  if (isLoading && experts.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        className="absolute inset-0 canvas-grid"
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <div
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
        >
          {layout.connectors.length > 0 && (
            <svg
              className="absolute pointer-events-none"
              style={{ left: -3000, top: -3000, width: 6000, height: 6000 }}
            >
              <g transform="translate(3000, 3000)">
                {layout.connectors.map((c, i) => {
                  const midY = (c.fromY + c.toY) / 2;
                  const d = `M ${c.fromX} ${c.fromY} C ${c.fromX} ${midY}, ${c.toX} ${midY}, ${c.toX} ${c.toY}`;
                  return (
                    <g key={i}>
                      <path
                        d={d}
                        fill="none"
                        stroke="rgba(6, 182, 212, 0.15)"
                        strokeWidth={6}
                        strokeLinecap="round"
                      />
                      <path
                        d={d}
                        fill="none"
                        stroke="rgba(6, 182, 212, 0.35)"
                        strokeWidth={1.5}
                        strokeLinecap="round"
                      />
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {layout.teamGroups.map((group) => {
            const colors = getTeamColor(group.domain);
            return (
              <div
                key={group.teamId}
                className="absolute rounded-xl"
                style={{
                  left: group.x,
                  top: group.y,
                  width: group.width,
                  height: group.height,
                  border: `1px dashed ${colors.border}`,
                  backgroundColor: colors.bg,
                }}
              >
                <span
                  className="absolute -top-3 left-5 text-[10px] font-semibold uppercase tracking-widest px-2"
                  style={{
                    color: colors.label,
                    backgroundColor: 'var(--color-bg-base)',
                  }}
                >
                  {group.label}
                </span>
              </div>
            );
          })}

          {layout.nodes.map((node) => (
            <ExpertNode
              key={node.id}
              expert={node.expert}
              isCerebro={node.isCerebro}
              isSelected={selectedId === node.id}
              x={node.x}
              y={node.y}
              index={node.index}
              onClick={() => handleNodeClick(node.id)}
              onContextMenu={
                !node.isCerebro && node.expert
                  ? (e) => handleContextMenu(node.expert!, e)
                  : undefined
              }
            />
          ))}

          {experts.length === 0 && (
            <div
              className="absolute flex flex-col items-center cursor-pointer group animate-node-in"
              style={{
                left: 0,
                top: CEREBRO_TOTAL_H + V_GAP,
                transform: 'translate(-50%, 0)',
                animationDelay: '200ms',
              }}
              onClick={() => setShowCreate(true)}
            >
              <svg
                className="absolute pointer-events-none"
                style={{ top: -V_GAP, left: '50%', width: 2, height: V_GAP }}
              >
                <line
                  x1={1}
                  y1={0}
                  x2={1}
                  y2={V_GAP - 10}
                  stroke="rgba(6, 182, 212, 0.2)"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                />
              </svg>
              <div className="w-16 h-16 rounded-xl border-2 border-dashed border-border-default flex items-center justify-center group-hover:border-accent/40 transition-colors">
                <Plus
                  size={24}
                  className="text-text-tertiary group-hover:text-accent transition-colors"
                />
              </div>
              <span className="text-[11px] text-text-tertiary mt-2 group-hover:text-text-secondary transition-colors">
                {t('experts.addExpert')}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="canvas-toolbar absolute top-4 left-4 flex items-center gap-1.5">
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

      <div className="canvas-toolbar absolute top-4 right-4 flex items-center gap-2">
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors"
        >
          <Plus size={14} />
          {t('experts.newExpert')}
        </button>
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
          onClick={resetView}
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
