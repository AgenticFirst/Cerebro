import type { Conversation, Message } from "../types/chat";

// ── Pure helpers ─────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function titleFromContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40) + "...";
}

// ── Backend API types (snake_case matching JSON) ─────────────────

export interface ApiMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  token_count: number | null;
  created_at: string;
}

export interface ApiConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ApiMessage[];
}

export interface ApiConversationList {
  conversations: ApiConversation[];
}

// ── Mapping helpers ──────────────────────────────────────────────

export function fromApiMessage(m: ApiMessage): Message {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role as Message["role"],
    content: m.content,
    model: m.model ?? undefined,
    tokenCount: m.token_count ?? undefined,
    createdAt: new Date(m.created_at),
  };
}

export function fromApiConversation(c: ApiConversation): Conversation {
  return {
    id: c.id,
    title: c.title,
    createdAt: new Date(c.created_at),
    updatedAt: new Date(c.updated_at),
    messages: c.messages.map(fromApiMessage),
  };
}
