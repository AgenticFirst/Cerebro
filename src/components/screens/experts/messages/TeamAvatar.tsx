import { BadgeCheck, Users } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../../context/ExpertContext';
import { getAvatar } from '../../../../constants/avatars';

interface TeamAvatarProps {
  team: Expert;
  members: Expert[];
  size?: number;
  showCount?: boolean;
  className?: string;
  onClick?: () => void;
}

const DOMAIN_RING: Record<string, string> = {
  productivity: 'ring-blue-500/40',
  health: 'ring-emerald-500/40',
  finance: 'ring-amber-500/40',
  creative: 'ring-purple-500/40',
  engineering: 'ring-orange-500/40',
  research: 'ring-indigo-500/40',
};

const DOMAIN_BG: Record<string, string> = {
  productivity: 'bg-blue-500/15',
  health: 'bg-emerald-500/15',
  finance: 'bg-amber-500/15',
  creative: 'bg-purple-500/15',
  engineering: 'bg-orange-500/15',
  research: 'bg-indigo-500/15',
};

/**
 * Stacked-avatars composite that conveys "this is a group of experts" at a
 * glance. Renders up to three member avatars overlapped with a negative
 * margin, plus an optional `+N` chip if there are more.
 */
export default function TeamAvatar({
  team,
  members,
  size = 32,
  showCount = true,
  className,
  onClick,
}: TeamAvatarProps) {
  const ring = team.domain
    ? DOMAIN_RING[team.domain.toLowerCase()] ?? 'ring-accent/30'
    : 'ring-accent/30';
  const bg = team.domain
    ? DOMAIN_BG[team.domain.toLowerCase()] ?? 'bg-bg-elevated'
    : 'bg-bg-elevated';

  const visible = members.slice(0, 3);
  const overflow = Math.max(0, members.length - visible.length);
  const tileSize = Math.round(size * 0.72);
  const overlap = Math.round(tileSize * 0.32);
  const badgeSize = Math.max(10, Math.round(size * 0.35));

  // Total width = first tile + (rest * (tileSize - overlap)) + (+N chip if shown)
  const tilesWidth = tileSize + Math.max(0, visible.length - 1) * (tileSize - overlap);
  const totalWidth = tilesWidth + (showCount && overflow > 0 ? tileSize - overlap : 0);

  return (
    <div
      className={clsx(
        'relative flex-shrink-0 inline-flex items-center',
        onClick && 'cursor-pointer transition-all',
        className,
      )}
      style={{ width: totalWidth, height: size }}
      onClick={onClick}
      title={`${team.name} — ${members.length} members`}
    >
      <div className="relative inline-flex items-center" style={{ height: size }}>
        {visible.map((m, idx) => {
          const av = getAvatar(m.avatarUrl);
          return (
            <div
              key={m.id}
              className={clsx(
                'rounded-full overflow-hidden ring-2 ring-bg-primary',
                bg,
                onClick && 'transition-transform group-hover:translate-x-0',
              )}
              style={{
                width: tileSize,
                height: tileSize,
                marginLeft: idx === 0 ? 0 : -overlap,
                zIndex: visible.length - idx,
              }}
            >
              {av ? (
                <div
                  className="flex items-center justify-center w-full h-full select-none pointer-events-none"
                  aria-label={m.name}
                >
                  <span
                    className="twemoji leading-none"
                    style={{ fontSize: Math.round(tileSize * 0.7) }}
                  >
                    {av.emoji}
                  </span>
                </div>
              ) : (
                <div className="flex items-center justify-center w-full h-full text-text-secondary">
                  <Users size={Math.round(tileSize * 0.5)} />
                </div>
              )}
            </div>
          );
        })}
        {showCount && overflow > 0 && (
          <div
            className={clsx(
              'rounded-full ring-2 ring-bg-primary flex items-center justify-center text-[10px] font-medium text-text-secondary',
              bg,
            )}
            style={{
              width: tileSize,
              height: tileSize,
              marginLeft: -overlap,
              zIndex: 0,
            }}
          >
            +{overflow}
          </div>
        )}
      </div>
      <span
        className={clsx(
          'absolute -bottom-0.5 -right-0.5 rounded-full bg-bg-primary p-0.5 ring-1 flex items-center justify-center',
          ring,
        )}
        style={{ width: badgeSize + 4, height: badgeSize + 4 }}
      >
        {team.isVerified ? (
          <BadgeCheck size={badgeSize} className="text-accent" strokeWidth={2.25} />
        ) : (
          <Users size={badgeSize} className="text-text-secondary" />
        )}
      </span>
    </div>
  );
}
