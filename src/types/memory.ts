export type MemoryScope = 'personal' | 'expert' | 'routine' | 'team';

export interface ContextFile {
  key: string;
  content: string;
  updatedAt: string;
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  content: string;
  sourceConversationId: string | null;
  createdAt: string;
}

export interface KnowledgeEntry {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  entryType: string;
  occurredAt: string;
  summary: string;
  content: Record<string, unknown>;
  source: string;
  sourceConversationId: string | null;
  createdAt: string;
}

export interface KnowledgeFilters {
  scope?: MemoryScope;
  scopeId?: string;
  entryType?: string;
  search?: string;
  offset?: number;
  limit?: number;
}
