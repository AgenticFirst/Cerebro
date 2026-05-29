/**
 * Shared approval-routing logic for the chat bridges (Slack, Telegram).
 *
 * When the engine emits an `approval_requested` event, the bridge has to
 * decide which active run — and therefore which chat thread — it belongs to.
 * Chat-action runs carry the originating `conversationId` (stamped onto the
 * request body by `run-chat-action.sh`), so we can match it precisely even
 * when several runs are in flight at once.
 *
 * Behaviour:
 *   - With a conversationId: return the exact match; if none matches (a run we
 *     somehow lost track of), fall back to the most recently started run so
 *     the approval is never silently dropped — a dropped chat-action approval
 *     leaves the engine paused forever, which is the bug this prevents.
 *   - Without a conversationId (e.g. a routine-triggered approval that never
 *     ran through a chat): keep the conservative single-run heuristic so we
 *     don't hijack it into an unrelated chat. The caller decides what to do
 *     when this returns null (Telegram broadcasts via forwardAllApprovals).
 */
export interface ApprovalRunCandidate<K> {
  /** Identifier the caller uses to address the run (Slack: the run object; Telegram: chatId). */
  id: K;
  conversationId: string;
  startedAt: number;
}

export function pickApprovalRun<K>(
  runs: ReadonlyArray<ApprovalRunCandidate<K>>,
  conversationId: string | undefined,
): K | null {
  if (runs.length === 0) return null;

  if (conversationId) {
    const exact = runs.find((r) => r.conversationId === conversationId);
    if (exact) return exact.id;
    return runs.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).id;
  }

  // No origin id to match on — only attribute when there's exactly one run.
  if (runs.length !== 1) return null;
  return runs[0].id;
}
