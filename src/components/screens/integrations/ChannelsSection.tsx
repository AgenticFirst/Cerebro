import type { ComponentType } from 'react';
import { Mail } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { WhatsAppIcon } from '../../icons/BrandIcons';
import TelegramSection from './TelegramSection';

interface Channel {
  id: string;
  nameKey: string;
  descKey: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  color: string;
  textColor: string;
}

// Channels that are shipped live are rendered with their own section above.
// Everything in this list is still "Coming Soon".
const PENDING_CHANNELS: Channel[] = [
  {
    id: 'whatsapp',
    nameKey: 'channelsSection.whatsapp',
    descKey: 'channelsSection.whatsappDesc',
    icon: WhatsAppIcon,
    color: 'bg-emerald-500/15',
    textColor: 'text-emerald-400',
  },
  {
    id: 'email',
    nameKey: 'channelsSection.email',
    descKey: 'channelsSection.emailDesc',
    icon: Mail,
    color: 'bg-amber-500/15',
    textColor: 'text-amber-400',
  },
];

function ChannelCard({ channel }: { channel: Channel }) {
  const { t } = useTranslation();
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
        <div className="text-sm font-medium text-text-primary">{t(channel.nameKey)}</div>
        <div className="text-xs text-text-secondary">{t(channel.descKey)}</div>
      </div>
      <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-2 py-1 rounded-full border border-border-subtle flex-shrink-0">
        {t('common.comingSoon')}
      </span>
    </div>
  );
}

export default function ChannelsSection() {
  const { t } = useTranslation();
  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">{t('channelsSection.title')}</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        {t('channelsSection.description')}
      </p>

      {/* Telegram — live. */}
      <div className="mt-6">
        <TelegramSection />
      </div>

      {/* Other channels — still "Coming Soon". */}
      <div className="mt-8 space-y-2">
        {PENDING_CHANNELS.map((channel) => (
          <ChannelCard key={channel.id} channel={channel} />
        ))}
      </div>
    </div>
  );
}
