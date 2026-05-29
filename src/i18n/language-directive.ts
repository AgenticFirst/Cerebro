/**
 * Shared language directive for AI subprocess system prompts.
 *
 * Used by both ClaudeCodeRunner (stream-adapter.ts) and TaskPtyRunner
 * (runtime.ts) to instruct the AI to respond in the user's language and
 * to bias the model toward fast / medium / slow behavior per the chat
 * input chip.
 */

import type { QualityTier } from '../types/ipc';

/** Map of supported language codes to human-readable names for the AI directive. */
export const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish / Español',
};

/** Subagent name of the top-level Cerebro main agent (the chat assistant
 *  that picks experts/teams). Other agentNames are individual experts or
 *  team coordinators, which get a simpler tier directive. */
export const CEREBRO_AGENT_NAME = 'cerebro';

const BASE_SYSTEM_PROMPT =
  'CRITICAL: Never generate text on behalf of the user. Never output "User:" or simulate user messages. Your response ends when you have answered the request.';

const CEREBRO_TIER_DIRECTIVE: Record<QualityTier, string> = {
  fast: `

QUALITY_TIER: fast

The user has selected FAST mode. Optimize for speed.
- Prefer single-expert delegation. Do NOT invoke teams unless the user explicitly named a team or the request is impossible without one.
- If a team is unavoidable, begin the prompt you send via the Agent tool with the literal token \`[QUALITY_TIER=fast]\` on its own first line.
- Keep your reply concise — direct answer first, no extensive preamble.`,

  medium: `

QUALITY_TIER: medium

When delegating to a team, begin the Agent prompt with \`[QUALITY_TIER=medium]\` on its own first line. After the team returns, surface its main artifact in your reply with minimal edits — only trim duplication.`,

  slow: `

QUALITY_TIER: slow

The user has selected SLOW mode for this turn. Optimize for depth over speed.

When the request would benefit from a multi-disciplinary team:
- Delegate to the most relevant team. Begin the prompt you send via the Agent tool with the literal token \`[QUALITY_TIER=slow]\` on its own first line.
- After the team returns, FORWARD ITS DELIVERABLE VERBATIM in your chat reply. Do not paraphrase, summarize, or condense. Add only a one-line preface in the user's language (e.g. "Here is the plan from {team_name}:") and quote the deliverable in full.
- If the user asked for a multi-day plan, the reply MUST contain day-by-day detail. If the request would benefit from concrete reference media (instructional videos, illustrated guides, links), the reply MUST include those links inline. Do not strip them out.

Skip the verbatim-forward rule for trivial single-expert requests that don't need a team.`,
};

const EXPERT_TIER_DIRECTIVE: Record<QualityTier, string> = {
  fast: `

QUALITY_TIER: fast
The user wants a quick answer. Be direct. Skip preamble. Use minimal tools. Aim for under ~200 words unless the task strictly requires more.`,

  // Medium = current behavior, no-op directive.
  medium: '',

  slow: `

QUALITY_TIER: slow
The user wants a deep, thorough answer. Take your time, use whatever tools help, provide concrete day-by-day or step-by-step detail when the task allows. Include reference links or videos when they'd help. Don't condense.`,
};

/**
 * Build the `--append-system-prompt` value, optionally including a
 * language directive (when the UI language is not English) and a
 * quality-tier directive (when the user picked Fast or Slow).
 *
 * The directive flavor depends on `agentName`: the top-level Cerebro main
 * agent gets team-aware instructions (forward verbatim, prepend the
 * `[QUALITY_TIER=...]` marker); individual experts and team coordinators
 * get a generic depth/speed framing.
 */
export function buildSystemPrompt(
  language?: string,
  qualityTier?: QualityTier,
  agentName?: string,
): string {
  let prompt = BASE_SYSTEM_PROMPT;

  if (language && language !== 'en') {
    const langName = LANGUAGE_NAMES[language] || language;
    prompt += `\n\nIMPORTANT: You MUST respond in ${langName}. All your text output — explanations, summaries, instructions, and conversational replies — must be in ${langName}. Technical terms, code, file paths, and brand names (like "Cerebro") remain in their original language.`;
  }

  if (qualityTier) {
    const isCerebro = agentName === CEREBRO_AGENT_NAME;
    const directive = isCerebro
      ? CEREBRO_TIER_DIRECTIVE[qualityTier]
      : EXPERT_TIER_DIRECTIVE[qualityTier];
    if (directive) prompt += directive;
  }

  return prompt;
}
