/**
 * Convert standard CommonMark text to Slack mrkdwn.
 *
 * Slack's mrkdwn diverges from CommonMark:
 *  - `*bold*`        not `**bold**`
 *  - `_italic_`      not `*italic*`
 *  - `~strike~`      not `~~strike~~`
 *  - `<url|text>`    not `[text](url)`
 *  - no headers, no tables, no horizontal rules, no image syntax.
 *
 * Output is meant to be passed to chat.postMessage / chat.update with
 * `mrkdwn: true`. The function is pure and never throws — if a transform
 * doesn't match, the original text passes through unchanged.
 */

const SENTINEL_CODE_BLOCK = '\x00CB';
const SENTINEL_INLINE_CODE = '\x00IC';
const SENTINEL_BOLD = '\x00B\x00';

export function markdownToMrkdwn(input: string): string {
  if (!input) return input;

  // 1. Protect existing fenced code blocks first so the table converter
  //    can't misread `|---|` lines living inside a code block as a table.
  const codeBlocks: string[] = [];
  const captureBlock = (m: string): string => {
    codeBlocks.push(m);
    return `${SENTINEL_CODE_BLOCK}${codeBlocks.length - 1}\x00`;
  };
  let work = input.replace(/```[\s\S]*?```/g, captureBlock);

  // 2. GFM tables → fenced code block (closest legible fallback). The new
  //    fences are then captured by a second protection pass so subsequent
  //    transforms don't touch their interior either.
  work = convertTables(work);
  work = work.replace(/```[\s\S]*?```/g, captureBlock);

  // 3. Protect inline code.
  const inlineCode: string[] = [];
  work = work.replace(/`[^`\n]+`/g, (m) => {
    inlineCode.push(m);
    return `${SENTINEL_INLINE_CODE}${inlineCode.length - 1}\x00`;
  });

  // 3. ATX headers → bold. Use the bold sentinel rather than literal `*` so
  //    the italic pass later on can't re-interpret the asterisks as emphasis.
  work = work.replace(
    /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    `${SENTINEL_BOLD}$1${SENTINEL_BOLD}`,
  );

  // 4. Horizontal rules → blank line.
  work = work.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');

  // 5. Images `![alt](url)` → `<url|alt>` (before the link pass).
  work = work.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_, alt: string, url: string) => `<${url}|${alt || url}>`,
  );

  // 6. Links `[text](url)` → `<url|text>`.
  work = work.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_, text: string, url: string) => `<${url}|${text}>`,
  );

  // 7. Bold (`**…**` and `__…__`) → sentinel, restored as single `*` after
  //    the italic pass so the italic regex doesn't re-match leftover `*`s.
  work = work.replace(/\*\*([^*\n]+?)\*\*/g, `${SENTINEL_BOLD}$1${SENTINEL_BOLD}`);
  work = work.replace(/__([^_\n]+?)__/g, `${SENTINEL_BOLD}$1${SENTINEL_BOLD}`);

  // 8. Strikethrough `~~…~~` → `~…~`.
  work = work.replace(/~~([^~\n]+?)~~/g, '~$1~');

  // 9. List markers (`-`, `*`, `+`) at line start → `•`. Done before italic so
  //    a stray line-leading `*` can never be re-interpreted as emphasis.
  work = work.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');

  // 10. Italic `*…*` → `_…_`. CommonMark requires no whitespace adjacent to
  //     the asterisks, which also rules out arithmetic like `2 * 3 * 5`.
  work = work.replace(
    /(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g,
    (_m, lead: string, body: string) => `${lead}_${body}_`,
  );

  // 11. Restore sentinels.
  work = work.replace(new RegExp(SENTINEL_BOLD, 'g'), '*');
  work = work.replace(
    new RegExp(`${SENTINEL_INLINE_CODE}(\\d+)\\x00`, 'g'),
    (_, i: string) => inlineCode[Number(i)],
  );
  work = work.replace(
    new RegExp(`${SENTINEL_CODE_BLOCK}(\\d+)\\x00`, 'g'),
    (_, i: string) => codeBlocks[Number(i)],
  );

  return work;
}

function convertTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const looksLikeRow = /^\s*\|.*\|\s*$/.test(lines[i]);
    const sep = i + 1 < lines.length ? lines[i + 1] : '';
    const looksLikeSeparator = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(sep);
    if (looksLikeRow && looksLikeSeparator) {
      const block: string[] = [lines[i].trim()];
      i += 2; // skip the separator
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        block.push(lines[i].trim());
        i++;
      }
      out.push('```');
      out.push(...block);
      out.push('```');
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}
