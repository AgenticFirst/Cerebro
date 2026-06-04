/**
 * Auto-title helper for chat conversations.
 *
 * Spawns a one-shot Claude Code call (Haiku, no tools) that turns the first
 * user message — and optionally the first assistant response — into a short,
 * descriptive conversation title. Used by ChatContext to fill in the sidebar
 * label as soon as the user submits their first prompt.
 *
 * Best-effort: any failure resolves to `null` so the chat path is never broken
 * by title generation.
 */

import { singleShotClaudeCode, ClaudeCodeUnavailableError } from './single-shot';

const TITLE_MODEL = 'claude-haiku-4-5';
const MAX_TITLE_LENGTH = 60;
const MAX_INPUT_CHARS = 2000;

export interface GenerateTitleOptions {
  userMessage: string;
  assistantResponse?: string;
  signal?: AbortSignal;
}

export async function generateConversationTitle(
  opts: GenerateTitleOptions,
): Promise<string | null> {
  const user = clip(opts.userMessage, MAX_INPUT_CHARS);
  if (!user.trim()) return null;
  const assistant = opts.assistantResponse ? clip(opts.assistantResponse, MAX_INPUT_CHARS) : '';

  const prompt = buildPrompt(user, assistant);

  try {
    const raw = await singleShotClaudeCode({
      agent: 'cerebro',
      prompt,
      model: TITLE_MODEL,
      signal: opts.signal,
    });
    return sanitizeTitle(raw);
  } catch (err) {
    if (err instanceof ClaudeCodeUnavailableError) return null;
    console.warn('[auto-title] generation failed:', (err as Error).message);
    return null;
  }
}

function buildPrompt(userMessage: string, assistantResponse: string): string {
  const header =
    'You are naming a conversation for a sidebar list. Output ONLY the title — no quotes, no trailing punctuation, no commentary, no markdown, no emoji. Keep it 3–6 words. Match the language of the user message (Spanish in → Spanish title, English in → English title). Title case is fine; sentence case is fine.';

  if (assistantResponse) {
    return `${header}\n\n<user_message>\n${userMessage}\n</user_message>\n\n<assistant_response>\n${assistantResponse}\n</assistant_response>\n\nTitle:`;
  }
  return `${header}\n\n<user_message>\n${userMessage}\n</user_message>\n\nTitle:`;
}

function sanitizeTitle(raw: string): string | null {
  if (!raw) return null;
  let t = raw.replace(/\r/g, '').trim();
  if (!t) return null;

  // Some models prefix with "Title:" or wrap in a fenced block — strip that.
  t = t
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  t = t.replace(/^title\s*[:-]\s*/i, '').trim();

  // Take first non-empty line only — guards against rare paragraph outputs.
  const firstLine = t
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  t = firstLine;

  // Strip wrapping quotes/backticks/asterisks.
  t = t.replace(/^[`"'*_]+|[`"'*_]+$/g, '').trim();
  // Drop trailing punctuation (.,;:!?) but keep ? if the prompt was clearly a question — simpler to just strip.
  t = t.replace(/[.,;:!?]+$/g, '').trim();

  if (!t) return null;
  if (t.length > MAX_TITLE_LENGTH) {
    t = t.slice(0, MAX_TITLE_LENGTH).trimEnd();
  }

  // Refusal / error sniff — if the model returned a sentence-shape paragraph
  // or a refusal, bail. Real titles are short.
  if (t.split(/\s+/).length > 12) return null;

  return t;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
