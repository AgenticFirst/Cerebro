import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Info } from 'lucide-react';
import clsx from 'clsx';
import type { Expert } from '../../../../context/ExpertContext';
import type { Conversation } from '../../../../types/chat';
import ExpertAvatar from './ExpertAvatar';
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
  const [showThreads, setShowThreads] = useState(false);

  return (
    <div className="sticky top-0 z-10 bg-bg-base border-b border-border-subtle">
      <div className="flex items-center gap-3 px-5 py-3">
        <ExpertAvatar expert={expert} size={36} onClick={onOpenProfile} />
        <div className="flex-1 min-w-0">
          <button
            onClick={onOpenProfile}
            className="text-[14px] font-semibold text-text-primary hover:text-accent transition-colors cursor-pointer"
          >
            {expert.name}
          </button>
          <div className="text-[11px] text-text-tertiary capitalize">
            {isTyping ? (
              <span className="italic text-accent">
                {t('experts.typingIndicator', { name: expert.name })}
              </span>
            ) : (
              expert.domain || expert.description?.slice(0, 60) || ''
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
