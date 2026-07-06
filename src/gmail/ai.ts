/**
 * Gmail AI helpers — all inference goes through the Claude Code CLI
 * (singleShotClaudeCode), never a cloud SDK. Pattern mirrors calendar/ai.ts.
 *
 *   - classifyThreads: batch-label new inbox threads into the split-inbox
 *     taxonomy (one call per sync tick, never per message).
 *   - summarizeThread: cached one-line conversation summary (computed lazily
 *     when a thread is opened, invalidated when the thread grows).
 *   - draftEmail: compose/reply in the user's own voice, grounded in their
 *     recent sent mail to that recipient.
 */

import { singleShotClaudeCode, ClaudeCodeUnavailableError } from '../claude-code/single-shot';

const MODEL = 'claude-haiku-4-5';

export const AI_LABELS = [
  'important',
  'awaiting_reply',
  'team',
  'marketing',
  'notifications',
] as const;
export type AiLabel = (typeof AI_LABELS)[number];

export interface ThreadToClassify {
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
}

/** Strip ``` fences and pull the first JSON object out of a model response. */
function extractJson(raw: string): unknown | null {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Classify up to ~25 threads in ONE model call. Returns provider thread id →
 * label; threads the model can't place are omitted (left unlabeled).
 */
export async function classifyThreads(
  threads: ThreadToClassify[],
): Promise<Record<string, AiLabel>> {
  if (!threads.length) return {};
  const prompt = [
    'You triage email into exactly one category per thread. Categories:',
    '- important: a real person writing to the user about something that matters (work, deals, personal) — needs attention.',
    '- team: colleagues/internal collaboration threads.',
    '- marketing: newsletters, promotions, cold outreach, product announcements.',
    '- notifications: automated service mail (receipts, alerts, CI, social, calendar notices).',
    '- awaiting_reply: ONLY when the thread clearly ends with the user asking something and waiting.',
    '',
    'Threads (JSON):',
    JSON.stringify(threads.slice(0, 25)),
    '',
    'Respond with ONLY a JSON object mapping thread_id to category, e.g. {"18c…":"marketing"}. No prose, no fences.',
  ].join('\n');

  try {
    const raw = await singleShotClaudeCode({ agent: 'cerebro', prompt, model: MODEL, maxTurns: 1 });
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, AiLabel> = {};
    for (const [id, label] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof label === 'string' && (AI_LABELS as readonly string[]).includes(label)) {
        out[id] = label as AiLabel;
      }
    }
    return out;
  } catch (err) {
    if (err instanceof ClaudeCodeUnavailableError) return {};
    console.error('[Gmail] classify failed:', err instanceof Error ? err.message : err);
    return {};
  }
}

export interface MessageForAi {
  from: string;
  date: string;
  body: string;
  outbound: boolean;
}

/** One-line summary shown above the thread and in the list. */
export async function summarizeThread(
  subject: string,
  messages: MessageForAi[],
): Promise<string | null> {
  if (!messages.length) return null;
  const slim = messages.slice(-10).map((m) => ({
    from: m.outbound ? 'me' : m.from,
    date: m.date,
    body: m.body.slice(0, 1_500),
  }));
  const prompt = [
    'Summarize this email conversation in ONE short line (max ~15 words) that tells the user the current state at a glance — like "Q3 budget agreed; Alice awaiting CFO sign-off".',
    'Write in the same language as the messages. No quotes, no trailing period needed.',
    '',
    `Subject: ${subject}`,
    'Messages (oldest→newest, JSON):',
    JSON.stringify(slim),
  ].join('\n');
  try {
    const raw = await singleShotClaudeCode({ agent: 'cerebro', prompt, model: MODEL, maxTurns: 1 });
    const line = raw.trim().split('\n')[0]?.trim();
    return line ? line.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export interface DraftInput {
  /** What the user wants the email to say (may be empty for a plain reply). */
  instruction: string;
  /** The conversation being replied to, when replying. */
  thread?: { subject: string; messages: MessageForAi[] };
  /** Recipient address(es) for context. */
  to: string;
  /** Recent messages the user SENT (ideally to this recipient) — voice samples. */
  voiceSamples: Array<{ to: string; body: string }>;
  senderName: string | null;
}

/** Draft an email body in the user's voice. Returns plain text or null. */
export async function draftEmail(input: DraftInput): Promise<string | null> {
  const samples = input.voiceSamples
    .slice(0, 8)
    .map((s, i) => `--- sample ${i + 1} (to ${s.to}) ---\n${s.body.slice(0, 1_200)}`)
    .join('\n');
  const threadPart = input.thread
    ? [
        `They are replying within this conversation (subject: ${input.thread.subject}):`,
        JSON.stringify(
          input.thread.messages.slice(-6).map((m) => ({
            from: m.outbound ? 'me' : m.from,
            body: m.body.slice(0, 1_500),
          })),
        ),
      ].join('\n')
    : 'This is a new email (no prior thread).';

  const prompt = [
    `You ghost-write email for ${input.senderName ?? 'the user'}. Write the BODY ONLY (no subject line, no headers).`,
    'Match their real voice exactly — greeting style, formality, sentence length, sign-off, and language — as shown in these messages they actually sent:',
    samples || '(no samples available — use a neutral, concise professional tone)',
    '',
    threadPart,
    '',
    `Recipient: ${input.to}`,
    input.instruction
      ? `What the email should say: ${input.instruction}`
      : 'Write the natural next reply to the conversation above.',
    '',
    'Output ONLY the email body text. No preamble, no explanations, no code fences.',
  ].join('\n');

  try {
    const raw = await singleShotClaudeCode({ agent: 'cerebro', prompt, model: MODEL, maxTurns: 1 });
    const text = raw.trim();
    return text || null;
  } catch (err) {
    if (err instanceof ClaudeCodeUnavailableError) return null;
    console.error('[Gmail] draft failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
