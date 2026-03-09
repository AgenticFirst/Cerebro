/**
 * Model classification into small/medium/large tiers.
 *
 * Returns per-tier config (maxTurns, contextBudget, compressionThreshold)
 * and tier-specific system prompt guidance.
 */

import type { ResolvedModel } from '../types';

export type ModelTier = 'small' | 'medium' | 'large';

export interface TierConfig {
  maxTurns: number;
  /** Approximate token budget for context window (chars / 4). */
  contextBudget: number;
  /** Tool result chars above this threshold get compressed. */
  compressionThreshold: number;
  /** Number of identical tool calls before loop detection fires. */
  loopThreshold: number;
  /** Max chars to keep when truncating old assistant messages during context pruning. */
  assistantTruncation: number;
}

const TIER_CONFIGS: Record<ModelTier, TierConfig> = {
  small: {
    maxTurns: 6,
    contextBudget: 4_000,   // ~16K chars
    compressionThreshold: 800,
    loopThreshold: 2,
    assistantTruncation: 150, // minimal — preserve intent only
  },
  medium: {
    maxTurns: 8,
    contextBudget: 16_000,  // ~64K chars
    compressionThreshold: 2_000,
    loopThreshold: 3,
    assistantTruncation: 400, // moderate — keep key reasoning
  },
  large: {
    maxTurns: 15,
    contextBudget: 32_000,  // ~128K chars
    compressionThreshold: 8_000,
    loopThreshold: 3,
    assistantTruncation: 800, // generous — preserve reasoning depth
  },
};

// Param sizes mapped to tiers
const SMALL_PARAMS = new Set(['1b', '3b', '4b', '7b', '8b']);
const MEDIUM_PARAMS = new Set(['12b', '13b', '14b', '27b', '32b', '35b']);

/**
 * Classify a resolved model into a tier.
 *
 * - Cloud providers → large
 * - Local models → parse param count from modelId
 */
export function classifyModelTier(model: ResolvedModel): ModelTier {
  if (model.source === 'cloud' || model.source === 'claude-code') return 'large';

  // Try to extract param size like "4b", "12b" from modelId
  const match = model.modelId.toLowerCase().match(/(\d+)b/);
  if (match) {
    const tag = match[1] + 'b';
    if (SMALL_PARAMS.has(tag)) return 'small';
    if (MEDIUM_PARAMS.has(tag)) return 'medium';
    // Large local models (70b+)
    const num = parseInt(match[1], 10);
    if (num >= 40) return 'large';
  }

  // Unknown local model → medium (safe default)
  return 'medium';
}

export function getTierConfig(tier: ModelTier): TierConfig {
  return TIER_CONFIGS[tier];
}

/**
 * Returns tier-specific system prompt additions.
 * Small models get explicit step-by-step guidance.
 * Medium models get brief reminders.
 * Large models get nothing extra.
 */
export function getTierGuidance(tier: ModelTier): string {
  if (tier === 'small') {
    return `\n\n## Tool Use Guidelines

You are running on a small model. Follow these rules carefully:
1. Think step by step before acting.
2. Use ONE tool at a time — never call multiple tools in parallel.
3. After each tool result, evaluate whether you have enough information to answer.
4. If a tool call fails, try a different approach rather than retrying the same call.
5. Keep your responses concise and focused.
6. When delegating, say who you're delegating to in one sentence, then call the tool.
7. Limit yourself to 1-2 delegations per response. Keep it focused.
8. After receiving an expert's response, present it directly — don't try to rewrite it extensively.`;
  }

  if (tier === 'medium') {
    return `\n\n## Tool Use Guidelines

Use tools when they add value. After each tool result, evaluate whether you need more information or can answer directly.`;
  }

  return '';
}
