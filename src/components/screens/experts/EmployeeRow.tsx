import { BadgeCheck, Bot, Pin } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../context/ExpertContext';
import { getAvatar } from '../../../constants/avatars';

interface EmployeeRowProps {
  expert: Expert;
  role?: string;
  isSelected?: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export default function EmployeeRow({
  expert,
  role,
  isSelected,
  onClick,
  onContextMenu,
}: EmployeeRowProps) {
  const avatar = getAvatar(expert.avatarUrl);
  const isEnabled = expert.isEnabled;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onContextMenu={onContextMenu}
      className={clsx(
        'expert-node group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
        isSelected
          ? 'bg-accent/10 ring-1 ring-accent/40'
          : 'hover:bg-bg-hover',
        !isEnabled && 'opacity-50',
      )}
    >
      <div className="relative w-7 h-7 rounded-lg bg-bg-base border border-border-subtle flex items-center justify-center flex-shrink-0 overflow-hidden">
        {avatar ? (
          <img
            src={avatar.src}
            alt={avatar.label}
            width={28}
            height={28}
            className="object-contain pointer-events-none select-none"
            draggable={false}
          />
        ) : (
          <Bot size={14} className="text-text-tertiary" />
        )}
      </div>

      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span
          className={clsx(
            'text-xs font-medium truncate',
            isSelected ? 'text-text-primary' : 'text-text-secondary',
          )}
          title={expert.name}
        >
          {expert.name}
        </span>
        {expert.isVerified && (
          <BadgeCheck
            size={11}
            className="text-accent flex-shrink-0"
            strokeWidth={2.25}
          />
        )}
        {expert.isPinned && (
          <Pin size={10} className="text-accent flex-shrink-0" />
        )}
      </div>

      {role && (
        <span
          className="text-[10px] text-text-tertiary max-w-[100px] truncate flex-shrink-0"
          title={role}
        >
          {role}
        </span>
      )}

      <div
        className="w-[6px] h-[6px] rounded-full flex-shrink-0"
        style={{
          backgroundColor: isEnabled ? '#22c55e' : '#71717a',
          boxShadow: isEnabled ? '0 0 4px rgba(34, 197, 94, 0.5)' : 'none',
        }}
      />
    </button>
  );
}
