import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useApprovals } from '../../context/ApprovalContext';
import ApprovalCard from '../screens/approvals/ApprovalCard';

interface InlineApprovalsProps {
  conversationId: string;
}

/**
 * Surfaces pending approvals belonging to the active conversation directly in
 * the chat stream, so the user can approve/deny without leaving the chat for
 * the Approvals screen. Complements (does not replace) the toast in AppLayout.
 *
 * Only approvals whose run carries this conversation's id are shown — approvals
 * with no conversation (e.g. routine-triggered) stay on the Approvals screen.
 * Cards drop automatically when resolved here, on the Approvals screen, or from
 * Slack/Telegram, because ApprovalContext refreshes on every approval event.
 */
export default function InlineApprovals({ conversationId }: InlineApprovalsProps) {
  const { t } = useTranslation();
  const { pendingApprovals, approve, deny } = useApprovals();

  const forThisChat = pendingApprovals.filter(
    (a) => a.conversation_id && a.conversation_id === conversationId,
  );

  if (forThisChat.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {forThisChat.map((approval) => (
        <div key={approval.id}>
          <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-medium text-amber-400">
            <ShieldAlert size={12} />
            <span>{t('approvals.inlineTitle')}</span>
          </div>
          <ApprovalCard approval={approval} variant="pending" onApprove={approve} onDeny={deny} />
        </div>
      ))}
    </div>
  );
}
