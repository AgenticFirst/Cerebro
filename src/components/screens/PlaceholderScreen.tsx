import {
  Users,
  Zap,
  Activity,
  ShieldCheck,
  Plug,
  Store,
  Settings,
} from 'lucide-react';
import type { Screen } from '../../types/chat';

const SCREEN_META: Record<string, { icon: typeof Users; title: string; description: string }> = {
  experts: {
    icon: Users,
    title: 'Experts',
    description: 'Specialized agents that handle tasks in specific domains. Cerebro routes your requests to the right expert.',
  },
  routines: {
    icon: Zap,
    title: 'Routines',
    description: 'Reusable, executable playbooks. Create them from chat or browse saved routines here.',
  },
  activity: {
    icon: Activity,
    title: 'Activity',
    description: 'Timeline of all runs — see logs, outputs, timestamps, and drill into any execution.',
  },
  approvals: {
    icon: ShieldCheck,
    title: 'Approvals',
    description: 'Review and approve or deny pending actions that require your sign-off before executing.',
  },
  integrations: {
    icon: Plug,
    title: 'Integrations',
    description: 'Set up API keys, connect accounts, configure model providers, and manage channels.',
  },
  marketplace: {
    icon: Store,
    title: 'Marketplace',
    description: 'Browse and install expert packs, action packs, and routine templates.',
  },
  settings: {
    icon: Settings,
    title: 'Settings',
    description: 'Memory, context files, preferences, and app configuration.',
  },
};

interface PlaceholderScreenProps {
  screen: Screen;
}

export default function PlaceholderScreen({ screen }: PlaceholderScreenProps) {
  const meta = SCREEN_META[screen];
  if (!meta) return null;

  const Icon = meta.icon;

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4">
      <div className="flex flex-col items-center max-w-md text-center">
        <div className="w-14 h-14 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mb-5">
          <Icon size={24} className="text-accent" />
        </div>
        <h1 className="text-2xl font-medium text-text-primary mb-2">
          {meta.title}
        </h1>
        <p className="text-sm text-text-secondary leading-relaxed mb-6">
          {meta.description}
        </p>
        <span className="text-xs text-text-tertiary bg-bg-elevated px-3 py-1.5 rounded-full border border-border-subtle">
          Coming soon
        </span>
      </div>
    </div>
  );
}
