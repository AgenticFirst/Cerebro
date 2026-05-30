import { FileText } from 'lucide-react';
import { EmojiGlyph } from './EmojiGlyph';

/**
 * A page's leading icon in lists/trees: its emoji, or a generic document glyph
 * when it has none. Centralizes the markup the tree, search results, trash, and
 * drag overlay all share.
 */
export function PageIcon({ icon }: { icon: string | null }) {
  return (
    <span className="flex items-center justify-center w-4 h-4 flex-shrink-0 text-text-tertiary">
      {icon ? <EmojiGlyph emoji={icon} size={14} /> : <FileText size={13} strokeWidth={1.5} />}
    </span>
  );
}
