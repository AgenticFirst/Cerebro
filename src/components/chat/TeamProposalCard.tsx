import { useState } from 'react';
import {
  Users,
  Save,
  X,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  UserPlus,
  Link,
} from 'lucide-react';
import clsx from 'clsx';
import type { TeamProposal } from '../../types/chat';
import { useChat } from '../../context/ChatContext';
import { useExperts } from '../../context/ExpertContext';
import { apiPatchMessageMetadata, toApiTeamProposal } from '../../context/chat-helpers';

interface TeamProposalCardProps {
  proposal: TeamProposal;
  messageId: string;
  conversationId: string;
}

function StatusBadge({ status }: { status: TeamProposal['status'] }) {
  const styles = {
    proposed: 'bg-cyan-500/15 text-cyan-400',
    previewing: 'bg-yellow-500/15 text-yellow-400',
    saved: 'bg-green-500/15 text-green-400',
    dismissed: 'bg-zinc-500/15 text-zinc-400',
  };
  const labels = {
    proposed: 'Proposed',
    previewing: 'Reviewing',
    saved: 'Saved',
    dismissed: 'Dismissed',
  };

  return (
    <span className={clsx('text-[10px] font-medium px-1.5 py-0.5 rounded-full', styles[status])}>
      {labels[status]}
    </span>
  );
}

function StrategyBadge({ strategy }: { strategy: string }) {
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400">
      {strategy}
    </span>
  );
}

export default function TeamProposalCard({
  proposal,
  messageId,
  conversationId,
}: TeamProposalCardProps) {
  const { updateMessage } = useChat();
  const { createExpert } = useExperts();
  const [isSaving, setIsSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCollapsed = proposal.status === 'dismissed' || proposal.status === 'saved';

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    try {
      // 1. Create new member experts (those without expertId)
      const resolvedMembers: Array<{ expertId: string; role: string; order: number }> = [];

      for (const member of proposal.members) {
        if (member.expertId) {
          resolvedMembers.push({
            expertId: member.expertId,
            role: member.role,
            order: member.order,
          });
        } else if (member.name && member.description) {
          // Create new expert
          const newExpert = await createExpert({
            name: member.name,
            description: member.description,
            source: 'user',
          });
          if (newExpert) {
            resolvedMembers.push({
              expertId: newExpert.id,
              role: member.role,
              order: member.order,
            });
          } else {
            setError(`Failed to create member expert "${member.name}".`);
            setIsSaving(false);
            return;
          }
        }
      }

      // 2. Create the team
      const team = await createExpert({
        name: proposal.name,
        description: proposal.description,
        type: 'team',
        teamMembers: resolvedMembers,
        strategy: proposal.strategy !== 'auto' ? proposal.strategy : undefined,
        coordinatorPrompt: proposal.coordinatorPrompt ?? undefined,
        source: 'user',
      });

      if (team) {
        const saved = { ...proposal, status: 'saved' as const, savedTeamId: team.id };
        updateMessage(conversationId, messageId, { teamProposal: saved });
        apiPatchMessageMetadata(conversationId, messageId, {
          team_proposal: toApiTeamProposal(saved),
        }).catch(console.error);
      } else {
        setError('Failed to save team. Please try again.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to save: ${msg}`);
      console.error('Failed to save team:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePreview = () => {
    setIsExpanded(!isExpanded);
    if (!isExpanded) {
      const previewing = { ...proposal, status: 'previewing' as const };
      updateMessage(conversationId, messageId, { teamProposal: previewing });
      apiPatchMessageMetadata(conversationId, messageId, {
        team_proposal: toApiTeamProposal(previewing),
      }).catch(console.error);
    } else {
      const proposed = { ...proposal, status: 'proposed' as const };
      updateMessage(conversationId, messageId, { teamProposal: proposed });
      apiPatchMessageMetadata(conversationId, messageId, {
        team_proposal: toApiTeamProposal(proposed),
      }).catch(console.error);
    }
  };

  const handleDismiss = () => {
    const dismissed = { ...proposal, status: 'dismissed' as const };
    updateMessage(conversationId, messageId, { teamProposal: dismissed });
    apiPatchMessageMetadata(conversationId, messageId, {
      team_proposal: toApiTeamProposal(dismissed),
    }).catch(console.error);
  };

  return (
    <div
      className={clsx(
        'animate-card-in rounded-lg border overflow-hidden',
        isCollapsed
          ? 'border-border-subtle bg-bg-surface/30 opacity-60'
          : 'border-cyan-500/30 bg-bg-surface/50',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Users size={14} className={isCollapsed ? 'text-text-tertiary' : 'text-cyan-400'} />
        <span
          className={clsx(
            'flex-1 text-xs font-medium truncate',
            isCollapsed ? 'text-text-tertiary' : 'text-text-secondary',
          )}
        >
          {proposal.name}
        </span>
        <StrategyBadge strategy={proposal.strategy} />
        <StatusBadge status={proposal.status} />
      </div>

      {/* Description */}
      {proposal.description && !isCollapsed && (
        <div className="border-t border-border-subtle px-3 py-1.5">
          <p className="text-[11px] text-text-tertiary leading-relaxed">{proposal.description}</p>
        </div>
      )}

      {/* Members list */}
      {!isCollapsed && (
        <div className="border-t border-border-subtle px-3 py-1.5">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
            Members ({proposal.members.length})
          </div>
          <div className="space-y-1">
            {proposal.members.map((member, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px]">
                {member.expertId ? (
                  <Link size={10} className="text-cyan-400 flex-shrink-0" />
                ) : (
                  <UserPlus size={10} className="text-purple-400 flex-shrink-0" />
                )}
                <span className="text-text-secondary">
                  {member.name ?? member.role}
                </span>
                <span className="text-text-tertiary">({member.role})</span>
                {!member.expertId && (
                  <span className="text-[9px] text-purple-400 font-medium">NEW</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expanded details */}
      {!isCollapsed && isExpanded && proposal.coordinatorPrompt && (
        <div className="border-t border-border-subtle px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">
            Coordinator Prompt
          </div>
          <div className="text-[11px] text-text-tertiary font-mono leading-relaxed whitespace-pre-wrap">
            {proposal.coordinatorPrompt}
          </div>
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
      {(proposal.status === 'proposed' || proposal.status === 'previewing') && (
        <div className="border-t border-border-subtle px-3 py-2 flex items-center gap-2">
          {proposal.coordinatorPrompt && (
            <button
              onClick={handlePreview}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-bg-hover/50 text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {isExpanded ? 'Collapse' : 'Details'}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25 transition-colors cursor-pointer disabled:opacity-50"
          >
            <Save size={11} />
            {isSaving ? 'Saving...' : 'Save Team'}
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

      {proposal.status === 'saved' && (
        <div className="border-t border-border-subtle px-3 py-2">
          <span className="flex items-center gap-1.5 text-[11px] text-green-400 font-medium">
            <CheckCircle2 size={12} />
            Saved as team
          </span>
        </div>
      )}
    </div>
  );
}
