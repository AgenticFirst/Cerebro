import type { TriggerType } from './routines';

export type Role = 'user' | 'assistant' | 'system';

export type Screen =
  | 'chat'
  | 'tasks'
  | 'workspaces'
  | 'experts'
  | 'routines'
  | 'activity'
  | 'approvals'
  | 'integrations'
  | 'marketplace'
  | 'settings'
  | 'call';

export type ToolCallStatus = 'pending' | 'running' | 'success' | 'error';

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
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}
