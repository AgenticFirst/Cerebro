import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface TagChipInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  className?: string;
}

function normalize(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

export default function TagChipInput({ tags, onChange, suggestions = [], className }: TagChipInputProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = useCallback(
    (raw: string) => {
      const tag = normalize(raw);
      if (!tag || tag.length > 32) return;
      if (tags.includes(tag)) return;
      onChange([...tags, tag]);
      setDraft('');
      setShowSuggestions(false);
    },
    [tags, onChange],
  );

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((x) => x !== tag));
    },
    [tags, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (draft.trim()) addTag(draft);
    } else if (e.key === 'Backspace' && !draft && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const filteredSuggestions = draft
    ? suggestions.filter(
        (s) => s.includes(normalize(draft)) && !tags.includes(s),
      )
    : suggestions.filter((s) => !tags.includes(s));

  return (
    <div className={clsx('relative', className)}>
      <div
        onClick={() => inputRef.current?.focus()}
        className="flex flex-wrap items-center gap-1.5 bg-bg-elevated border border-border-subtle rounded-md px-2 py-1.5 cursor-text focus-within:border-accent/40 transition-colors"
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium bg-accent/10 text-accent rounded-full"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
              className="text-accent/70 hover:text-accent cursor-pointer"
              title={t('tasks.drawerRemoveTag')}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
          placeholder={tags.length === 0 ? t('tasks.drawerAddTag') : ''}
          className="flex-1 min-w-[80px] bg-transparent text-xs text-text-primary placeholder:text-text-tertiary outline-none"
        />
      </div>

      {showSuggestions && filteredSuggestions.length > 0 && (
        <div className="absolute z-30 mt-1 left-0 right-0 max-h-40 overflow-y-auto bg-bg-elevated border border-border-subtle rounded-md shadow-lg py-1">
          {filteredSuggestions.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
              className="w-full text-left px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
