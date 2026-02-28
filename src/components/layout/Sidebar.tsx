import { useMemo, useState } from 'react';
import {
  MessageSquare,
  Users,
  Zap,
  Activity,
  ShieldCheck,
  Plug,
  Store,
  Settings,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../context/ChatContext';
import type { Conversation, Screen } from '../../types/chat';

interface NavItem {
  id: Screen;
  label: string;
  icon: typeof MessageSquare;
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'experts', label: 'Experts', icon: Users },
  { id: 'routines', label: 'Routines', icon: Zap },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'marketplace', label: 'Marketplace', icon: Store },
];

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
  const {
    conversations,
    activeConversationId,
    activeScreen,
    createConversation,
    setActiveConversation,
    setActiveScreen,
    deleteConversation,
  } = useChat();

  const [collapsed, setCollapsed] = useState(false);
  const [hoveredConvId, setHoveredConvId] = useState<string | null>(null);
  const grouped = useMemo(() => groupByTime(conversations), [conversations]);

  const handleNewChat = () => {
    setActiveScreen('chat');
    createConversation();
  };

  const handleNavClick = (screen: Screen) => {
    setActiveScreen(screen);
    if (screen !== 'chat') {
      setActiveConversation(null);
    }
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    deleteConversation(id);
  };

  return (
    <div
      className={clsx(
        'flex-shrink-0 flex flex-col bg-bg-surface border-r border-border-subtle h-full',
        'transition-all duration-200 ease-in-out',
        collapsed ? 'w-[56px]' : 'w-[260px]',
      )}
    >
      {/* Collapse toggle */}
      <div className={clsx('flex items-center p-2', collapsed ? 'justify-center' : 'justify-end')}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'flex items-center justify-center rounded-lg p-1.5',
            'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
            'transition-colors duration-150 cursor-pointer',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      {/* New chat button */}
      <div className={clsx('px-2', collapsed ? 'mb-2' : 'mb-1')}>
        <button
          onClick={handleNewChat}
          className={clsx(
            'flex items-center rounded-lg',
            'text-sm font-medium text-text-primary',
            'bg-accent/10 hover:bg-accent/20',
            'border border-accent/20',
            'transition-colors duration-150 cursor-pointer',
            collapsed ? 'justify-center p-2 w-full' : 'gap-2 px-3 py-2.5 w-full',
          )}
          title="New Chat"
        >
          <Plus size={16} className="text-accent flex-shrink-0" />
          {!collapsed && 'New Chat'}
        </button>
      </div>

      {/* Navigation items */}
      <nav className="px-2 py-1 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const isActive = activeScreen === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              className={clsx(
                'w-full flex items-center rounded-lg',
                'transition-colors duration-150 cursor-pointer',
                collapsed ? 'justify-center p-2' : 'gap-2.5 px-3 py-2',
                isActive
                  ? 'bg-accent-muted text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={16} className="flex-shrink-0" />
              {!collapsed && <span className="text-sm">{item.label}</span>}
              {!collapsed && item.badge != null && item.badge > 0 && (
                <span className="ml-auto text-[10px] font-medium bg-accent/20 text-accent px-1.5 py-0.5 rounded-full">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Separator */}
      <div className="mx-3 my-2 border-t border-border-subtle" />

      {/* Conversation list (only shown when on chat screen and not collapsed) */}
      {activeScreen === 'chat' && !collapsed && (
        <div className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
          {grouped.length === 0 && (
            <div className="px-3 py-4 text-xs text-text-tertiary text-center">
              No conversations yet
            </div>
          )}
          {grouped.map((group) => (
            <div key={group.label} className="mb-2">
              <div className="px-2 py-1.5 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
                {group.label}
              </div>
              {group.conversations.map((conv) => {
                const isActive = conv.id === activeConversationId;
                const isHovered = conv.id === hoveredConvId;
                return (
                  <div
                    key={conv.id}
                    className="relative"
                    onMouseEnter={() => setHoveredConvId(conv.id)}
                    onMouseLeave={() => setHoveredConvId(null)}
                  >
                    <button
                      onClick={() => setActiveConversation(conv.id)}
                      className={clsx(
                        'w-full text-left px-3 py-2 rounded-lg text-sm truncate pr-8',
                        'transition-colors duration-150 cursor-pointer',
                        isActive
                          ? 'bg-accent-muted text-text-primary border-l-2 border-accent'
                          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                      )}
                    >
                      {conv.title}
                    </button>
                    {isHovered && (
                      <button
                        onClick={(e) => handleDelete(e, conv.id)}
                        className={clsx(
                          'absolute right-1.5 top-1/2 -translate-y-1/2',
                          'p-1 rounded-md',
                          'text-text-tertiary hover:text-red-400 hover:bg-red-400/10',
                          'transition-colors duration-150 cursor-pointer',
                        )}
                        title="Delete conversation"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Chat list spacer when collapsed or on other screen */}
      {(activeScreen !== 'chat' || collapsed) && <div className="flex-1" />}

      {/* Settings */}
      <div className="p-2 border-t border-border-subtle">
        <button
          onClick={() => handleNavClick('settings')}
          className={clsx(
            'w-full flex items-center rounded-lg',
            'transition-colors duration-150 cursor-pointer',
            collapsed ? 'justify-center p-2' : 'gap-2.5 px-3 py-2',
            activeScreen === 'settings'
              ? 'bg-accent-muted text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
          title={collapsed ? 'Settings' : undefined}
        >
          <Settings size={16} className="flex-shrink-0" />
          {!collapsed && <span className="text-sm">Settings</span>}
        </button>
      </div>
    </div>
  );
}
