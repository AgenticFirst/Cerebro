import { useState, useMemo } from 'react';
import { BadgeCheck, ChevronDown, Users, Pin } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../context/ExpertContext';
import { getAvatar } from '../../../constants/avatars';
import EmployeeRow from './EmployeeRow';

// Domain-tinted accent colors for the left edge strip. Kept in sync with the
// old HierarchyView palette so experts and teams feel consistent.
const DOMAIN_ACCENTS: Record<string, string> = {
  productivity: '#3b82f6',
  health: '#10b981',
  finance: '#f59e0b',
  creative: '#a855f7',
  engineering: '#f97316',
  research: '#6366f1',
};
const DEFAULT_ACCENT = '#06b6d4';

function accentFor(domain: string | null): string {
  if (!domain) return DEFAULT_ACCENT;
  return DOMAIN_ACCENTS[domain.toLowerCase()] ?? DEFAULT_ACCENT;
}

const INITIAL_VISIBLE = 5;

interface DepartmentCardProps {
  team: Expert;
  members: Expert[];
  isSelected: boolean;
  selectedMemberId: string | null;
  onSelectTeam: () => void;
  onSelectMember: (id: string) => void;
  onMemberContextMenu: (expert: Expert, e: React.MouseEvent) => void;
  onTeamContextMenu: (expert: Expert, e: React.MouseEvent) => void;
}

export default function DepartmentCard({
  team,
  members,
  isSelected,
  selectedMemberId,
  onSelectTeam,
  onSelectMember,
  onMemberContextMenu,
  onTeamContextMenu,
}: DepartmentCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const accent = accentFor(team.domain);
  const teamAvatar = getAvatar(team.avatarUrl);
  const memberCount = members.length;

  const visibleMembers = useMemo(() => {
    if (showAll || memberCount <= INITIAL_VISIBLE) return members;
    return members.slice(0, INITIAL_VISIBLE);
  }, [members, memberCount, showAll]);

  const hiddenCount = memberCount - visibleMembers.length;

  const roleByExpertId = useMemo(() => {
    const map = new Map<string, string>();
    team.teamMembers?.forEach((m) => map.set(m.expertId, m.role));
    return map;
  }, [team.teamMembers]);

  const subtitleParts: string[] = [];
  if (team.domain) {
    subtitleParts.push(
      team.domain.charAt(0).toUpperCase() + team.domain.slice(1),
    );
  }
  subtitleParts.push(
    memberCount === 1 ? '1 member' : `${memberCount} members`,
  );

  return (
    <div
      className={clsx(
        'relative rounded-xl bg-bg-surface border transition-all duration-150 overflow-hidden',
        isSelected
          ? 'border-accent/50 shadow-[0_0_0_3px_rgba(6,182,212,0.08)]'
          : 'border-border-subtle hover:border-border-default',
        !team.isEnabled && 'opacity-60',
      )}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ backgroundColor: accent }}
      />

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelectTeam();
        }}
        onContextMenu={(e) => onTeamContextMenu(team, e)}
        className="expert-node w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-bg-hover/50 transition-colors"
      >
        <div
          className="relative w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
          style={{
            backgroundColor: 'rgba(13, 13, 16, 0.95)',
            border: `1.5px solid ${accent}66`,
          }}
        >
          {teamAvatar ? (
            <img
              src={teamAvatar.src}
              alt={teamAvatar.label}
              width={36}
              height={36}
              className="object-contain pointer-events-none select-none"
              draggable={false}
            />
          ) : (
            <Users size={18} style={{ color: accent }} />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="text-sm font-semibold text-text-primary truncate"
              title={team.name}
            >
              {team.name}
            </span>
            {team.isVerified && (
              <BadgeCheck
                size={13}
                className="text-accent flex-shrink-0"
                strokeWidth={2.25}
              />
            )}
            {team.isPinned && (
              <Pin size={11} className="text-accent flex-shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div
              className="w-[6px] h-[6px] rounded-full flex-shrink-0"
              style={{
                backgroundColor: team.isEnabled ? '#22c55e' : '#71717a',
              }}
            />
            <span className="text-[11px] text-text-tertiary truncate">
              {subtitleParts.join(' · ')}
            </span>
          </div>
        </div>

        {/* Inline avatar cluster — only when collapsed, so the card is visually
            complete at its natural (short) height rather than floating inside
            a grid row stretched by expanded siblings. */}
        {!expanded && memberCount > 0 && (
          <div className="flex items-center flex-shrink-0">
            <div className="flex -space-x-1.5">
              {members.slice(0, 3).map((m) => {
                const a = getAvatar(m.avatarUrl);
                return (
                  <div
                    key={m.id}
                    className="w-6 h-6 rounded-full border-2 border-bg-surface bg-bg-base overflow-hidden flex items-center justify-center"
                    title={m.name}
                  >
                    {a ? (
                      <img
                        src={a.src}
                        alt={a.label}
                        className="w-full h-full object-contain"
                        draggable={false}
                      />
                    ) : (
                      <span className="text-[9px] text-text-tertiary">
                        {m.name.slice(0, 1)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {memberCount > 3 && (
              <span className="ml-1.5 text-[10px] text-text-tertiary tabular-nums">
                +{memberCount - 3}
              </span>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-text-secondary transition-colors flex-shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronDown
            size={14}
            className={clsx(
              'transition-transform duration-150',
              expanded ? 'rotate-0' : '-rotate-90',
            )}
          />
        </button>
      </button>

      {expanded && (
        memberCount === 0 ? (
          <div className="px-3.5 pb-3 -mt-1 text-[11px] text-text-tertiary italic">
            No members yet.
          </div>
        ) : (
          <div className="px-1.5 pb-1.5 pt-0.5 border-t border-border-subtle/60 space-y-0.5">
            {visibleMembers.map((member) => (
              <EmployeeRow
                key={member.id}
                expert={member}
                role={roleByExpertId.get(member.id)}
                isSelected={selectedMemberId === member.id}
                onClick={() => onSelectMember(member.id)}
                onContextMenu={(e) => onMemberContextMenu(member, e)}
              />
            ))}
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAll(true);
                }}
                className="w-full px-2.5 py-1.5 text-[11px] text-text-tertiary hover:text-accent transition-colors text-left"
              >
                + {hiddenCount} more
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
