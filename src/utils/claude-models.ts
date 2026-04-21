/**
 * Canonical list of Claude models the routine AI steps can run on.
 *
 * The UI model-picker reads from this list so a single edit here
 * surfaces a new model in every AI-node config panel.
 *
 * Values under `id` are passed straight through to `claude --model`.
 * Claude Code also accepts the short aliases ("sonnet", "opus",
 * "haiku") which always map to the latest of that tier — if the user
 * wants auto-upgrade behavior they can pick those instead.
 */

export interface ClaudeModelOption {
  /** Exact value passed to `claude --model`. */
  id: string;
  /** Human-readable label shown in the dropdown. */
  name: string;
  /** One-line hint describing when to pick this model. */
  description: string;
  /** Rough speed/cost tier used only for visual grouping. */
  tier: 'fast' | 'balanced' | 'powerful';
}

export const CLAUDE_MODELS: ClaudeModelOption[] = [
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest and cheapest — great for classifiers and routing',
    tier: 'fast',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    description: 'Balanced speed and quality',
    tier: 'balanced',
  },
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    description: 'Most capable — best for complex reasoning and writing',
    tier: 'powerful',
  },
];

/** Default model every new AI step starts on. */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

export function findClaudeModel(id: string | undefined): ClaudeModelOption | undefined {
  if (!id) return undefined;
  return CLAUDE_MODELS.find((m) => m.id === id);
}
