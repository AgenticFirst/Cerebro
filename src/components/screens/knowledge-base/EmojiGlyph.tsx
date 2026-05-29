/**
 * Render an emoji with the Twemoji COLR font so page icons look identical on
 * Mac/Windows/Linux (same approach as expert avatars). `size` is the font-size
 * in px; line-height is collapsed so the glyph aligns with adjacent text.
 */
export function EmojiGlyph({ emoji, size = 16 }: { emoji: string; size?: number }) {
  return (
    <span
      className="twemoji leading-none inline-block"
      style={{ fontSize: `${size}px` }}
      aria-hidden="true"
    >
      {emoji}
    </span>
  );
}
