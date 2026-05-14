/**
 * Soft-completion gate used by AgentRuntime's task PTY path.
 *
 * Claude Code's TUI never self-exits — it sits at a REPL prompt after the
 * agent finishes. The primary completion signal is the `<deliverable>` tag
 * (matched elsewhere in runtime.ts), but agents don't always emit it. When
 * they don't, we wait for the PTY to look like the REPL idle prompt and
 * graceful-exit ourselves — far faster than the 2-min hard idle timeout.
 *
 * `isReplIdleTail` returns true when the tail of the accumulated PTY text
 * (ANSI already stripped upstream) ends in the prompt and contains no
 * spinner glyph from an in-flight tool call.
 */

// Braille + dot spinner frames the TUI emits during in-flight tool calls —
// their presence in the tail means the agent is still busy.
const TUI_SPINNER_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒●○⏵]/;

// REPL idle prompt — a line whose only non-whitespace content is `>`, with
// an optional box-drawing `│` prefix the TUI wraps its input box in.
const REPL_IDLE_PROMPT_RE = /(?:^|\n)\s*[│|]?\s*>\s*$/;

export const DEFAULT_REPL_TAIL_LEN = 256;

export function isReplIdleTail(
  accumulatedText: string,
  tailLen: number = DEFAULT_REPL_TAIL_LEN,
): boolean {
  const tail = accumulatedText.slice(-tailLen);
  return !TUI_SPINNER_RE.test(tail) && REPL_IDLE_PROMPT_RE.test(tail);
}
