import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Search, Star } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../../context/ExpertContext';
import ExpertAvatar from './ExpertAvatar';
import TeamAvatar from './TeamAvatar';

interface ExpertListRailProps {
  experts: Expert[];
  selectedExpertId: string | null;
  onSelectExpert: (id: string) => void;
}

function filterExperts(experts: Expert[], query: string): Expert[] {
  if (!query.trim()) return experts;
  const q = query.toLowerCase();
  return experts.filter((e) => {
    if (e.name.toLowerCase().includes(q)) return true;
    if (e.domain && e.domain.toLowerCase().includes(q)) return true;
    if (e.description && e.description.toLowerCase().includes(q)) return true;
    return false;
  });
}

function TeamRow({
  team,
  members,
  isActive,
  onClick,
}: {
  team: Expert;
  members: Expert[];
  isActive: boolean;
  onClick: () => void;
}) {
  const memberLine = members.map((m) => m.name).join(' · ');
  return (
    <button
      onClick={onClick}
      className={clsx(
        'group relative w-full flex items-center gap-3 px-3 py-2 rounded-md',
        'text-left transition-all duration-150 cursor-pointer',
        isActive
          ? 'bg-bg-elevated text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.03]',
      )}
    >
      {isActive && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-accent"
          aria-hidden="true"
        />
      )}
      <TeamAvatar team={team} members={members} size={32} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium truncate">{team.name}</span>
          {team.isVerified && (
            <BadgeCheck size={11} className="text-accent flex-shrink-0" strokeWidth={2.25} />
          )}
          {team.isPinned && <Star size={10} className="text-accent flex-shrink-0" strokeWidth={2.5} />}
        </div>
        <div className="text-[11px] text-text-tertiary truncate">{memberLine}</div>
      </div>
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          team.isEnabled ? 'bg-emerald-500' : 'bg-text-tertiary/40',
        )}
        title={team.isEnabled ? 'Active' : 'Disabled'}
      />
    </button>
  );
}

function Row({
  expert,
  isActive,
  onClick,
}: {
  expert: Expert;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'relative w-full flex items-center gap-2.5 px-3 py-2 rounded-md',
        'text-left transition-all duration-150 cursor-pointer',
        isActive
          ? 'bg-bg-elevated text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.03]',
      )}
    >
      {isActive && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-accent"
          aria-hidden="true"
        />
      )}
      <ExpertAvatar expert={expert} size={28} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium truncate">{expert.name}</span>
          {expert.isVerified && (
            <BadgeCheck size={11} className="text-accent flex-shrink-0" strokeWidth={2.25} />
          )}
          {expert.isPinned && <Star size={10} className="text-accent flex-shrink-0" strokeWidth={2.5} />}
        </div>
        {expert.domain && (
          <div className="text-[11px] text-text-tertiary capitalize truncate">
            {expert.domain}
          </div>
        )}
      </div>
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          expert.isEnabled ? 'bg-emerald-500' : 'bg-text-tertiary/40',
        )}
        title={expert.isEnabled ? 'Active' : 'Disabled'}
      />
    </button>
  );
}

export default function ExpertListRail({
  experts,
  selectedExpertId,
  onSelectExpert,
}: ExpertListRailProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const { starred, direct, teams, expertsById } = useMemo(() => {
    const enabledExperts = experts.filter((e) => e.isEnabled && e.type === 'expert');
    const enabledTeams = experts.filter((e) => e.isEnabled && e.type === 'team');
    const filteredExperts = filterExperts(enabledExperts, query);
    const filteredTeams = filterExperts(enabledTeams, query);
    const byId: Record<string, Expert> = {};
    for (const e of experts) byId[e.id] = e;
    return {
      starred: filteredExperts.filter((e) => e.isPinned),
      direct: filteredExperts.filter((e) => !e.isPinned),
      teams: filteredTeams,
      expertsById: byId,
    };
  }, [experts, query]);

  const teamMembers = (team: Expert): Expert[] => {
    const memberIds = (team.teamMembers ?? []).map((m) => m.expertId);
    const resolved = memberIds.map((id) => expertsById[id]).filter((e): e is Expert => Boolean(e));
    return resolved;
  };

  return (
    <div className="w-[260px] flex-shrink-0 flex flex-col bg-bg-surface border-r border-border-subtle overflow-hidden">
      <div className="px-3 pt-3 pb-2">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('experts.searchPlaceholder')}
            className={clsx(
              'w-full pl-8 pr-2.5 py-1.5 rounded-md',
              'bg-bg-elevated border border-border-subtle',
              'text-[12px] text-text-primary placeholder:text-text-tertiary',
              'focus:outline-none focus:border-border-accent',
            )}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-3">
        {teams.length > 0 && (
          <div className="mb-2">
            <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] select-none">
              <span>{t('experts.groupsSection')}</span>
              <span className="px-1.5 py-px rounded-full bg-bg-elevated text-[9px] tracking-normal normal-case font-medium text-text-secondary">
                {teams.length}
              </span>
            </div>
            <div className="space-y-px">
              {teams.map((team) => (
                <TeamRow
                  key={team.id}
                  team={team}
                  members={teamMembers(team)}
                  isActive={selectedExpertId === team.id}
                  onClick={() => onSelectExpert(team.id)}
                />
              ))}
            </div>
          </div>
        )}

        {starred.length > 0 && (
          <div className="mb-2">
            <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] select-none">
              {t('experts.starred')}
            </div>
            <div className="space-y-px">
              {starred.map((e) => (
                <Row
                  key={e.id}
                  expert={e}
                  isActive={selectedExpertId === e.id}
                  onClick={() => onSelectExpert(e.id)}
                />
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] select-none">
            {t('experts.directMessages')}
          </div>
          {direct.length === 0 && starred.length === 0 ? (
            <div className="px-3 py-6 text-[11px] text-text-tertiary text-center">
              {query ? t('experts.searchPlaceholder') : t('experts.noAvailableExperts')}
            </div>
          ) : (
            <div className="space-y-px">
              {direct.map((e) => (
                <Row
                  key={e.id}
                  expert={e}
                  isActive={selectedExpertId === e.id}
                  onClick={() => onSelectExpert(e.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
