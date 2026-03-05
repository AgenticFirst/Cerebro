/**
 * Shared types for the Cerebro agent system.
 */

// ── Model resolution ─────────────────────────────────────────────

export interface ResolvedModel {
  source: 'local' | 'cloud';
  provider?: string; // e.g. "anthropic", "openai", "google"
  modelId: string;
  displayName: string;
}

export interface ExpertModelConfig {
  source: 'local' | 'cloud';
  provider?: string | null;
  model_id: string;
  display_name: string;
}

// ── Tool context ────────────────────────────────────────────────

import type { ExecutionEngine } from '../engine/engine';
import type { WebContents } from 'electron';

export interface ToolContext {
  expertId: string | null;
  conversationId: string;
  scope: string;
  scopeId: string | null;
  backendPort: number;
  executionEngine?: ExecutionEngine;
  webContents?: WebContents;
}

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
  /** Recent messages from this conversation so the LLM has multi-turn context. */
  recentMessages?: MessageSnapshot[];
  /** Routine proposals from earlier messages in this conversation, so the LLM
   *  can avoid re-proposing dismissed routines or know which were saved. */
  routineProposals?: ProposalSnapshot[];
  /** Expert proposals from earlier messages in this conversation, so the LLM
   *  can avoid re-proposing dismissed experts or know which were saved. */
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
