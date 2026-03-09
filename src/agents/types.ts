/**
 * Shared types for the Cerebro agent system.
 */

// ── Model resolution ─────────────────────────────────────────────

export interface ResolvedModel {
  source: 'local' | 'cloud' | 'claude-code';
  provider?: string; // e.g. "anthropic", "openai", "google"
  modelId: string;
  displayName: string;
}

export interface ExpertModelConfig {
  source: 'local' | 'cloud' | 'claude-code';
  provider?: string | null;
  model_id: string;
  display_name: string;
}

// ── Sub-agent result ────────────────────────────────────────────

export interface SubAgentResult {
  runId: string;
  status: 'completed' | 'error';
  messageContent: string;
  error?: string;
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
  /** AgentRuntime reference for delegation (inline type to avoid circular import). */
  agentRuntime?: {
    startRun(webContents: WebContents, request: AgentRunRequest): Promise<string>;
    waitForCompletion(runId: string, timeoutMs?: number): Promise<SubAgentResult>;
  };
  /** The parent run ID when this tool is executing inside a delegated run. */
  parentRunId?: string;
  /** Current delegation depth (0 = top-level). Used to cap recursive delegation. */
  delegationDepth?: number;
  /** OrchestrationTracker for recording delegations/teams/routines as RunRecords. */
  orchestrationTracker?: {
    recordDelegationStart(expertId: string, expertName: string, childRunId: string): Promise<void>;
    recordDelegationEnd(childRunId: string, status: string, durationMs: number): void;
    recordTeamStart(teamId: string, teamName: string, strategy: string, memberCount: number): Promise<void>;
    recordTeamEnd(teamId: string, status: string, successCount: number, totalCount: number, durationMs?: number): void;
    recordRoutineTriggered(routineId: string, engineRunId: string): Promise<void>;
  };
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
  /** Parent run ID when this is a delegated sub-run. */
  parentRunId?: string;
  /** Current delegation depth (0 = top-level). */
  delegationDepth?: number;
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
  | { type: 'delegation_start'; parentRunId: string; childRunId: string; expertId: string; expertName: string }
  | { type: 'delegation_end'; parentRunId: string; childRunId: string; status: string }
  | { type: 'team_started'; teamId: string; teamName: string; strategy: string; memberCount: number }
  | { type: 'member_queued'; teamId: string; memberId: string; memberName: string; role: string }
  | { type: 'member_started'; teamId: string; memberId: string; memberName: string }
  | { type: 'member_completed'; teamId: string; memberId: string; memberName: string; status: 'completed' | 'error'; response?: string }
  | { type: 'team_synthesis'; teamId: string }
  | { type: 'team_completed'; teamId: string; status: 'completed' | 'error'; successCount: number; totalCount: number }
  | { type: 'done'; runId: string; messageContent: string; orchestrationRunId?: string }
  | { type: 'error'; runId: string; error: string };

// ── Active run info ─────────────────────────────────────────────

export interface ActiveRunInfo {
  runId: string;
  conversationId: string;
  expertId: string | null;
  startedAt: number;
}
