import { useMemo } from 'react';
import { Plus, Settings } from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../context/ChatContext';
import type { Conversation } from '../../types/chat';

interface GroupedConversations {
  label: string;
  conversations: Conversation[];
}

function groupByTime(conversations: Conversation[]): GroupedConversations[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - 7 * 86400000);

  const groups: Record<string, Conversation[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 Days': [],
    Older: [],
  };

  for (const conv of conversations) {
    const t = conv.updatedAt.getTime();
    if (t >= todayStart.getTime()) groups['Today'].push(conv);
    else if (t >= yesterdayStart.getTime()) groups['Yesterday'].push(conv);
    else if (t >= weekStart.getTime()) groups['Previous 7 Days'].push(conv);
    else groups['Older'].push(conv);
  }

  return Object.entries(groups)
    .filter(([, convs]) => convs.length > 0)
    .map(([label, convs]) => ({ label, conversations: convs }));
}

export default function Sidebar() {
  const { conversations, activeConversationId, createConversation, setActiveConversation } =
    useChat();

  const grouped = useMemo(() => groupByTime(conversations), [conversations]);

  const handleNewChat = () => {
    createConversation();
  };

  return (
    <div className="w-[260px] flex-shrink-0 flex flex-col bg-bg-surface border-r border-border-subtle h-full">
      {/* New chat button */}
      <div className="p-3">
        <button
          onClick={handleNewChat}
          className={clsx(
            'w-full flex items-center gap-2 px-3 py-2.5 rounded-lg',
            'text-sm font-medium text-text-primary',
            'bg-accent/10 hover:bg-accent/20',
            'border border-accent/20',
            'transition-colors duration-150 cursor-pointer',
          )}
        >
          <Plus size={16} className="text-accent" />
          New Chat
        </button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        {grouped.map((group) => (
          <div key={group.label} className="mb-3">
            <div className="px-2 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
              {group.label}
            </div>
            {group.conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              return (
                <button
                  key={conv.id}
                  onClick={() => setActiveConversation(conv.id)}
                  className={clsx(
                    'w-full text-left px-3 py-2 rounded-lg text-sm truncate',
                    'transition-colors duration-150 cursor-pointer',
                    isActive
                      ? 'bg-accent-muted text-text-primary border-l-2 border-accent'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {conv.title}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Settings placeholder */}
      <div className="p-3 border-t border-border-subtle">
        <button
          className={clsx(
            'w-full flex items-center gap-2 px-3 py-2 rounded-lg',
            'text-sm text-text-secondary',
            'hover:bg-bg-hover hover:text-text-primary',
            'transition-colors duration-150 cursor-pointer',
          )}
        >
          <Settings size={16} />
          Settings
        </button>
      </div>
    </div>
  );
}
