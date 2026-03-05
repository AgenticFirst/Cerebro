import type { TriggerType } from './routines';

export type Role = 'user' | 'assistant' | 'system';

export type Screen =
  | 'chat'
  | 'experts'
  | 'routines'
  | 'activity'
  | 'approvals'
  | 'integrations'
  | 'marketplace'
  | 'settings';

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

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  model?: string;
  tokenCount?: number;
  expertId?: string;
  agentRunId?: string;
  createdAt: Date;
  isStreaming?: boolean;
  isThinking?: boolean;
  toolCalls?: ToolCall[];
  engineRunId?: string;
  isPreviewRun?: boolean;
  routineProposal?: RoutineProposal;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}
