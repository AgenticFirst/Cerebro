import type { Message } from '../types/chat';
import type { AttachmentInfo } from '../types/attachments';

export interface ParseResult {
  attachments: AttachmentInfo[];
  text: string;
}

/**
 * Extract the file path from a single attachment-ref line, tolerating the
 * formatting the model sometimes adds around it: markdown wrapping
 * (`` `@/path` ``, `**@/path**`, `(@/path)`) and sentence punctuation stuck
 * to the path (`@/home/user/report.docx.` — which would otherwise break both
 * the extension badge and the on-disk stat). Returns null when the line
 * isn't a ref.
 */
function refPathFromLine(rawLine: string): string | null {
  let line = rawLine.trim();
  // Peel markdown wrappers so the `@` is the first character.
  line = line.replace(/^[`*_~("'«[]+/, '').replace(/[`*~)"'»\]]+$/, '');
  if (!line.startsWith('@/') && !line.startsWith('@~')) return null;
  const filePath = line.slice(1).replace(/[.,;:!?…'"»)\]]+$/, '');
  if (!filePath.startsWith('/') && !filePath.startsWith('~/')) return null;
  return filePath;
}

function toAttachment(filePath: string): AttachmentInfo {
  const fileName = filePath.split('/').pop() || filePath;
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return { id: filePath, filePath, fileName, fileSize: 0, extension: ext };
}

/**
 * User-message convention: zero or more leading lines starting with `@/` or
 * `@~` are file-path attachment refs. Strip them from the displayed text; the
 * UI renders them as attachment chips instead.
 */
export function parseFileRefs(content: string): ParseResult {
  const lines = content.split('\n');
  const attachments: AttachmentInfo[] = [];
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const filePath = refPathFromLine(line);
    if (!filePath) break;
    attachments.push(toAttachment(filePath));
  }

  return { attachments, text: lines.slice(i).join('\n').trim() };
}

/**
 * Assistant-message convention: any *standalone* line starting with `@/` or
 * `@~` is a file the expert produced — stripped from the displayed text and
 * rendered as an attachment chip. The prompt asks for these as the trailing
 * lines of the reply, but models sometimes drop the ref mid-message ("here
 * you go: @/path … let me know"), so every standalone ref line counts, not
 * just the trailing block. Lines inside fenced code blocks are never refs —
 * they're example content.
 */
export function parseTrailingFileRefs(content: string): ParseResult {
  const lines = content.split('\n');
  const attachments: AttachmentInfo[] = [];
  const seen = new Set<string>();
  const kept: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    const filePath = inFence ? null : refPathFromLine(line);
    if (!filePath) {
      kept.push(line);
      continue;
    }
    if (!seen.has(filePath)) {
      seen.add(filePath);
      attachments.push(toAttachment(filePath));
    }
    // Removing a mid-message ref line can leave two adjacent blank lines;
    // drop one so the remaining markdown keeps its original rhythm.
    if (
      kept.length > 0 &&
      kept[kept.length - 1].trim() === '' &&
      (lines[i + 1] ?? '').trim() === ''
    ) {
      i++;
    }
  }

  return { attachments, text: kept.join('\n').trimEnd() };
}

/**
 * Remove model-internal tags that should never be shown to the user and must
 * never end up on the clipboard. Handles both complete pairs and fragments
 * that span chunks during streaming.
 */
export function stripModelTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .replace(/^[\s\S]*?<\/think>\s*/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, '')
    .replace(/<tool_call>[\s\S]*$/g, '')
    .replace(/<\/tool_call>\s*/g, '')
    .replace(/<\/think>\s*/g, '')
    .trimStart();
}

/**
 * The exact markdown string that should hit the clipboard when a user clicks
 * "Copy" on a message. Strips attachment refs and model-internal tags but
 * preserves all user-facing markdown (headings, lists, code fences, tables).
 *
 * Returns "" if the message has no textual payload — callers should use that
 * to hide the copy button on proposal-only / attachment-only messages.
 */
export function getCopyableContent(message: Pick<Message, 'role' | 'content'>): string {
  if (message.role === 'user') {
    return parseFileRefs(message.content).text;
  }
  const { text } = parseTrailingFileRefs(message.content);
  return stripModelTags(text);
}
