// ── Activity screen types (matches backend snake_case wire format) ──

export interface RunRecord {
  id: string;
  routine_id: string | null;
  expert_id: string | null;
  conversation_id: string | null;
  parent_run_id: string | null;
  status: string;
  run_type: string;
  trigger: string;
  dag_json: string | null;
  total_steps: number;
  completed_steps: number;
  error: string | null;
  failed_step_id: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  steps: StepRecord[] | null;
}

export interface StepRecord {
  id: string;
  run_id: string;
  step_id: string;
  step_name: string;
  action_type: string;
  status: string;
  summary: string | null;
  error: string | null;
  input_json: string | null;
  output_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  order_index: number;
  approval_id: string | null;
  approval_status: string | null;
}

export interface EventRecord {
  id: string;
  run_id: string;
  seq: number;
  event_type: string;
  step_id: string | null;
  payload_json: string;
  timestamp: string;
}

export interface RunListResponse {
  runs: RunRecord[];
  total: number;
}
