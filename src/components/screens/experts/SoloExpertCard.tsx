import { BadgeCheck, Bot, Pin } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../context/ExpertContext';
import { getAvatar } from '../../../constants/avatars';

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

interface SoloExpertCardProps {
  expert: Expert;
  isSelected: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export default function SoloExpertCard({
  expert,
  isSelected,
  onClick,
  onContextMenu,
}: SoloExpertCardProps) {
  const accent = accentFor(expert.domain);
  const avatar = getAvatar(expert.avatarUrl);

  const subtitle = expert.domain
    ? expert.domain.charAt(0).toUpperCase() + expert.domain.slice(1)
    : expert.description?.slice(0, 40) ?? '';

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onContextMenu={onContextMenu}
      className={clsx(
        'expert-node relative rounded-xl bg-bg-surface border overflow-hidden flex items-center gap-3 px-3 py-3 text-left transition-all duration-150',
        isSelected
          ? 'border-accent/50 shadow-[0_0_0_3px_rgba(6,182,212,0.08)]'
          : 'border-border-subtle hover:border-border-default',
        !expert.isEnabled && 'opacity-60',
      )}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px]"
        style={{ backgroundColor: accent }}
      />
      <div
        className="relative w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
        style={{
          backgroundColor: 'rgba(13, 13, 16, 0.95)',
          border: `1.5px solid ${accent}66`,
        }}
      >
        {avatar ? (
          <img
            src={avatar.src}
            alt={avatar.label}
            width={40}
            height={40}
            className="object-contain pointer-events-none select-none"
            draggable={false}
          />
        ) : (
          <Bot size={20} style={{ color: accent }} />
        )}
        {expert.isPinned && (
          <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-bg-base border border-border-subtle flex items-center justify-center">
            <Pin size={8} className="text-accent" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={clsx(
              'text-sm font-medium truncate',
              isSelected ? 'text-text-primary' : 'text-text-secondary',
            )}
            title={expert.name}
          >
            {expert.name}
          </span>
          {expert.isVerified && (
            <BadgeCheck
              size={12}
              className="text-accent flex-shrink-0"
              strokeWidth={2.25}
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <div
            className="w-[6px] h-[6px] rounded-full flex-shrink-0"
            style={{
              backgroundColor: expert.isEnabled ? '#22c55e' : '#71717a',
            }}
          />
          <span
            className="text-[11px] text-text-tertiary truncate"
            title={subtitle}
          >
            {subtitle}
          </span>
        </div>
      </div>
    </button>
  );
}
