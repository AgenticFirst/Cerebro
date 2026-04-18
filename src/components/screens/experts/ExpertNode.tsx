import { BadgeCheck, Brain, Bot, Users, Pin } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../context/ExpertContext';
import { getAvatar } from '../../../constants/avatars';

// ── Domain glow colors ─────────────────────────────────────────

const DOMAIN_GLOWS: Record<string, { border: string; shadow: string; color: string }> = {
  productivity: {
    border: 'rgba(59, 130, 246, 0.6)',
    shadow: '0 0 16px rgba(59, 130, 246, 0.35), 0 0 48px rgba(59, 130, 246, 0.1)',
    color: '#3b82f6',
  },
  health: {
    border: 'rgba(16, 185, 129, 0.6)',
    shadow: '0 0 16px rgba(16, 185, 129, 0.35), 0 0 48px rgba(16, 185, 129, 0.1)',
    color: '#10b981',
  },
  finance: {
    border: 'rgba(245, 158, 11, 0.6)',
    shadow: '0 0 16px rgba(245, 158, 11, 0.35), 0 0 48px rgba(245, 158, 11, 0.1)',
    color: '#f59e0b',
  },
  creative: {
    border: 'rgba(168, 85, 247, 0.6)',
    shadow: '0 0 16px rgba(168, 85, 247, 0.35), 0 0 48px rgba(168, 85, 247, 0.1)',
    color: '#a855f7',
  },
  engineering: {
    border: 'rgba(249, 115, 22, 0.6)',
    shadow: '0 0 16px rgba(249, 115, 22, 0.35), 0 0 48px rgba(249, 115, 22, 0.1)',
    color: '#f97316',
  },
  research: {
    border: 'rgba(99, 102, 241, 0.6)',
    shadow: '0 0 16px rgba(99, 102, 241, 0.35), 0 0 48px rgba(99, 102, 241, 0.1)',
    color: '#6366f1',
  },
};

const DEFAULT_GLOW = {
  border: 'rgba(6, 182, 212, 0.5)',
  shadow: '0 0 14px rgba(6, 182, 212, 0.3), 0 0 40px rgba(6, 182, 212, 0.08)',
  color: '#06b6d4',
};

const CEREBRO_GLOW = {
  border: 'rgba(245, 158, 11, 0.65)',
  shadow: '0 0 24px rgba(245, 158, 11, 0.45), 0 0 64px rgba(245, 158, 11, 0.15)',
  color: '#f59e0b',
};

function getGlow(domain: string | null, isCerebro: boolean) {
  if (isCerebro) return CEREBRO_GLOW;
  if (domain) return DOMAIN_GLOWS[domain.toLowerCase()] ?? DEFAULT_GLOW;
  return DEFAULT_GLOW;
}

// ── Component ──────────────────────────────────────────────────

interface ExpertNodeProps {
  expert?: Expert;
  isCerebro?: boolean;
  isSelected?: boolean;
  x: number;
  y: number;
  index: number;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export default function ExpertNode({
  expert,
  isCerebro,
  isSelected,
  x,
  y,
  index,
  onClick,
  onContextMenu,
}: ExpertNodeProps) {
  const glow = getGlow(expert?.domain ?? null, !!isCerebro);
  const isEnabled = expert?.isEnabled ?? true;
  const boxSize = isCerebro ? 80 : 64;
  const iconSize = isCerebro ? 36 : 26;
  const avatar = isCerebro ? null : getAvatar(expert?.avatarUrl);
  const avatarSize = isCerebro ? 64 : 52;

  return (
    <div
      className={clsx(
        'expert-node absolute flex flex-col items-center cursor-pointer animate-node-in',
        'transition-[filter,opacity] duration-200',
        !isEnabled && 'opacity-40',
      )}
      style={{
        left: x,
        top: y,
        transform: 'translate(-50%, 0)',
        animationDelay: `${index * 60}ms`,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onContextMenu={onContextMenu}
    >
      {/* Icon box with colored glow border */}
      <div
        className="relative rounded-xl flex items-center justify-center transition-shadow duration-200"
        style={{
          width: boxSize,
          height: boxSize,
          backgroundColor: 'rgba(13, 13, 16, 0.95)',
          border: `2.5px solid ${glow.border}`,
          boxShadow: isSelected
            ? `${glow.shadow}, 0 0 0 3px ${glow.border}`
            : glow.shadow,
        }}
      >
        {isCerebro ? (
          <Brain size={iconSize} style={{ color: glow.color }} />
        ) : avatar ? (
          <img
            src={avatar.src}
            alt={avatar.label}
            width={avatarSize}
            height={avatarSize}
            className="object-contain pointer-events-none select-none"
            draggable={false}
          />
        ) : expert?.type === 'team' ? (
          <Users size={iconSize} style={{ color: glow.color }} />
        ) : (
          <Bot size={iconSize} style={{ color: glow.color }} />
        )}

        {/* Pin badge */}
        {!isCerebro && expert?.isPinned && (
          <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg-base border border-border-subtle flex items-center justify-center">
            <Pin size={10} className="text-accent" />
          </div>
        )}
        {/* Verified badge */}
        {!isCerebro && expert?.isVerified && (
          <BadgeCheck
            size={18}
            className="absolute -bottom-1.5 -right-1.5 text-accent fill-bg-base"
            strokeWidth={2.25}
          />
        )}
      </div>

      {/* Status dot + name */}
      <div className="flex items-center gap-1.5 mt-2.5">
        <div
          className="w-[7px] h-[7px] rounded-full flex-shrink-0"
          style={{
            backgroundColor: isEnabled ? '#22c55e' : '#71717a',
            boxShadow: isEnabled ? '0 0 6px rgba(34, 197, 94, 0.5)' : 'none',
          }}
        />
        <span
          className={clsx(
            'inline-flex items-center gap-1 text-xs font-medium leading-tight',
            isSelected ? 'text-text-primary' : 'text-text-secondary',
          )}
        >
          {isCerebro ? 'Cerebro' : expert?.name}
          {!isCerebro && expert?.isVerified && (
            <BadgeCheck size={11} className="text-accent" strokeWidth={2.25} />
          )}
        </span>
      </div>

      {/* Subtitle */}
      <span className="text-[10px] text-text-tertiary mt-0.5 max-w-[120px] truncate text-center leading-tight">
        {isCerebro
          ? 'Lead Expert'
          : expert?.domain
            ? expert.domain.charAt(0).toUpperCase() + expert.domain.slice(1)
            : expert?.description?.slice(0, 30)}
      </span>
    </div>
  );
}
