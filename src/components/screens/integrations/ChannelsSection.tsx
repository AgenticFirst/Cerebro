import type { ComponentType } from 'react';
import { Mail } from 'lucide-react';
import clsx from 'clsx';
import { TelegramIcon, WhatsAppIcon } from '../../icons/BrandIcons';

interface Channel {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  color: string;
  textColor: string;
}

const CHANNELS: Channel[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Message Cerebro via Telegram bot',
    icon: TelegramIcon,
    color: 'bg-sky-500/15',
    textColor: 'text-sky-400',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Chat with Cerebro on WhatsApp',
    icon: WhatsAppIcon,
    color: 'bg-emerald-500/15',
    textColor: 'text-emerald-400',
  },
  {
    id: 'email',
    name: 'Email',
    description: 'Interact with Cerebro via email',
    icon: Mail,
    color: 'bg-amber-500/15',
    textColor: 'text-amber-400',
  },
];

function ChannelCard({ channel }: { channel: Channel }) {
  const Icon = channel.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-3.5 bg-bg-surface border border-border-subtle rounded-lg">
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          channel.color,
          channel.textColor,
        )}
      >
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{channel.name}</div>
        <div className="text-xs text-text-tertiary">{channel.description}</div>
      </div>
      <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-2 py-1 rounded-full border border-border-subtle flex-shrink-0">
        Coming Soon
      </span>
    </div>
  );
}

export default function ChannelsSection() {
  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">Channels</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        Connect messaging platforms to interact with Cerebro remotely.
      </p>

      <div className="mt-6 space-y-2">
        {CHANNELS.map((channel) => (
          <ChannelCard key={channel.id} channel={channel} />
        ))}
      </div>
    </div>
  );
}
