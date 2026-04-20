import { marked } from 'marked';

/**
 * Render a markdown string to clean semantic HTML for the rich-clipboard
 * payload. Intentionally does NOT inject Tailwind/prose classes or
 * syntax-highlighter markup — the goal is HTML that pastes cleanly into
 * Google Docs / Notion / Gmail, where style classes would be stripped
 * anyway and only drag the payload size up.
 */
export function renderMarkdownToHtml(md: string): string {
  if (!md) return '';
  // marked.parse is synchronous when `async: false` (the default for v14 when
  // no async extensions are registered) but its type union includes Promise.
  // Cast the string branch so callers can use it as a pure function.
  return marked.parse(md, { gfm: true, breaks: false, async: false }) as string;
}
