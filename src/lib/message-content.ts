import type { Message } from '../types/chat';
import type { AttachmentInfo } from '../types/attachments';

export interface ParseResult {
  attachments: AttachmentInfo[];
  text: string;
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
    if (line.startsWith('@/') || line.startsWith('@~')) {
      const filePath = line.slice(1);
      const fileName = filePath.split('/').pop() || filePath;
      const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
      attachments.push({ id: filePath, filePath, fileName, fileSize: 0, extension: ext });
    } else if (line === '') {
      continue;
    } else {
      break;
    }
  }

  return { attachments, text: lines.slice(i).join('\n').trim() };
}

/**
 * Assistant-message convention: attachment refs live at the *end* of the
 * message (an expert finishes its reply, then emits `@/path` lines for any
 * files it produced).
 */
export function parseTrailingFileRefs(content: string): ParseResult {
  const lines = content.split('\n');
  const attachments: AttachmentInfo[] = [];
  let cut = lines.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('@/') || line.startsWith('@~')) {
      const filePath = line.slice(1);
      const fileName = filePath.split('/').pop() || filePath;
      const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
      attachments.unshift({ id: filePath, filePath, fileName, fileSize: 0, extension: ext });
      cut = i;
    } else if (line === '') {
      continue;
    } else {
      break;
    }
  }

  return { attachments, text: lines.slice(0, cut).join('\n').trimEnd() };
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
