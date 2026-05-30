/**
 * ClaudeCodeEngine — the `claude-code` implementation of InferenceEngine.
 *
 * A thin façade over the existing `src/claude-code/*` modules. No behavior
 * change: detection, auth, streaming, single-shot, and prompt handling all
 * delegate to the code paths that have always run. The façade exists so the
 * runtime and routine executor can talk to `InferenceEngine` and let the
 * registry decide between Claude Code and Codex per run.
 */

import type {
  CompilePromptArgs,
  EngineInfo,
  EngineProbeResult,
  InferenceEngine,
  ResolvedModel,
  SingleShotEngineOptions,
  StreamingRunner,
} from '../types';
import type { QualityTier } from '../../types/ipc';
import { detectClaudeCode, getCachedClaudeCodeInfo } from '../../claude-code/detector';
import { probeClaudeAuth } from '../../claude-code/auth-probe';
import { ClaudeCodeRunner } from '../../claude-code/stream-adapter';
import { singleShotClaudeCode } from '../../claude-code/single-shot';

export class ClaudeCodeEngine implements InferenceEngine {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  detect(): Promise<EngineInfo> {
    return detectClaudeCode();
  }

  getCachedInfo(): EngineInfo {
    return getCachedClaudeCodeInfo();
  }

  probeAuth(opts?: { force?: boolean }): Promise<EngineProbeResult> {
    return probeClaudeAuth(opts);
  }

  createRunner(): StreamingRunner {
    return new ClaudeCodeRunner();
  }

  singleShot(opts: SingleShotEngineOptions): Promise<string> {
    // `reasoningEffort` is Codex-only — Claude Code has no equivalent flag.
    return singleShotClaudeCode({
      agent: opts.agent,
      prompt: opts.prompt,
      signal: opts.signal,
      maxTurns: opts.maxTurns,
      cwd: opts.cwd,
      model: opts.model,
      allowedTools: opts.allowedTools,
    });
  }

  resolveModel(_tier: QualityTier | undefined, model: string | undefined): ResolvedModel {
    // The stream-adapter defaults an absent model to "sonnet"; the runtime's
    // escalation ladder owns tier→model bumps. Pass the chosen model through.
    return { model };
  }

  compilePrompt(args: CompilePromptArgs): string {
    // Claude Code's system prompt rides on `--agent` + `--append-system-prompt`
    // (the subagent markdown is auto-discovered under .claude/agents/), so the
    // turn prompt is just the user's message.
    return args.userTurn;
  }
}
