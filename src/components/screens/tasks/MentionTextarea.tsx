import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { AtSign } from 'lucide-react';
import type { Expert } from '../../../context/ExpertContext';

const DROPDOWN_MAX_HEIGHT = 240;

interface DropdownPosition {
  left: number;
  width: number;
  placement: 'below' | 'above';
  top?: number;
  bottom?: number;
}

interface MentionTextareaProps {
  value: string;
  onChange: (next: string) => void;
  experts: Expert[];
  placeholder?: string;
  rows?: number;
  className?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
}

interface MentionState {
  triggerIndex: number;
  query: string;
}

function findMentionTrigger(value: string, caret: number): MentionState | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === '@') {
      const before = i === 0 ? undefined : value[i - 1];
      if (before === undefined || /\s/.test(before)) {
        const query = value.slice(i + 1, caret);
        if (query.includes('\n')) return null;
        return { triggerIndex: i, query };
      }
      return null;
    }
    if (ch === '\n') return null;
  }
  return null;
}

export default function MentionTextarea({
  value,
  onChange,
  experts,
  placeholder,
  rows = 3,
  className,
  autoFocus,
  onBlur,
}: MentionTextareaProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const skipNextSelectRef = useRef(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filteredExperts = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.trim().toLowerCase();
    if (!q) return experts.slice(0, 8);
    return experts.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 8);
  }, [experts, mention]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [mention?.query]);

  const updateMention = useCallback((text: string, caret: number) => {
    setMention(findMentionTrigger(text, caret));
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      const caret = e.target.selectionStart;
      onChange(next);
      updateMention(next, caret);
    },
    [onChange, updateMention],
  );

  const handleSelect = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      if (skipNextSelectRef.current) {
        skipNextSelectRef.current = false;
        return;
      }
      const el = e.currentTarget;
      updateMention(el.value, el.selectionStart);
    },
    [updateMention],
  );

  const insertMention = useCallback(
    (expert: Expert) => {
      if (!mention) return;
      const textarea = textareaRef.current;
      if (!textarea) return;
      const caret = textarea.selectionStart;
      const token = `@${expert.name}`;
      const next = value.slice(0, mention.triggerIndex) + token + ' ' + value.slice(caret);
      onChange(next);
      setMention(null);
      const newCaret = mention.triggerIndex + token.length + 1;
      requestAnimationFrame(() => {
        skipNextSelectRef.current = true;
        textarea.focus();
        textarea.setSelectionRange(newCaret, newCaret);
      });
    },
    [mention, value, onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mention || filteredExperts.length === 0) {
        if (e.key === 'Escape' && mention) {
          e.preventDefault();
          setMention(null);
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filteredExperts.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filteredExperts.length) % filteredExperts.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredExperts[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
      }
    },
    [mention, filteredExperts, selectedIndex, insertMention],
  );

  const handleBlur = useCallback(() => {
    setTimeout(() => {
      if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
        setMention(null);
        onBlur?.();
      }
    }, 120);
  }, [onBlur]);

  const popupOpen = !!mention;
  const [position, setPosition] = useState<DropdownPosition | null>(null);

  useEffect(() => {
    if (!popupOpen) {
      setPosition(null);
      return;
    }
    const update = () => {
      const el = textareaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const placement =
        spaceBelow < DROPDOWN_MAX_HEIGHT && spaceAbove > spaceBelow ? 'above' : 'below';
      setPosition({
        left: rect.left,
        width: rect.width,
        placement,
        top: placement === 'below' ? rect.bottom + 4 : undefined,
        bottom: placement === 'above' ? window.innerHeight - rect.top + 4 : undefined,
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [popupOpen]);

  return (
    <div ref={containerRef} className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={rows}
        autoFocus={autoFocus}
        className={className}
      />
      {popupOpen &&
        position &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: position.left,
              width: position.width,
              top: position.top,
              bottom: position.bottom,
              maxHeight: DROPDOWN_MAX_HEIGHT,
            }}
            className={clsx(
              'z-50 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg',
              'overflow-y-auto py-1',
            )}
          >
            {filteredExperts.length === 0 ? (
              <div className="px-3 py-2 text-xs text-text-tertiary">
                {t('tasks.mentionNoResults')}
              </div>
            ) : (
              filteredExperts.map((expert, index) => (
                <button
                  key={expert.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(expert);
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer',
                    index === selectedIndex
                      ? 'bg-accent/15 text-accent'
                      : 'text-text-primary hover:bg-bg-hover',
                  )}
                >
                  <AtSign size={12} className="flex-shrink-0" />
                  <span className="truncate">{expert.name}</span>
                  {expert.domain && (
                    <span className="ml-auto text-[10px] text-text-tertiary truncate">
                      {expert.domain}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
