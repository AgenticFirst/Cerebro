import { useState, useMemo } from 'react';
import { Bot, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { AVATAR_OPTIONS, getAvatar } from '../../../constants/avatars';

interface AvatarPickerProps {
  value: string | null;
  onChange: (id: string | null) => void;
}

export default function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  const [query, setQuery] = useState('');
  const selected = getAvatar(value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return AVATAR_OPTIONS;
    return AVATAR_OPTIONS.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.id.includes(q) ||
        a.keywords.some((k) => k.includes(q)),
    );
  }, [query]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-lg bg-bg-base border border-border-subtle flex items-center justify-center flex-shrink-0 overflow-hidden">
          {selected ? (
            <span className="twemoji text-3xl leading-none" aria-label={selected.label}>
              {selected.emoji}
            </span>
          ) : (
            <Bot size={20} className="text-text-tertiary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-text-secondary truncate">
            {selected ? selected.label : 'Default icon'}
          </div>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors mt-0.5"
            >
              <X size={10} />
              Clear
            </button>
          )}
        </div>
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            className="w-32 bg-bg-base border border-border-subtle rounded-md pl-6 pr-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors"
          />
        </div>
      </div>

      <div className="grid grid-cols-8 gap-1.5 max-h-64 overflow-y-auto scrollbar-thin bg-bg-base border border-border-subtle rounded-lg p-2">
        {filtered.length === 0 ? (
          <div className="col-span-8 text-center text-[11px] text-text-tertiary py-3">
            No matches
          </div>
        ) : (
          filtered.map((avatar) => {
            const isSelected = avatar.id === value;
            return (
              <button
                key={avatar.id}
                type="button"
                title={avatar.label}
                onClick={() => onChange(avatar.id)}
                className={clsx(
                  'aspect-square rounded-md flex items-center justify-center transition-colors',
                  isSelected
                    ? 'bg-accent/15 ring-1 ring-accent/60'
                    : 'hover:bg-bg-hover',
                )}
              >
                <span className="twemoji text-2xl leading-none" aria-label={avatar.label}>
                  {avatar.emoji}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
