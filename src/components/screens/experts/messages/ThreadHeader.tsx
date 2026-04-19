import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Clock, Info, Users } from 'lucide-react';
import clsx from 'clsx';
import { useExperts, type Expert } from '../../../../context/ExpertContext';
import type { Conversation } from '../../../../types/chat';
import ExpertAvatar from './ExpertAvatar';
import TeamAvatar from './TeamAvatar';
import ThreadsDropdown from './ThreadsDropdown';

interface ThreadHeaderProps {
  expert: Expert;
  threads: Conversation[];
  activeThreadId: string | null;
  isTyping: boolean;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
  onOpenProfile: () => void;
}

export default function ThreadHeader({
  expert,
  threads,
  activeThreadId,
  isTyping,
  onSelectThread,
  onNewThread,
  onOpenProfile,
}: ThreadHeaderProps) {
  const { t } = useTranslation();
  const { experts: allExperts } = useExperts();
  const [showThreads, setShowThreads] = useState(false);

  const isTeam = expert.type === 'team';
  const members = useMemo(() => {
    if (!isTeam) return [];
    const ids = (expert.teamMembers ?? []).map((m) => m.expertId);
    const byId = new Map(allExperts.map((e) => [e.id, e] as const));
    return ids.map((id) => byId.get(id)).filter((e): e is Expert => Boolean(e));
  }, [isTeam, expert.teamMembers, allExperts]);

  const strategyLabel = isTeam
    ? t(
        expert.strategy === 'parallel'
          ? 'experts.teamStrategyParallel'
          : expert.strategy === 'auto'
            ? 'experts.teamStrategyAuto'
            : 'experts.teamStrategySequential',
      )
    : null;

  const subtitleText = isTeam
    ? members.map((m) => m.name).join(' · ') || expert.description?.slice(0, 60) || ''
    : expert.domain || expert.description?.slice(0, 60) || '';

  return (
    <div className="sticky top-0 z-10 bg-bg-base border-b border-border-subtle">
      <div className="flex items-center gap-3 px-5 py-3">
        {isTeam ? (
          <button
            onClick={onOpenProfile}
            className="cursor-pointer transition-transform hover:scale-105"
            title={t('experts.openProfile')}
          >
            <TeamAvatar team={expert} members={members} size={36} />
          </button>
        ) : (
          <ExpertAvatar expert={expert} size={36} onClick={onOpenProfile} />
        )}
        <div className="flex-1 min-w-0">
          <button
            onClick={onOpenProfile}
            className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-text-primary hover:text-accent transition-colors cursor-pointer"
          >
            <span className="truncate">{expert.name}</span>
            {expert.isVerified && (
              <BadgeCheck
                size={14}
                className="text-accent flex-shrink-0"
                strokeWidth={2.25}
                aria-label={t('experts.verified')}
              />
            )}
            {isTeam && (
              <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full bg-accent/10 text-[10px] font-medium text-accent uppercase tracking-wide flex-shrink-0">
                <Users size={10} strokeWidth={2.5} />
                {t('experts.teamLabel')}
              </span>
            )}
            {isTeam && strategyLabel && (
              <span className="px-1.5 py-px rounded-full bg-bg-elevated text-[10px] font-medium text-text-secondary flex-shrink-0">
                {strategyLabel}
              </span>
            )}
          </button>
          <div className="text-[11px] text-text-tertiary truncate">
            {isTyping ? (
              <span className="italic text-accent">
                {t('experts.typingIndicator', { name: expert.name })}
              </span>
            ) : (
              subtitleText
            )}
          </div>
        </div>
        <div className="relative flex items-center gap-1">
          <button
            onClick={() => setShowThreads((v) => !v)}
            className={clsx(
              'flex items-center justify-center w-8 h-8 rounded-md',
              'transition-colors duration-150 cursor-pointer',
              showThreads
                ? 'bg-bg-elevated text-accent'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
            )}
            title={t('experts.threadsHeader')}
          >
            <Clock size={15} />
          </button>
          <button
            onClick={onOpenProfile}
            className={clsx(
              'flex items-center justify-center w-8 h-8 rounded-md',
              'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
              'transition-colors duration-150 cursor-pointer',
            )}
            title={t('experts.openProfile')}
          >
            <Info size={15} />
          </button>

          {showThreads && (
            <ThreadsDropdown
              threads={threads}
              activeThreadId={activeThreadId}
              onSelect={onSelectThread}
              onNewThread={onNewThread}
              onClose={() => setShowThreads(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
