/**
 * Shared language directive for AI subprocess system prompts.
 *
 * Used by both ClaudeCodeRunner (stream-adapter.ts) and TaskPtyRunner
 * (runtime.ts) to instruct the AI to respond in the user's language.
 */

/** Map of supported language codes to human-readable names for the AI directive. */
export const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish / Espa\u00f1ol',
};

const BASE_SYSTEM_PROMPT =
  'CRITICAL: Never generate text on behalf of the user. Never output "User:" or simulate user messages. Your response ends when you have answered the request.';

/**
 * Build the `--append-system-prompt` value, optionally including a
 * language directive when the UI language is not English.
 */
export function buildSystemPrompt(language?: string): string {
  let prompt = BASE_SYSTEM_PROMPT;

  if (language && language !== 'en') {
    const langName = LANGUAGE_NAMES[language] || language;
    prompt += `\n\nIMPORTANT: You MUST respond in ${langName}. All your text output \u2014 explanations, summaries, instructions, and conversational replies \u2014 must be in ${langName}. Technical terms, code, file paths, and brand names (like "Cerebro") remain in their original language.`;
  }

  return prompt;
}
