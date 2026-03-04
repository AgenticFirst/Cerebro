import { useState } from 'react';
import {
  Zap,
  Play,
  Save,
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
  Link,
  ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import type { RoutineProposal } from '../../types/chat';
import { useChat } from '../../context/ChatContext';
import { useRoutines } from '../../context/RoutineContext';
import { compileLinearDAG } from '../../engine/dag/compiler';
import { apiPatchMessageMetadata, toApiProposal } from '../../context/chat-helpers';

interface RoutineProposalCardProps {
  proposal: RoutineProposal;
  messageId: string;
  conversationId: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual',
  cron: 'Scheduled',
  webhook: 'Webhook',
};

function StatusBadge({ status }: { status: RoutineProposal['status'] }) {
  const styles = {
    proposed: 'bg-cyan-500/15 text-cyan-400',
    previewing: 'bg-yellow-500/15 text-yellow-400',
    saved: 'bg-green-500/15 text-green-400',
    dismissed: 'bg-zinc-500/15 text-zinc-400',
  };
  const labels = {
    proposed: 'Proposed',
    previewing: 'Previewing',
    saved: 'Saved',
    dismissed: 'Dismissed',
  };

  return (
    <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full', styles[status])}>
      {labels[status]}
    </span>
  );
}

export default function RoutineProposalCard({
  proposal,
  messageId,
  conversationId,
}: RoutineProposalCardProps) {
  const { updateMessage, addMessage } = useChat();
  const { createRoutine } = useRoutines();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCollapsed = proposal.status === 'dismissed' || proposal.status === 'saved';

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const dag = compileLinearDAG({
        steps: proposal.steps,
        defaultRunnerId: proposal.defaultRunnerId,
        approvalGates: proposal.approvalGates,
      });
      const routine = await createRoutine({
        name: proposal.name,
        description: proposal.description,
        plainEnglishSteps: proposal.steps,
        dagJson: JSON.stringify(dag),
        triggerType: proposal.triggerType,
        cronExpression: proposal.cronExpression,
        defaultRunnerId: proposal.defaultRunnerId,
        approvalGates: proposal.approvalGates,
        requiredConnections: proposal.requiredConnections,
        source: 'chat',
        sourceConversationId: conversationId,
      });
      if (routine) {
        const saved = { ...proposal, status: 'saved' as const, savedRoutineId: routine.id };
        updateMessage(conversationId, messageId, { routineProposal: saved });
        apiPatchMessageMetadata(conversationId, messageId, {
          routine_proposal: toApiProposal(saved),
        }).catch(console.error);
      } else {
        setError('Failed to save routine. Please try again.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to save: ${msg}`);
      console.error('Failed to save routine:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreview = async () => {
    setError(null);
    try {
      const dag = compileLinearDAG({
        steps: proposal.steps,
        defaultRunnerId: proposal.defaultRunnerId,
        approvalGates: proposal.approvalGates,
      });
      const runId = await window.cerebro.engine.run({
        dag,
        triggerSource: 'preview',
      });

      // Update proposal status on the original message
      const previewing = { ...proposal, status: 'previewing' as const };
      updateMessage(conversationId, messageId, { routineProposal: previewing });
      apiPatchMessageMetadata(conversationId, messageId, {
        routine_proposal: toApiProposal(previewing),
      }).catch(console.error);

      // Create a new assistant message for the RunLogCard and attach the engineRunId
      // Pass metadata in the initial POST to avoid a race with a separate PATCH
      const previewMsgId = addMessage(
        conversationId,
        'assistant',
        `Preview run for **${proposal.name}**...`,
        { engine_run_id: runId },
      );
      updateMessage(conversationId, previewMsgId, { engineRunId: runId });
    } catch (err) {
      // Restore to 'proposed' so the user can retry
      updateMessage(conversationId, messageId, {
        routineProposal: { ...proposal, status: 'proposed' },
      });
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to start preview: ${msg}`);
      console.error('Failed to start preview:', err);
    }
  };

  const handleDismiss = () => {
    const dismissed = { ...proposal, status: 'dismissed' as const };
    updateMessage(conversationId, messageId, { routineProposal: dismissed });
    apiPatchMessageMetadata(conversationId, messageId, {
      routine_proposal: toApiProposal(dismissed),
    }).catch(console.error);
  };

  return (
    <div
      className={clsx(
        'animate-card-in rounded-lg border overflow-hidden',
        isCollapsed
          ? 'border-border-subtle bg-bg-surface/30 opacity-60'
          : 'border-accent/30 bg-bg-surface/50',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Zap size={14} className={isCollapsed ? 'text-text-tertiary' : 'text-accent'} />
        <span
          className={clsx(
            'flex-1 text-xs font-medium truncate',
            isCollapsed ? 'text-text-tertiary' : 'text-text-secondary',
          )}
        >
          {proposal.name}
        </span>
        <StatusBadge status={proposal.status} />
      </div>

      {/* Description */}
      {proposal.description && !isCollapsed && (
        <div className="border-t border-border-subtle px-3 py-1.5">
          <p className="text-[11px] text-text-tertiary leading-relaxed">{proposal.description}</p>
        </div>
      )}

      {/* Steps (hidden when collapsed) */}
      {!isCollapsed && (
        <div className="border-t border-border-subtle px-3 py-2 space-y-1">
          {proposal.steps.map((step, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-[10px] font-mono w-4 text-right flex-shrink-0 mt-0.5 text-accent/60">
                {i + 1}
              </span>
              <span className="text-xs leading-relaxed text-text-secondary">
                {step}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Metadata row (hidden when collapsed) */}
      {!isCollapsed && (
        <div className="border-t border-border-subtle px-3 py-1.5 flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
            <Clock size={10} />
            {TRIGGER_LABELS[proposal.triggerType] ?? proposal.triggerType}
            {proposal.cronExpression && ` (${proposal.cronExpression})`}
          </span>
          {proposal.requiredConnections.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
              <Link size={10} />
              {proposal.requiredConnections.join(', ')}
            </span>
          )}
          {proposal.approvalGates.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-text-tertiary">
              <ShieldCheck size={10} />
              {proposal.approvalGates.length} approval gate{proposal.approvalGates.length !== 1 && 's'}
            </span>
          )}
        </div>
      )}

      {/* Inline error */}
      {error && (
        <div className="border-t border-red-500/20 px-3 py-1.5 flex items-center gap-1.5">
          <AlertCircle size={11} className="text-red-400 flex-shrink-0" />
          <span className="text-[11px] text-red-400">{error}</span>
        </div>
      )}

      {/* Actions */}
      {proposal.status === 'proposed' && (
        <div className="border-t border-border-subtle px-3 py-2 flex items-center gap-2">
          <button
            onClick={handlePreview}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-bg-hover/50 text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            <Play size={11} />
            Preview
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Save size={11} />
            Save Routine
          </button>
          <button
            onClick={handleDismiss}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors cursor-pointer ml-auto"
          >
            <X size={11} />
            Dismiss
          </button>
        </div>
      )}

      {proposal.status === 'previewing' && (
        <div className="border-t border-border-subtle px-3 py-2 flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Save size={11} />
            Save Routine
          </button>
        </div>
      )}

      {proposal.status === 'saved' && (
        <div className="border-t border-border-subtle px-3 py-2">
          <span className="flex items-center gap-1.5 text-[11px] text-green-400 font-medium">
            <CheckCircle2 size={12} />
            Saved as routine
          </span>
        </div>
      )}
    </div>
  );
}
