/**
 * Public exports for the Cerebro agent system.
 *
 * Post-collapse: just the runtime (which spawns Claude Code subprocesses)
 * and a few request/event types. No model resolver, no JS tools, no
 * stream-fn, no logger.
 */

export { AgentRuntime, type AgentEventSink } from './runtime';
export type {
  AgentRunRequest,
  AgentRunSource,
  RendererAgentEvent,
  ActiveRunInfo,
  MessageSnapshot,
  ProposalSnapshot,
  ExpertProposalSnapshot,
} from './types';
