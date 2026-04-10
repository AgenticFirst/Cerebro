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
}

// ── Events sent to renderer ─────────────────────────────────────

export type RendererAgentEvent =
  | { type: 'run_start'; runId: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { type: 'done'; runId: string; messageContent: string }
  | { type: 'error'; runId: string; error: string };

// ── Active run info ─────────────────────────────────────────────

export interface ActiveRunInfo {
  runId: string;
  conversationId: string;
  expertId: string | null;
  startedAt: number;
}
