import type { ComponentType } from 'react';
import clsx from 'clsx';
import {
  GoogleCalendarIcon,
  GmailIcon,
  NotionIcon,
  SlackIcon,
} from '../../icons/BrandIcons';

interface Service {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  color: string;
  textColor: string;
}

const SERVICES: Service[] = [
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Calendar events and scheduling',
    icon: GoogleCalendarIcon,
    color: 'bg-blue-500/15',
    textColor: 'text-blue-400',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read and send emails',
    icon: GmailIcon,
    color: 'bg-red-500/15',
    textColor: 'text-red-400',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases, and knowledge base',
    icon: NotionIcon,
    color: 'bg-white/10',
    textColor: 'text-white/80',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Team messaging and notifications',
    icon: SlackIcon,
    color: 'bg-purple-500/15',
    textColor: 'text-purple-400',
  },
];

function ServiceCard({ service }: { service: Service }) {
  const Icon = service.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-3.5 bg-bg-surface border border-border-subtle rounded-lg">
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          service.color,
          service.textColor,
        )}
      >
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{service.name}</div>
        <div className="text-xs text-text-tertiary">{service.description}</div>
      </div>
      <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-2 py-1 rounded-full border border-border-subtle flex-shrink-0">
        Coming Soon
      </span>
    </div>
  );
}

export default function ConnectedAppsSection() {
  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">Connected Apps</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        Connect external services so Cerebro can read and write on your behalf.
      </p>

      <div className="mt-6 space-y-2">
        {SERVICES.map((service) => (
          <ServiceCard key={service.id} service={service} />
        ))}
      </div>
    </div>
  );
}
