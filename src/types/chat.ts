import type { TriggerType } from './routines';

export type Role = 'user' | 'assistant' | 'system';

export type Screen =
  | 'chat'
  | 'tasks'
  | 'files'
  | 'experts'
  | 'routines'
  | 'activity'
  | 'approvals'
  | 'integrations'
  | 'marketplace'
  | 'knowledge-base'
  | 'news'
  | 'calendar'
  | 'flows'
  | 'settings'
  | 'call';

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error' | 'stopped';

export interface ToolCall {
  id: string;
  name: string;
  description: string;
  arguments?: Record<string, unknown>;
  output?: string;
  status: ToolCallStatus;
  startedAt?: Date;
  completedAt?: Date;
  delegationExpertName?: string;
}

export interface RoutineProposal {
  name: string;
  description: string;
  steps: string[];
  triggerType: TriggerType;
  cronExpression?: string;
  defaultRunnerId?: string;
  requiredConnections: string[];
  approvalGates: string[];
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
  savedRoutineId?: string;
  previewRunId?: string;
}

export interface ExpertProposal {
  name: string;
  description: string;
  domain: string;
  systemPrompt: string;
  toolAccess: string[];
  suggestedContextFile?: string;
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
  savedExpertId?: string;
}

export interface TeamRunMember {
  memberId: string;
  memberName: string;
  role: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  response?: string;
}

export interface TeamRun {
  teamId: string;
  teamName: string;
  strategy: string;
  members: TeamRunMember[];
  status: 'running' | 'completed' | 'error';
  successCount?: number;
  totalCount?: number;
  /** Wall-clock ms when the team was announced — drives the elapsed counter
   *  in TeamRunCard while the run is in flight. */
  startedAt?: number;
}

export interface TeamProposalMember {
  expertId: string | null;
  name: string | null;
  role: string;
  description: string | null;
  order: number;
}

export interface TeamProposal {
  name: string;
  description: string;
  strategy: string;
  members: TeamProposalMember[];
  coordinatorPrompt: string | null;
  status: 'proposed' | 'previewing' | 'saved' | 'dismissed';
  savedTeamId?: string;
}

export interface IntegrationSetupProposal {
  /** Manifest id (e.g. 'telegram', 'hubspot'). */
  integrationId: string;
  /** Optional reason the agent stated — shown as the card subtitle. */
  reason?: string;
  status: 'proposed' | 'connecting' | 'connected' | 'dismissed';
}

export interface EscalationNotice {
  attempt: number;
  model: string;
  tier: 'fast' | 'medium' | 'slow';
  reason: string;
}

/** Subset of AgentErrorClass surfaced to the chat UI for class-specific
 *  recovery affordances. Mirrors `src/agents/types.ts:AgentErrorClass`
 *  but lives here so the renderer-only Message shape doesn't pull the
 *  whole agent runtime types graph. */
export type MessageErrorClass =
  | 'auth'
  | 'max_turns'
  | 'context'
  | 'overload'
  | 'cancelled'
  | 'spawn'
  | 'session_missing'
  | 'unknown';

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  expertId?: string;
  agentRunId?: string;
  createdAt: Date;
  isStreaming?: boolean;
  isThinking?: boolean;
  toolCalls?: ToolCall[];
  engineRunId?: string;
  isPreviewRun?: boolean;
  routineProposal?: RoutineProposal;
  expertProposal?: ExpertProposal;
  teamProposal?: TeamProposal;
  teamRun?: TeamRun;
  integrationProposal?: IntegrationSetupProposal;
  /** Auto-escalation notices appended by AgentRuntime when an attempt
   *  was retried on a stronger model/tier. Surfaced inline in the
   *  assistant bubble so the user sees why and what changed. */
  escalations?: EscalationNotice[];
  /** Set when the run ended in error. Drives class-specific recovery
   *  UI (e.g. the auth-recovery card for `auth`). Transient — not
   *  persisted; absent on reload, which is fine because the original
   *  user prompt is still in the transcript and they can resend. */
  errorClass?: MessageErrorClass;
}

export type ConversationSource = 'cerebro' | 'telegram';

export interface Conversation {
  id: string;
  title: string;
  expertId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
  /** Origin channel — 'telegram' shows the Telegram badge in the sidebar
   *  and a header strip in ChatView. Defaults to 'cerebro'. */
  source?: ConversationSource;
  /** Numeric Telegram chat id (as string), populated when source='telegram'. */
  externalChatId?: string | null;
}
