import { useEffect, useMemo, useRef, useState } from 'react';
import emojiGroups from 'unicode-emoji-json/data-by-group.json';
import { useTranslation } from 'react-i18next';

interface EmojiEntry {
  emoji: string;
  name: string;
  slug: string;
}
interface EmojiGroup {
  name: string;
  slug: string;
  emojis: EmojiEntry[];
}

const GROUPS = emojiGroups as unknown as EmojiGroup[];
const ALL: EmojiEntry[] = GROUPS.flatMap((g) => g.emojis);

/**
 * Compact emoji popover for page icons. Filterable by name/slug, grouped when
 * unfiltered. Renders glyphs with the Twemoji font for cross-platform parity.
 */
export function EmojiPicker({
  onSelect,
  onRemove,
  onClose,
  hasIcon,
}: {
  onSelect: (emoji: string) => void;
  onRemove: () => void;
  onClose: () => void;
  hasIcon: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL.filter((e) => e.name.includes(q) || e.slug.includes(q)).slice(0, 120);
  }, [query]);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 top-full mt-1 z-50 w-[340px] rounded-xl border border-border-default bg-bg-elevated shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 p-2 border-b border-border-subtle">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('knowledgeBase.searchEmoji')}
            className="flex-1 bg-bg-base/60 rounded-md px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary outline-none border border-border-subtle focus:border-border-accent"
          />
          {hasIcon && (
            <button
              onClick={onRemove}
              className="px-2 py-1.5 text-[12px] text-text-tertiary hover:text-red-400 rounded-md hover:bg-white/[0.04] cursor-pointer whitespace-nowrap"
            >
              {t('knowledgeBase.removeIcon')}
            </button>
          )}
        </div>

        <div className="max-h-[280px] overflow-y-auto scrollbar-thin p-2">
          {filtered ? (
            <div className="grid grid-cols-9 gap-0.5">
              {filtered.map((e) => (
                <EmojiButton key={e.slug} entry={e} onSelect={onSelect} />
              ))}
              {filtered.length === 0 && (
                <p className="col-span-9 text-center text-[12px] text-text-tertiary py-6">—</p>
              )}
            </div>
          ) : (
            GROUPS.map((group) => (
              <div key={group.slug} className="mb-2">
                <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary select-none">
                  {group.name}
                </div>
                <div className="grid grid-cols-9 gap-0.5">
                  {group.emojis.map((e) => (
                    <EmojiButton key={e.slug} entry={e} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function EmojiButton({ entry, onSelect }: { entry: EmojiEntry; onSelect: (emoji: string) => void }) {
  return (
    <button
      onClick={() => onSelect(entry.emoji)}
      title={entry.name}
      className="twemoji flex items-center justify-center w-8 h-8 rounded-md text-[20px] leading-none hover:bg-white/[0.08] cursor-pointer"
    >
      {entry.emoji}
    </button>
  );
}
