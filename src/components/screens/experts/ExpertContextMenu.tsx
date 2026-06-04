import { useEffect, useRef, useCallback } from 'react';
import { Power, PowerOff, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Expert } from '../../../context/ExpertContext';

interface ExpertContextMenuProps {
  expert: Expert;
  position: { x: number; y: number };
  onClose: () => void;
  onToggleEnabled: (expert: Expert) => void;
  onTogglePinned: (expert: Expert) => void;
  onDelete: (id: string) => void;
}

export default function ExpertContextMenu({
  expert,
  position,
  onClose,
  onToggleEnabled,
  onTogglePinned,
  onDelete,
}: ExpertContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Viewport overflow guard — shift menu if it clips the edge
  const getAdjustedPosition = useCallback(() => {
    const menuW = 180;
    const menuH = expert.source !== 'builtin' ? 128 : 88; // approximate heights
    let x = position.x;
    let y = position.y;

    if (x + menuW > window.innerWidth - 8) x = window.innerWidth - menuW - 8;
    if (y + menuH > window.innerHeight - 8) y = window.innerHeight - menuH - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;

    return { x, y };
  }, [position, expert.source]);

  const adjusted = getAdjustedPosition();

  const items: Array<{
    icon: typeof Power;
    label: string;
    onClick: () => void;
    danger?: boolean;
  }> = [
    {
      icon: expert.isEnabled ? PowerOff : Power,
      label: expert.isEnabled ? 'Disable' : 'Enable',
      onClick: () => {
        onToggleEnabled(expert);
        onClose();
      },
    },
    {
      icon: expert.isPinned ? PinOff : Pin,
      label: expert.isPinned ? 'Unpin' : 'Pin',
      onClick: () => {
        onTogglePinned(expert);
        onClose();
      },
    },
  ];

  if (expert.source !== 'builtin') {
    items.push({
      icon: Trash2,
      label: 'Delete',
      danger: true,
      onClick: () => {
        onDelete(expert.id);
        onClose();
      },
    });
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] py-1 bg-bg-elevated border border-border-subtle rounded-lg shadow-xl animate-in fade-in duration-100"
      style={{ left: adjusted.x, top: adjusted.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.onClick}
          className={`
            w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium
            transition-colors duration-100
            ${
              item.danger
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
            }
          `}
        >
          <item.icon size={14} />
          {item.label}
        </button>
      ))}
    </div>
  );
}
