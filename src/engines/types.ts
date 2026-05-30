/**
 * Engine abstraction — shared contracts for Cerebro's pluggable inference
 * backends.
 *
 * Cerebro drives inference by shelling out to a coding-agent CLI as a
 * subprocess. Historically that was always the Claude Code CLI; this module
 * generalizes over it so the OpenAI Codex CLI can be a co-equal engine.
 *
 * The two engines differ structurally (Claude has named subagents + a skills
 * dir + deterministic session ids + stream-json events; Codex inlines its
 * system prompt on stdin, owns its own session ids, and emits a different
 * JSONL schema). Everything above the spawn — the renderer event stream, the
 * routine executor, the bridges — stays engine-agnostic by speaking these
 * contracts.
 */

import type { EventEmitter } from 'node:events';
import type { QualityTier } from '../types/ipc';
import type { RendererAgentEvent } from '../agents/types';

// ── Engine identity ──────────────────────────────────────────────

export type EngineId = 'claude-code' | 'codex';

// ── Detection / availability ─────────────────────────────────────

export type EngineStatus = 'unknown' | 'detecting' | 'available' | 'unavailable' | 'error';

export interface EngineInfo {
  status: EngineStatus;
  version?: string;
  path?: string;
  error?: string;
}

/** Result of a runtime auth probe (is the CLI signed in?). */
export interface EngineProbeResult {
  ok: boolean;
  reason?: string;
}

// ── Run-end classification ───────────────────────────────────────

/**
 * Classification of why a streaming run ended. Lifted here so both the
 * Claude Code and Codex runners (and the runtime's escalation ladder) share
 * one vocabulary. `session_in_use` is Claude-specific (it collides on the
 * deterministic per-conversation id); Codex never produces it since it owns
 * its session ids.
 */
export type RunnerErrorClass =
  | 'none'
  | 'max_turns'
  | 'context'
  | 'overload'
  | 'auth'
  | 'cancelled'
  | 'spawn'
  | 'session_missing'
  | 'session_in_use'
  | 'idle_hang'
  | 'unknown';

// ── Streaming runner ─────────────────────────────────────────────

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Options for a single streaming run. Superset of the historical
 * `ClaudeCodeRunOptions`; `reasoningEffort` is Codex-only (Claude ignores it)
 * and `agentName` means a named subagent for Claude but the instruction-prefix
 * slug for Codex.
 */
export interface EngineRunOptions {
  runId: string;
  prompt: string;
  agentName: string;
  cwd: string;
  maxTurns?: number;
  /** Engine-native model id (e.g. "sonnet" / "opus" for Claude, "gpt-5.5" for Codex). */
  model?: string;
  /** Codex reasoning effort. Ignored by Claude. */
  reasoningEffort?: ReasoningEffort;
  language?: string;
  qualityTier?: QualityTier;
  /**
   * Session identifier. For Claude this is the deterministic per-conversation
   * UUID passed via `--session-id`/`--resume`. For Codex it's the stored
   * thread id (or empty on a fresh conversation — Codex mints its own).
   */
  sessionId: string;
  /** When true, continue an existing on-disk session rather than create one. */
  resume?: boolean;
  /** Per-run environment overlay merged into the subprocess env. */
  extraEnv?: Record<string, string>;
}

/**
 * A live streaming subprocess. Emits the SAME `RendererAgentEvent` union for
 * both engines so the renderer/runtime never branch on engine id.
 *
 * Events (via EventEmitter):
 *   - 'event'  (RendererAgentEvent)
 *   - 'done'   (messageContent: string)
 *   - 'error'  (error: string)
 */
export interface StreamingRunner extends EventEmitter {
  start(options: EngineRunOptions): void;
  abort(): void;
  getAccumulatedText(): string;
  getLastErrorClass(): RunnerErrorClass;
  /**
   * The engine-owned session id discovered during the run, if any. Claude uses
   * caller-chosen ids so it returns null/omits this; Codex mints its own
   * thread id (from `thread.started`) and returns it so the runtime can persist
   * it for `codex exec resume`.
   */
  getSessionId?(): string | null;
}

// ── Single-shot (routine-engine steps, titles) ───────────────────

export interface SingleShotEngineOptions {
  /** Subagent name (Claude) / instruction slug (Codex). */
  agent: string;
  prompt: string;
  signal?: AbortSignal;
  maxTurns?: number;
  cwd?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Comma-separated tool allowlist (Claude `--allowedTools`). Best-effort for Codex. */
  allowedTools?: string;
}

// ── Model resolution ─────────────────────────────────────────────

/**
 * Engine-native model + effort resolved from the shared quality knobs.
 * `model: undefined` means "let the CLI use its configured/account default"
 * (Codex omits `--model`; Claude falls back to "sonnet").
 */
export interface ResolvedModel {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

// ── The engine contract ──────────────────────────────────────────

export interface InferenceEngine {
  readonly id: EngineId;
  /** Human-facing label, e.g. "Claude Code" / "Codex". */
  readonly displayName: string;

  /** Detect the binary (path, version) and cache the result. */
  detect(): Promise<EngineInfo>;
  /** Return the last cached detection result without re-probing. */
  getCachedInfo(): EngineInfo;
  /** Probe whether the CLI is authenticated. Cached; `force` busts it. */
  probeAuth(opts?: { force?: boolean }): Promise<EngineProbeResult>;

  /** Create a fresh streaming runner for one chat/assistant run. */
  createRunner(): StreamingRunner;
  /** Non-streaming inference returning trimmed stdout. */
  singleShot(opts: SingleShotEngineOptions): Promise<string>;

  /** Map the shared quality tier + model choice to engine-native values. */
  resolveModel(tier: QualityTier | undefined, model: string | undefined): ResolvedModel;

  /**
   * Build the prompt string actually sent to the subprocess for one turn.
   * Claude returns `userTurn` unchanged (the system prompt rides on `--agent`
   * + `--append-system-prompt`). Codex prepends the inlined system + skills
   * prefix on the first turn (none on resume, since the session carries it).
   */
  compilePrompt(args: CompilePromptArgs): string;
}

export interface CompilePromptArgs {
  agentName: string;
  /** The user's message for this turn. */
  userTurn: string;
  /** True on the first turn of a session (when the system prefix is needed). */
  isFirstTurn: boolean;
  /** Expert ids accessible this run, for the inline roster (Codex). */
  accessibleExpertIds?: string[] | null;
}
