import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import type { Conversation } from '../../../../types/chat';

interface ThreadsDropdownProps {
  threads: Conversation[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewThread: () => void;
  onClose: () => void;
}

function formatRelative(date: Date): string {
  const now = Date.now();
  const ms = now - date.getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function lastMessagePreview(conv: Conversation): string {
  const msgs = conv.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.content) {
      const clean = m.content.replace(/^@\S+\n?/gm, '').trim();
      return clean || '(attachment)';
    }
  }
  return '';
}

export default function ThreadsDropdown({
  threads,
  activeThreadId,
  onSelect,
  onNewThread,
  onClose,
}: ThreadsDropdownProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className={clsx(
        'absolute right-0 top-full mt-2 z-30',
        'w-[320px] max-h-[420px]',
        'bg-bg-elevated border border-border-default rounded-lg shadow-lg',
        'flex flex-col overflow-hidden',
      )}
    >
      <div className="px-3 py-2 border-b border-border-subtle">
        <div className="text-[11px] font-semibold text-text-tertiary uppercase tracking-[0.08em]">
          {t('experts.threadsHeader')}
        </div>
      </div>

      <button
        onClick={() => {
          onNewThread();
          onClose();
        }}
        className={clsx(
          'flex items-center gap-2 px-3 py-2 text-[13px] font-medium',
          'text-accent hover:bg-accent/10 cursor-pointer',
          'border-b border-border-subtle',
        )}
      >
        <Plus size={14} />
        {t('experts.newThread')}
      </button>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {threads.length === 0 && (
          <div className="px-3 py-6 text-[11px] text-text-tertiary text-center">
            {t('experts.noThreadsYet')}
          </div>
        )}
        {threads.map((thread) => {
          const preview = lastMessagePreview(thread);
          const isActive = thread.id === activeThreadId;
          return (
            <button
              key={thread.id}
              onClick={() => {
                onSelect(thread.id);
                onClose();
              }}
              className={clsx(
                'w-full flex items-start gap-2.5 px-3 py-2 text-left',
                'transition-colors duration-150 cursor-pointer',
                isActive ? 'bg-bg-hover' : 'hover:bg-white/[0.03]',
              )}
            >
              <MessageSquare
                size={13}
                className={clsx('mt-0.5 flex-shrink-0', isActive ? 'text-accent' : 'text-text-tertiary')}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-text-primary truncate">
                    {thread.title}
                  </span>
                  <span className="ml-auto text-[10px] text-text-tertiary flex-shrink-0">
                    {formatRelative(thread.updatedAt)}
                  </span>
                </div>
                {preview && (
                  <div className="text-[11px] text-text-tertiary truncate mt-0.5">{preview}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
