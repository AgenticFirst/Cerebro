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

/** Lightweight message summary for conversation context. */
export interface MessageSnapshot {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRunRequest {
  conversationId: string;
  content: string;
  expertId?: string | null;
  /** Parent run ID when this is a sub-run (rare — Claude Code's Agent tool
   *  handles nested runs inside its own subprocess). */
  parentRunId?: string;
  /** Recent messages from this conversation so the subagent has multi-turn context. */
  recentMessages?: MessageSnapshot[];
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
  /** Initial terminal dimensions for task PTY (matches xterm viewport). */
  cols?: number;
  rows?: number;
  /** Resume a prior Claude Code session by its ID (equal to the original run_id). */
  resumeSessionId?: string;
  /** Origin of this run — used to route approvals/errors back to the right surface. */
  source?: AgentRunSource;
}

export type AgentRunSource =
  | { kind: 'ui' }
  | { kind: 'telegram'; chatId: number };

// ── Events sent to renderer ─────────────────────────────────────

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'system'; message: string; subtype?: string }
  | { type: 'done'; runId: string; messageContent: string }
  | { type: 'error'; runId: string; error: string };

// ── Active run info ─────────────────────────────────────────────

export interface ActiveRunInfo {
  runId: string;
  conversationId: string;
  expertId: string | null;
  startedAt: number;
}
