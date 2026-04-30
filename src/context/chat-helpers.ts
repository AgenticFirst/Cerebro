import type {
  Conversation,
  Message,
  RoutineProposal,
  ExpertProposal,
  TeamProposal,
  TeamRun,
  IntegrationSetupProposal,
} from '../types/chat';

// ── Pure helpers ─────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function titleFromContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 40) + '...';
}

/**
 * English-only sentinel titles that different code paths (frontend default,
 * backend default, legacy rows) have used to mean "no real title yet". We
 * collapse all of them to the same "untitled" bucket at render time so the
 * sidebar can show a locale-aware placeholder instead of stale English text.
 */
const UNTITLED_SENTINELS = new Set([
  '',
  'new conversation',
  'new chat',
  'untitled',
]);

export function isUntitledConversationTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  return UNTITLED_SENTINELS.has(title.trim().toLowerCase());
}

/**
 * Same-day comparison in the user's local timezone. UTC would bucket a 9pm
 * PT conversation into "tomorrow", which is surprising.
 */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export interface NewChatPlan {
  /** Conversation ID to activate if an eligible empty chat from today exists. */
  reuseId: string | null;
  /** Stale empties (not from today) and duplicate today-empties to delete. */
  purgeIds: string[];
  /** True when no today-empty exists and a fresh conversation must be created. */
  createNew: boolean;
}

/**
 * Enforces the "at most one empty chat, from today" invariant when the user
 * clicks New Chat. Caller must pass `conversations` newest-first (matches how
 * ChatContext stores them — `createConversation` prepends to the array).
 *
 * Rules:
 *  - Only empty (no-messages) conversations are touched. Non-empty chats are
 *    never deleted — they belong to the user.
 *  - If an empty chat created today exists, reuse the newest one.
 *  - Any other empty chats (from earlier days, or duplicate today-empties) are
 *    marked for deletion.
 *  - If no today-empty exists, createNew=true and stale empties still get
 *    purged so the final state is exactly one empty chat (the fresh one).
 */
export function resolveNewChatTarget(
  conversations: Conversation[],
  now: Date,
): NewChatPlan {
  const empties = conversations.filter((c) => c.messages.length === 0);
  const todaysEmpties = empties.filter((c) => isSameLocalDay(c.createdAt, now));
  const staleEmpties = empties.filter((c) => !isSameLocalDay(c.createdAt, now));

  const survivor = todaysEmpties[0] ?? null;
  const purgeIds = [
    ...staleEmpties.map((c) => c.id),
    ...todaysEmpties.slice(1).map((c) => c.id),
  ];

  return {
    reuseId: survivor?.id ?? null,
    purgeIds,
    createNew: survivor === null,
  };
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
  expert_id: string | null;
  source?: string;
  external_chat_id?: string | null;
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

function integrationProposalFromApi(raw: Record<string, unknown>): IntegrationSetupProposal {
  return {
    integrationId: raw.integration_id as string,
    reason: raw.reason as string | undefined,
    status: (raw.status as IntegrationSetupProposal['status']) ?? 'proposed',
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
        startedAt: typeof raw.started_at === 'number' ? (raw.started_at as number) : undefined,
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
    if (m.metadata.integration_proposal) {
      msg.integrationProposal = integrationProposalFromApi(
        m.metadata.integration_proposal as Record<string, unknown>,
      );
    }
  }

  return msg;
}

export function fromApiConversation(c: ApiConversation): Conversation {
  return {
    id: c.id,
    title: c.title,
    expertId: c.expert_id ?? null,
    source: c.source === 'telegram' ? 'telegram' : 'cerebro',
    externalChatId: c.external_chat_id ?? null,
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

export function toApiIntegrationProposal(
  p: IntegrationSetupProposal,
): Record<string, unknown> {
  return {
    integration_id: p.integrationId,
    reason: p.reason,
    status: p.status,
  };
}

export function toApiTeamRun(r: TeamRun): Record<string, unknown> {
  return {
    team_id: r.teamId,
    team_name: r.teamName,
    strategy: r.strategy,
    status: r.status,
    success_count: r.successCount,
    total_count: r.totalCount,
    started_at: r.startedAt,
    members: r.members.map((m) => ({
      member_id: m.memberId,
      member_name: m.memberName,
      role: m.role,
      status: m.status,
      response: m.response,
    })),
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

export interface MessagePatch {
  content?: string;
  metadata?: Record<string, unknown>;
}

export function apiPatchMessage(
  convId: string,
  msgId: string,
  body: MessagePatch,
): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'PATCH',
    path: `/conversations/${convId}/messages/${msgId}`,
    body,
  });
}

export function apiPatchMessageMetadata(
  convId: string,
  msgId: string,
  metadata: Record<string, unknown>,
): Promise<unknown> {
  return apiPatchMessage(convId, msgId, { metadata });
}

export function apiDeleteMessagesAfter(
  convId: string,
  msgId: string,
): Promise<unknown> {
  return window.cerebro.invoke({
    method: 'DELETE',
    path: `/conversations/${convId}/messages/after/${msgId}`,
  });
}
