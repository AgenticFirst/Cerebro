import { BadgeCheck, Bot, Users } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../../context/ExpertContext';
import { getAvatar } from '../../../../constants/avatars';

interface ExpertAvatarProps {
  expert: Expert;
  size?: number;
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

export default function ExpertAvatar({ expert, size = 32, className, onClick }: ExpertAvatarProps) {
  const avatar = getAvatar(expert.avatarUrl);
  const ring = expert.domain ? DOMAIN_RING[expert.domain.toLowerCase()] ?? 'ring-accent/30' : 'ring-accent/30';
  const iconSize = Math.round(size * 0.5);
  const badgeSize = Math.max(10, Math.round(size * 0.35));

  return (
    <div
      className={clsx(
        'relative flex-shrink-0',
        onClick && 'cursor-pointer transition-all',
      )}
      style={{ width: size, height: size }}
      onClick={onClick}
    >
      <div
        className={clsx(
          'w-full h-full rounded-full overflow-hidden bg-bg-elevated ring-1',
          ring,
          onClick && 'hover:ring-2',
        )}
      >
        {avatar ? (
          <img
            src={avatar.src}
            alt={expert.name}
            width={size}
            height={size}
            className="object-cover w-full h-full select-none pointer-events-none"
            draggable={false}
          />
        ) : (
          <div className="flex items-center justify-center w-full h-full text-text-secondary">
            {expert.type === 'team' ? <Users size={iconSize} /> : <Bot size={iconSize} />}
          </div>
        )}
      </div>
      {expert.isVerified && (
        <BadgeCheck
          size={badgeSize}
          className="absolute -bottom-0.5 -right-0.5 text-accent fill-bg-primary"
          strokeWidth={2.25}
        />
      )}
    </div>
  );
}
