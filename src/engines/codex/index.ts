/**
 * CodexEngine — the `codex` implementation of InferenceEngine.
 *
 * Streaming runs go through CodexRunner (`codex exec --json`); single-shot
 * routine steps through singleShotCodex (`codex exec`). The shared quality
 * tier maps to Codex's `model_reasoning_effort`; the per-conversation model is
 * passed through only when it's a real Codex model id (Claude aliases like
 * "sonnet" are dropped so codex uses its account default).
 */

import type {
  CompilePromptArgs,
  EngineInfo,
  EngineProbeResult,
  InferenceEngine,
  ReasoningEffort,
  ResolvedModel,
  SingleShotEngineOptions,
  StreamingRunner,
} from '../types';
import type { QualityTier } from '../../types/ipc';
import { detectCodex, getCachedCodexInfo } from './detector';
import { probeCodexAuth } from './auth-probe';
import { CodexRunner } from './stream-adapter';
import { singleShotCodex } from './single-shot';
import { buildCodexPrompt } from './prompt-compiler';

const CLAUDE_MODEL_ALIASES = new Set(['haiku', 'sonnet', 'opus']);

function tierToEffort(tier: QualityTier | undefined): ReasoningEffort {
  switch (tier) {
    case 'fast':
      return 'low';
    case 'slow':
      return 'high';
    case 'medium':
    default:
      return 'medium';
  }
}

export class CodexEngine implements InferenceEngine {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';

  detect(): Promise<EngineInfo> {
    return detectCodex();
  }

  getCachedInfo(): EngineInfo {
    return getCachedCodexInfo();
  }

  probeAuth(opts?: { force?: boolean }): Promise<EngineProbeResult> {
    return probeCodexAuth(opts);
  }

  createRunner(): StreamingRunner {
    return new CodexRunner();
  }

  singleShot(opts: SingleShotEngineOptions): Promise<string> {
    // Routine steps often pass a Claude model id (e.g. "claude-haiku-4-5" or
    // "sonnet"). Codex rejects those, so strip anything that isn't a Codex
    // model — codex then uses its configured/account default.
    const model =
      opts.model && !opts.model.startsWith('claude') && !CLAUDE_MODEL_ALIASES.has(opts.model)
        ? opts.model
        : undefined;
    return singleShotCodex({ ...opts, model });
  }

  resolveModel(tier: QualityTier | undefined, model: string | undefined): ResolvedModel {
    const codexModel = model && !CLAUDE_MODEL_ALIASES.has(model) ? model : undefined;
    return { model: codexModel, reasoningEffort: tierToEffort(tier) };
  }

  compilePrompt(args: CompilePromptArgs): string {
    return buildCodexPrompt(args);
  }
}
