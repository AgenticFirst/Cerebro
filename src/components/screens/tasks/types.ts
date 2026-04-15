/**
 * Types for the Tasks feature — shared across TaskContext, UI components,
 * and the stream parser.
 */

// ── Deliverable kinds ─────────────────────────────────────────────

export type DeliverableKind = 'markdown' | 'code_app' | 'mixed';

// ── Plan ──────────────────────────────────────────────────────────

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlanPhase {
  id: string;
  name: string;
  description: string;
  expert_slug: string | null;
  needs_new_expert: boolean;
  new_expert?: { name: string; description: string; domain: string } | null;
  status: PhaseStatus;
  child_run_id: string | null;
  summary: string | null;
}

export interface TaskPlan {
  phases: PlanPhase[];
}

// ── Run info (dev server) ─────────────────────────────────────────

export type PreviewType = 'web' | 'expo' | 'cli' | 'static';

export interface RunInfo {
  preview_type: PreviewType;
  setup_commands: string[];
  start_command: string;
  preview_url_pattern: string | null;
  notes: string | null;
}

// ── Clarification ─────────────────────────────────────────────────

export type ClarificationKind = 'text' | 'select' | 'bool';

export interface ClarificationQuestion {
  id: string;
  q: string;
  kind: ClarificationKind;
  options?: string[] | null;
  default?: string | boolean | null;
  placeholder?: string | null;
}

// ── Task ──────────────────────────────────────────────────────────

export type TaskStatus =
  | 'pending'
  | 'clarifying'
  | 'awaiting_clarification'
  | 'planning'
  | 'awaiting_plan_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Task {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  expert_hint_id: string | null;
  template_id: string | null;
  run_id: string | null;
  conversation_id: string | null;
  plan: TaskPlan | null;
  deliverable_markdown: string | null;
  deliverable_title: string | null;
  deliverable_kind: DeliverableKind;
  workspace_path: string | null;
  run_info: RunInfo | null;
  clarifications: {
    questions?: ClarificationQuestion[];
    answers?: Array<{ id: string; answer: string | boolean }>;
  } | null;
  skip_clarification: boolean;
  max_turns: number;
  max_phases: number;
  created_expert_ids: string[];
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  plan_md: string | null;
  plan_md_mtime: number | null;
}

export interface TaskDetail extends Task {
  run: unknown | null;
  child_runs: unknown[];
  dev_server: {
    running: boolean;
    pid: number | null;
    url: string | null;
    started_at: string | null;
    stdout_tail: string | null;
    preview_type: string | null;
  } | null;
}

// ── New task input ────────────────────────────────────────────────

export interface NewTaskInput {
  title: string;
  goal: string;
  expertHintId?: string | null;
  templateId?: string | null;
  maxTurns?: number;
  maxPhases?: number;
  skipClarification?: boolean;
  model?: string;
}

// ── Phase runtime state (live tracking in context) ────────────────

export interface PhaseRuntimeState {
  status: PhaseStatus;
  name: string;
  summary: string | null;
}

// ── Log entry (for TaskConsoleView) ───────────────────────────────

export type TaskLogEntry =
  | { kind: 'text_delta'; text: string; phaseId: string | null }
  | { kind: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { kind: 'tool_end'; toolCallId: string; toolName: string; result: string; isError: boolean }
  | { kind: 'phase_start'; phaseId: string; name: string }
  | { kind: 'phase_end'; phaseId: string }
  | { kind: 'error'; message: string }
  | { kind: 'system'; message: string };
