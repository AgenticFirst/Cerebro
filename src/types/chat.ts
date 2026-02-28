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

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  model?: string;
  tokenCount?: number;
  createdAt: Date;
  isStreaming?: boolean;
  isThinking?: boolean;
  toolCalls?: ToolCall[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}
