export interface ApprovalRequest {
  id: string;
  run_id: string;
  /**
   * Conversation that originated this approval's run, when known (joined from
   * the run record on the backend). Lets the chat surface render the approval
   * inline in the right thread. Null for approvals not tied to a chat (e.g.
   * routine-triggered ones), which stay on the Approvals screen only.
   */
  conversation_id: string | null;
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

/**
 * A persistent "don't ask again" rule: skips the approval gate for one chat
 * action aimed at one exact destination (e.g. Slack messages to a single
 * channel). New destinations still pause for approval the first time. Created
 * via natural language in chat; revocable from chat or the Approvals screen.
 */
export interface AutoApprovalRule {
  id: string;
  /** Chat action type, e.g. "send_slack_message" or "send_slack_file". */
  action_type: string;
  /** Destination id this rule applies to, e.g. a Slack channel id. */
  target_key: string;
  /** Human-readable destination for display, e.g. "#general". May be null. */
  target_label: string | null;
  created_at: string;
}

export interface AutoApprovalRuleListResponse {
  rules: AutoApprovalRule[];
  total: number;
}
