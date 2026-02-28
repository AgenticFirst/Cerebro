export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  model?: string;
  tokenCount?: number;
  createdAt: Date;
  isStreaming?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messages: Message[];
}
