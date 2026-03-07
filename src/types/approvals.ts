export interface ApprovalRequest {
  id: string;
  run_id: string;
  step_id: string;
  step_name: string;
  summary: string;
  payload_json: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decision_reason: string | null;
  requested_at: string;
  resolved_at: string | null;
}

export interface ApprovalListResponse {
  approvals: ApprovalRequest[];
  total: number;
}
