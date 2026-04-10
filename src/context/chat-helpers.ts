import type { Conversation, Message, RoutineProposal, ExpertProposal, TeamProposal } from '../types/chat';

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

function teamProposalFromApi(raw: Record<string, unknown>): TeamProposal {
  const members = (raw.members as Array<Record<string, unknown>>) ?? [];
  return {
    name: raw.name as string,
    description: (raw.description as string) ?? '',
    strategy: (raw.strategy as string) ?? 'auto',
    members: members.map((m) => ({
      expertId: (m.expert_id as string | null) ?? null,
      name: (m.name as string | null) ?? null,
      role: m.role as string,
      description: (m.description as string | null) ?? null,
      order: (m.order as number) ?? 0,
    })),
    coordinatorPrompt: (raw.coordinator_prompt as string | null) ?? null,
    status: (raw.status as TeamProposal['status']) ?? 'proposed',
    savedTeamId: raw.saved_team_id as string | undefined,
  };
}

function expertProposalFromApi(raw: Record<string, unknown>): ExpertProposal {
  return {
    name: raw.name as string,
    description: (raw.description as string) ?? '',
    domain: (raw.domain as string) ?? '',
    systemPrompt: (raw.system_prompt as string) ?? '',
    toolAccess: (raw.tool_access as string[]) ?? [],
    suggestedContextFile: raw.suggested_context_file as string | undefined,
    status: (raw.status as ExpertProposal['status']) ?? 'proposed',
    savedExpertId: raw.saved_expert_id as string | undefined,
  };
}

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
    previewRunId: raw.preview_run_id as string | undefined,
  };
}

export function fromApiMessage(m: ApiMessage): Message {
  const msg: Message = {
    id: m.id,
    conversationId: m.conversation_id,
    role: m.role as Message['role'],
    content: m.content,
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
    if (m.metadata.expert_proposal) {
      msg.expertProposal = expertProposalFromApi(
        m.metadata.expert_proposal as Record<string, unknown>,
      );
    }
    if (m.metadata.team_proposal) {
      msg.teamProposal = teamProposalFromApi(
        m.metadata.team_proposal as Record<string, unknown>,
      );
    }
    if (m.metadata.team_run) {
      const raw = m.metadata.team_run as Record<string, unknown>;
      const members = (raw.members as Array<Record<string, unknown>>) ?? [];
      msg.teamRun = {
        teamId: raw.team_id as string,
        teamName: raw.team_name as string,
        strategy: raw.strategy as string,
        status: (raw.status as 'running' | 'completed' | 'error') ?? 'completed',
        successCount: raw.success_count as number | undefined,
        totalCount: raw.total_count as number | undefined,
        members: members.map((mem) => ({
          memberId: mem.member_id as string,
          memberName: mem.member_name as string,
          role: mem.role as string,
          status: (mem.status as 'queued' | 'running' | 'completed' | 'error') ?? 'completed',
          response: (mem.response as string | undefined),
        })),
      };
    }
    if (m.metadata.is_preview_run) {
      msg.isPreviewRun = true;
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

export function toApiExpertProposal(p: ExpertProposal): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    domain: p.domain,
    system_prompt: p.systemPrompt,
    tool_access: p.toolAccess,
    suggested_context_file: p.suggestedContextFile,
    status: p.status,
    saved_expert_id: p.savedExpertId,
  };
}

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
    preview_run_id: p.previewRunId,
  };
}

export function toApiTeamProposal(p: TeamProposal): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    strategy: p.strategy,
    members: p.members.map((m) => ({
      expert_id: m.expertId,
      name: m.name,
      role: m.role,
      description: m.description,
      order: m.order,
    })),
    coordinator_prompt: p.coordinatorPrompt,
    status: p.status,
    saved_team_id: p.savedTeamId,
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
