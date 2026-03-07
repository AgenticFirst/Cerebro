/**
 * ExecutionEvent — full discriminated union for DAG execution events.
 *
 * These events stream from the main process to the renderer via IPC,
 * providing real-time visibility into routine execution.
 */

export type ExecutionEvent =
  // ── Run lifecycle ──────────────────────────────────────────────
  | { type: 'run_started'; runId: string; totalSteps: number; timestamp: string }
  | { type: 'run_completed'; runId: string; durationMs: number; timestamp: string }
  | { type: 'run_failed'; runId: string; error: string; failedStepId: string; timestamp: string }
  | { type: 'run_cancelled'; runId: string; reason?: string; timestamp: string }

  // ── Step lifecycle ─────────────────────────────────────────────
  | { type: 'step_queued'; runId: string; stepId: string; stepName: string; timestamp: string }
  | { type: 'step_started'; runId: string; stepId: string; stepName: string; actionType: string; timestamp: string }
  | { type: 'step_log'; runId: string; stepId: string; message: string; timestamp: string }
  | { type: 'step_completed'; runId: string; stepId: string; stepName: string; summary: string; durationMs: number; timestamp: string }
  | { type: 'step_failed'; runId: string; stepId: string; stepName: string; error: string; timestamp: string }
  | { type: 'step_skipped'; runId: string; stepId: string; stepName: string; reason: string; timestamp: string }

  // ── Action detail (expert_step surfaces agent reasoning) ───────
  | { type: 'action_text_delta'; runId: string; stepId: string; delta: string }
  | { type: 'action_tool_start'; runId: string; stepId: string; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'action_tool_end'; runId: string; stepId: string; toolCallId: string; toolName: string; result: string; isError: boolean }

  // ── Approval gates (Phase 5 — defined here for type completeness)
  | { type: 'approval_requested'; runId: string; stepId: string; approvalId: string; summary: string; payload: unknown; timestamp: string }
  | { type: 'approval_granted'; runId: string; stepId: string; approvalId: string; timestamp: string }
  | { type: 'approval_denied'; runId: string; stepId: string; approvalId: string; reason?: string; timestamp: string };
