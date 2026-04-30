/**
 * Sniff absolute file paths out of a Bash command string so the chat layer
 * can surface them as attachment chips.
 *
 * Cerebro auto-detects files the assistant writes via the `Write` / `Edit`
 * tools (the path comes through `file_path` in the tool args). For binary
 * formats — `.docx` produced by `python-docx`, `.xlsx` by `openpyxl`, etc. —
 * the agent shells out via `Bash` and the path is buried in the command
 * string. This helper extracts those.
 *
 * Trade-offs:
 *   - Regex-based, not parser-based: the agent's command can be anything,
 *     and a real shell parse is overkill. The regex is anchored to known
 *     deliverable extensions to keep false-positive rate low.
 *   - We don't verify existence here. If the path is wrong the chip just
 *     renders dimmed ("missing"); the cost of a false positive is small.
 *   - We don't recurse into shell substitutions / command groups. If the
 *     agent's path comes from `$VAR` or backticks, we miss it.
 */

const DELIVERABLE_EXTS = [
  // Office
  'docx', 'xlsx', 'xlsm', 'pptx', 'pdf',
  // Documents / data
  'html', 'htm', 'csv', 'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'xml',
  // Media
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp3', 'mp4', 'wav', 'ogg',
  // Archives
  'zip',
];

const PATH_REGEX = new RegExp(
  // Boundary: start, whitespace, common delimiters used in shell/python args.
  String.raw`(?<=^|[\s'"=(\`])` +
  // Capture: an absolute path, no spaces/quotes/backticks/closing paren.
  String.raw`(\/[^\s'"\`)]+?` +
  // Ending in one of the deliverable extensions, case-insensitive.
  String.raw`\.(?:` + DELIVERABLE_EXTS.join('|') + String.raw`))` +
  // Boundary on the right too — don't gobble trailing garbage.
  String.raw`(?=[\s'"\`)]|$)`,
  'gi',
);

/**
 * Returns the unique absolute paths referenced in `command`. Order is
 * preserved (first occurrence wins). Empty input yields an empty array.
 */
export function extractAbsolutePathsFromBashCommand(command: string): string[] {
  if (typeof command !== 'string' || !command.includes('/')) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  PATH_REGEX.lastIndex = 0;
  while ((match = PATH_REGEX.exec(command)) !== null) {
    const p = match[1];
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}
