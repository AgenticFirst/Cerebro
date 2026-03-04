import type { Conversation, Message, RoutineProposal } from '../types/chat';

// ── Pure helpers ─────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function titleFromContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40) + '...';
}

// ── Backend API types (snake_case matching JSON) ─────────────────

export interface ApiMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  token_count: number | null;
  expert_id: string | null;
  agent_run_id: string | null;
  metadata: Record<string, unknown> | null;
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

function proposalFromApi(raw: Record<string, unknown>): RoutineProposal {
  return {
    name: raw.name as string,
    description: (raw.description as string) ?? '',
    steps: raw.steps as string[],
    triggerType: (raw.trigger_type as RoutineProposal['triggerType']) ?? 'manual',
    cronExpression: raw.cron_expression as string | undefined,
    defaultRunnerId: raw.default_runner_id as string | undefined,
    requiredConnections: (raw.required_connections as string[]) ?? [],
    approvalGates: (raw.approval_gates as string[]) ?? [],
    status: (raw.status as RoutineProposal['status']) ?? 'proposed',
    savedRoutineId: raw.saved_routine_id as string | undefined,
  };
}

export function fromApiMessage(m: ApiMessage): Message {
  const msg: Message = {
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role as Message['role'],
    content: m.content,
    model: m.model ?? undefined,
    tokenCount: m.token_count ?? undefined,
    expertId: m.expert_id ?? undefined,
    agentRunId: m.agent_run_id ?? undefined,
    createdAt: new Date(m.created_at),
  };

  if (m.metadata) {
    if (m.metadata.engine_run_id) {
      msg.engineRunId = m.metadata.engine_run_id as string;
    }
    if (m.metadata.routine_proposal) {
      msg.routineProposal = proposalFromApi(
        m.metadata.routine_proposal as Record<string, unknown>,
      );
    }
  }

  return msg;
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

// ── API write helpers ────────────────────────────────────────────

export function toApiProposal(p: RoutineProposal): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    steps: p.steps,
    trigger_type: p.triggerType,
    cron_expression: p.cronExpression,
    default_runner_id: p.defaultRunnerId,
    required_connections: p.requiredConnections,
    approval_gates: p.approvalGates,
    status: p.status,
    saved_routine_id: p.savedRoutineId,
  };
}

export function apiPatchMessageMetadata(
  convId: string,
  msgId: string,
  metadata: Record<string, unknown>,
): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'PATCH',
    path: `/conversations/${convId}/messages/${msgId}`,
    body: { metadata },
  });
}
