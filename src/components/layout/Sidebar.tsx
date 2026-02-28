import { useMemo, useState, type ReactNode } from 'react';
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
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { useChat } from '../../context/ChatContext';
import type { Conversation, Screen } from '../../types/chat';

/* ── Nav structure: grouped by function ───────────────────────── */

interface NavItem {
  id: Screen;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

// Primary — daily-use surfaces
const NAV_PRIMARY: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'experts', label: 'Experts', icon: Users },
  { id: 'routines', label: 'Routines', icon: Zap },
];

// Oversight — monitoring & control
const NAV_OVERSIGHT: NavItem[] = [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
];

// Extensions — setup & expand
const NAV_EXTENSIONS: NavItem[] = [
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'marketplace', label: 'Marketplace', icon: Store },
];

/* ── NavButton ────────────────────────────────────────────────── */

function NavButton({
  item,
  isActive,
  collapsed,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;

  return (
    <button
      onClick={onClick}
      className={clsx(
        'group relative w-full flex items-center rounded-md',
        'transition-all duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] cursor-pointer',
        collapsed ? 'justify-center p-2' : 'gap-2.5 px-2.5 py-[7px]',
        isActive
          ? 'nav-item-active text-text-primary font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]',
      )}
      title={collapsed ? item.label : undefined}
    >
      {/* Icon container */}
      <div
        className={clsx(
          'flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0',
          'transition-all duration-150',
          isActive
            ? 'bg-accent/15 text-accent'
            : 'text-text-tertiary group-hover:text-text-secondary',
        )}
      >
        <Icon size={14} strokeWidth={isActive ? 2 : 1.5} />
      </div>

      {!collapsed && <span className="text-[13px] leading-none">{item.label}</span>}

      {/* Badge */}
      {!collapsed && item.badge != null && item.badge > 0 && (
        <span className="ml-auto text-[10px] font-semibold bg-accent/15 text-accent px-1.5 py-0.5 rounded-full tabular-nums">
          {item.badge}
        </span>
      )}
    </button>
  );
}

/* ── NavGroup ─────────────────────────────────────────────────── */

function NavGroup({
  items,
  activeScreen,
  collapsed,
  onNavClick,
}: {
  items: NavItem[];
  activeScreen: Screen;
  collapsed: boolean;
  onNavClick: (screen: Screen) => void;
}) {
  return (
    <div className="space-y-px">
      {items.map((item) => (
        <NavButton
          key={item.id}
          item={item}
          isActive={activeScreen === item.id}
          collapsed={collapsed}
          onClick={() => onNavClick(item.id)}
        />
      ))}
    </div>
  );
}

/* ── Ghost separator ──────────────────────────────────────────── */

function GhostSeparator({ collapsed }: { collapsed: boolean }) {
  return (
    <div className={clsx('my-2', collapsed ? 'mx-2' : 'mx-3')}>
      <div className="border-t border-white/[0.04]" />
    </div>
  );
}

/* ── Conversation list ────────────────────────────────────────── */

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

/* ── Sidebar ──────────────────────────────────────────────────── */

export default function Sidebar() {
  const {
    conversations,
    activeConversationId,
    activeScreen,
    isLoading,
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
        'flex-shrink-0 flex flex-col bg-bg-surface h-full',
        'border-r border-white/[0.06]',
        'transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]',
        collapsed ? 'w-[56px]' : 'w-[260px]',
      )}
    >
      {/* ── Header: collapse toggle ──────────────────────────── */}
      <div
        className={clsx(
          'flex items-center h-11',
          collapsed ? 'justify-center px-2' : 'justify-between px-3',
        )}
      >
        {!collapsed && (
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary select-none">
            Cerebro
          </span>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={clsx(
            'flex items-center justify-center rounded-md p-1.5',
            'text-text-tertiary hover:text-text-secondary hover:bg-white/[0.04]',
            'transition-colors duration-150 cursor-pointer',
          )}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      {/* ── New chat button ──────────────────────────────────── */}
      <div className="px-2.5">
        <button
          onClick={handleNewChat}
          className={clsx(
            'flex items-center rounded-md',
            'text-[13px] font-medium text-text-primary',
            'bg-accent/10 hover:bg-accent/[0.18]',
            'border border-accent/20 hover:border-accent/30',
            'transition-all duration-150 cursor-pointer',
            collapsed ? 'justify-center p-2 w-full' : 'gap-2 px-2.5 py-2 w-full',
          )}
          title="New Chat"
        >
          <Plus size={15} className="text-accent flex-shrink-0" strokeWidth={2} />
          {!collapsed && 'New Chat'}
        </button>
      </div>

      <GhostSeparator collapsed={collapsed} />

      {/* ── Navigation ───────────────────────────────────────── */}
      <nav className="px-2.5">
        {/* Primary: Chat, Experts, Routines */}
        <NavGroup
          items={NAV_PRIMARY}
          activeScreen={activeScreen}
          collapsed={collapsed}
          onNavClick={handleNavClick}
        />

        <GhostSeparator collapsed={collapsed} />

        {/* Oversight: Activity, Approvals */}
        <NavGroup
          items={NAV_OVERSIGHT}
          activeScreen={activeScreen}
          collapsed={collapsed}
          onNavClick={handleNavClick}
        />

        <GhostSeparator collapsed={collapsed} />

        {/* Extensions: Integrations, Marketplace */}
        <NavGroup
          items={NAV_EXTENSIONS}
          activeScreen={activeScreen}
          collapsed={collapsed}
          onNavClick={handleNavClick}
        />
      </nav>

      {/* ── Conversation history (Chat screen, expanded only) ── */}
      {activeScreen === 'chat' && !collapsed ? (
        <>
          <GhostSeparator collapsed={collapsed} />
          <div className="flex-1 overflow-y-auto scrollbar-thin px-2.5 pb-2">
            {grouped.length === 0 && (
              <div className="px-3 py-6 text-[11px] text-text-tertiary text-center">
                {isLoading ? 'Loading...' : 'No conversations yet'}
              </div>
            )}
            {grouped.map((group) => (
              <div key={group.label} className="mb-1.5">
                <div className="px-2 pt-3 pb-1 text-[10px] font-semibold text-text-tertiary uppercase tracking-[0.08em] select-none">
                  {group.label}
                </div>
                <div className="space-y-px">
                  {group.conversations.map((conv) => {
                    const isActive = conv.id === activeConversationId;
                    const isHovered = conv.id === hoveredConvId;
                    return (
                      <div
                        key={conv.id}
                        className="relative group/conv"
                        onMouseEnter={() => setHoveredConvId(conv.id)}
                        onMouseLeave={() => setHoveredConvId(null)}
                      >
                        <button
                          onClick={() => setActiveConversation(conv.id)}
                          className={clsx(
                            'w-full text-left px-2.5 py-[6px] rounded-md text-[13px] truncate',
                            'transition-all duration-150 cursor-pointer',
                            isHovered ? 'pr-8' : '',
                            isActive
                              ? 'bg-white/[0.06] text-text-primary font-medium shadow-[inset_2px_0_0_0_var(--color-accent)]'
                              : 'text-text-secondary/80 hover:text-text-secondary hover:bg-white/[0.03]',
                          )}
                        >
                          {conv.title}
                        </button>
                        {isHovered && (
                          <button
                            onClick={(e) => handleDelete(e, conv.id)}
                            className={clsx(
                              'absolute right-1 top-1/2 -translate-y-1/2',
                              'p-1 rounded-md',
                              'text-text-tertiary hover:text-red-400 hover:bg-red-400/10',
                              'transition-colors duration-100 cursor-pointer',
                            )}
                            title="Delete conversation"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="flex-1" />
      )}

      {/* ── Settings (footer) ────────────────────────────────── */}
      <div className="px-2.5 py-2 border-t border-white/[0.04]">
        <NavButton
          item={{ id: 'settings', label: 'Settings', icon: Settings }}
          isActive={activeScreen === 'settings'}
          collapsed={collapsed}
          onClick={() => handleNavClick('settings')}
        />
      </div>
    </div>
  );
}
