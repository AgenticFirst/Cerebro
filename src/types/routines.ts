// ── Frontend types for Routines ─────────────────────────────────

export type TriggerType = 'manual' | 'cron' | 'webhook';
export type RoutineSource = 'user' | 'chat' | 'marketplace';

export interface Routine {
  id: string;
  name: string;
  description: string;
  plainEnglishSteps: string[] | null;
  dagJson: string | null;
  triggerType: TriggerType;
  cronExpression: string | null;
  defaultRunnerId: string | null;
  isEnabled: boolean;
  approvalGates: string[] | null;
  requiredConnections: string[] | null;
  source: RoutineSource;
  sourceConversationId: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiRoutine {
  id: string;
  name: string;
  description: string;
  plain_english_steps: string[] | null;
  dag_json: string | null;
  trigger_type: string;
  cron_expression: string | null;
  default_runner_id: string | null;
  is_enabled: boolean;
  approval_gates: string[] | null;
  required_connections: string[] | null;
  source: string;
  source_conversation_id: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateRoutineInput {
  name: string;
  description?: string;
  plainEnglishSteps?: string[];
  dagJson?: string;
  triggerType?: TriggerType;
  cronExpression?: string;
  defaultRunnerId?: string;
  approvalGates?: string[];
  requiredConnections?: string[];
  source?: RoutineSource;
  sourceConversationId?: string;
}

export function toRoutine(api: ApiRoutine): Routine {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    plainEnglishSteps: api.plain_english_steps,
    dagJson: api.dag_json,
    triggerType: api.trigger_type as TriggerType,
    cronExpression: api.cron_expression,
    defaultRunnerId: api.default_runner_id,
    isEnabled: api.is_enabled,
    approvalGates: api.approval_gates,
    requiredConnections: api.required_connections,
    source: api.source as RoutineSource,
    sourceConversationId: api.source_conversation_id,
    lastRunAt: api.last_run_at,
    lastRunStatus: api.last_run_status,
    runCount: api.run_count,
    createdAt: api.created_at,
    updatedAt: api.updated_at,
  };
}

export function toApiBody(input: CreateRoutineInput): Record<string, unknown> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.description !== undefined) body.description = input.description;
  if (input.plainEnglishSteps !== undefined) body.plain_english_steps = input.plainEnglishSteps;
  if (input.dagJson !== undefined) body.dag_json = input.dagJson;
  if (input.triggerType !== undefined) body.trigger_type = input.triggerType;
  if (input.cronExpression !== undefined) body.cron_expression = input.cronExpression;
  if (input.defaultRunnerId !== undefined) body.default_runner_id = input.defaultRunnerId;
  if (input.approvalGates !== undefined) body.approval_gates = input.approvalGates;
  if (input.requiredConnections !== undefined) body.required_connections = input.requiredConnections;
  if (input.source !== undefined) body.source = input.source;
  if (input.sourceConversationId !== undefined) body.source_conversation_id = input.sourceConversationId;
  return body;
}
