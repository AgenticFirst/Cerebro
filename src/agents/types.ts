/**
 * Shared types for the Cerebro agent system.
 *
 * Post-collapse: every chat run is a Claude Code subprocess. There is
 * no JS-side model resolution, no JS tools, no in-process delegation,
 * so the type surface is small.
 */

// ── Agent run request (from renderer) ───────────────────────────

/** Summary of a routine proposal from a previous turn. */
export interface ProposalSnapshot {
  name: string;
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
}

/** Summary of an expert proposal from a previous turn. */
export interface ExpertProposalSnapshot {
  name: string;
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
}

/**
 * Classification of why a Claude Code run ended in error. Mirrored from
 * `ClaudeCodeRunner.RunnerErrorClass` and propagated to the renderer on
 * the `error` event so the chat UI can render class-specific recovery
 * affordances (e.g. a "Sign in to Claude Code" action for `auth`).
 */
export type AgentErrorClass =
  | 'auth'
  | 'max_turns'
  | 'context'
  | 'overload'
  | 'cancelled'
  | 'spawn'
  | 'session_missing'
  | 'unknown';

/** Lightweight message summary for conversation context. */
export interface MessageSnapshot {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRunRequest {
  conversationId: string;
  content: string;
  expertId?: string | null;
  /**
   * Which inference engine to run. When omitted, the runtime resolves it from
   * the per-conversation override → global `selected_engine` → default. The
   * renderer sets it from EngineContext; main-process callers usually leave it
   * unset and let the runtime resolve the global default.
   */
  engine?: import('../engines/types').EngineId;
  /** Parent run ID when this is a sub-run (rare — Claude Code's Agent tool
   *  handles nested runs inside its own subprocess). */
  parentRunId?: string;
  /**
   * Full transcript of this conversation. Used by AgentRuntime as a
   * one-time seed when a `--resume` attempt fails because Claude Code
   * has no on-disk session for this chat (e.g., conversations created
   * before sessions existed, or after a Claude Code data-dir wipe). On
   * normal turns the runtime ignores this field — Claude Code reloads
   * the transcript from its own session file via `--resume`.
   */
  recentMessages?: MessageSnapshot[];
  /**
   * Explicit create-vs-resume hint for the Claude Code session. When set, it
   * overrides the `recentMessages` heuristic the runtime would otherwise use
   * (`true` → `--resume` an existing session, `false` → `--session-id` to
   * create a fresh one). Callers that don't ship `recentMessages` (the Slack
   * and Telegram bridges, which rely on Claude Code's own `--resume` to carry
   * history) set this from whether the conversation already existed. Either
   * way a wrong guess self-heals — the runtime falls back transparently
   * (`session_missing` → create, `session_in_use` → resume). */
  resume?: boolean;
  /** Routine proposals from earlier messages in this conversation. */
  routineProposals?: ProposalSnapshot[];
  /** Expert proposals from earlier messages in this conversation. */
  expertProposals?: ExpertProposalSnapshot[];

  // ── Task mode fields ──────────────────────────────────────────
  /** 'chat' (default) or 'task'. */
  runType?: 'chat' | 'task';
  /** Which task subprocess phase: 'plan' (clarify + write PLAN.md), 'execute' (run PLAN.md), 'follow_up', or 'direct' (Kanban — execute immediately from task title/description). */
  taskPhase?: 'plan' | 'execute' | 'follow_up' | 'direct';
  /** Override --max-turns. Default: 15 (chat), 5 (clarify), 10 (execute/follow_up). */
  maxTurns?: number;
  /** Maximum plan phases (injected into the execute envelope). Default 6. */
  maxPhases?: number;
  /** Maximum clarification questions. Default 5. */
  maxClarifyQuestions?: number;
  /** Use a pre-minted run_records row instead of creating one. */
  runIdOverride?: string;
  /** Task workspace CWD for execute/follow_up phase (overrides dataDir). */
  workspacePath?: string;
  /** Pre-formatted answers block from the clarification pass. */
  clarificationAnswers?: string;
  /** Model override (e.g. "sonnet", "opus", "claude-sonnet-4-6"). */
  model?: string;
  /** Pre-formatted context block for follow-up runs (original goal + previous deliverable). */
  followUpContext?: string;
  /** UI language code (e.g. "es"). When set and not "en", the AI is instructed to respond in that language. */
  language?: string;
  /** Speed/quality tier from the chat input chip. Drives default `model` and
   *  `maxTurns` (when not explicitly set) and a tier directive appended to
   *  the system prompt. */
  qualityTier?: 'fast' | 'medium' | 'slow';
  /** Initial terminal dimensions for task PTY (matches xterm viewport). */
  cols?: number;
  rows?: number;
  /** Resume a prior Claude Code session by its ID (equal to the original run_id). */
  resumeSessionId?: string;
  /**
   * Interactive resume: re-attach the TUI to the prior session without
   * re-sending any prompt. Used by the Task drawer's "Resume" button so the
   * user can type the next message themselves. Only meaningful when
   * `resumeSessionId` is also set.
   */
  interactiveResume?: boolean;
  /** Origin of this run — used to route approvals/errors back to the right surface. */
  source?: AgentRunSource;
  /**
   * Optional per-run expert allowlist (by expert id). When provided as a
   * non-null array, the default Cerebro agent's `list-experts` roster and
   * any `delegate_to_expert` call are restricted to these ids. Used by the
   * Slack bridge to enforce per-person expert access. `null` / undefined
   * keeps the unrestricted behaviour.
   */
  accessibleExpertIds?: string[] | null;
}

export type AgentRunSource =
  | { kind: 'ui' }
  | { kind: 'telegram'; chatId: number }
  | { kind: 'slack'; channel: string; threadTs: string | undefined; teamId: string }
  | { kind: 'whatsapp'; phone: string };

// ── Events sent to renderer ─────────────────────────────────────

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'system'; message: string; subtype?: string }
  | { type: 'done'; runId: string; messageContent: string }
  | { type: 'error'; runId: string; error: string; errorClass?: AgentErrorClass }
  // Idle-watchdog events from ClaudeCodeRunner (chat path). Surfaced as
  // step_log events by the expert_step action so the user sees the
  // heartbeat trail in the Activity panel.
  | { type: 'agent_idle_warning'; runId: string; elapsedMs: number }
  | { type: 'subprocess_stderr'; runId: string; line: string }
  // Auto-escalation: emitted by AgentRuntime when an attempt fails with a
  // structured "model fell short" result (max-turns, context exhausted, etc.)
  // and the next attempt will run with a stronger model and/or tier.
  | {
      type: 'agent_escalation';
      runId: string;
      attempt: number;
      reason: string;
      nextModel: string;
      nextTier: 'fast' | 'medium' | 'slow';
    };

// ── Active run info ─────────────────────────────────────────────

export interface ActiveRunInfo {
  runId: string;
  conversationId: string;
  expertId: string | null;
  startedAt: number;
}
