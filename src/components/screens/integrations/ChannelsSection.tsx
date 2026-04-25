import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TelegramIcon, WhatsAppIcon } from '../../icons/BrandIcons';
import IntegrationCard from './IntegrationCard';
import TelegramSection from './TelegramSection';
import TelegramConnectModal from './TelegramConnectModal';
import WhatsAppSection from './WhatsAppSection';
import WhatsAppConnectModal from './WhatsAppConnectModal';
import type { TelegramStatusResponse, WhatsAppStatusResponse } from '../../../types/ipc';

interface ComingSoonChannel {
  id: string;
  nameKey: string;
  descKey: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconBg: string;
  iconColor: string;
}

const COMING_SOON_CHANNELS: ComingSoonChannel[] = [
  {
    id: 'email',
    nameKey: 'channelsSection.email',
    descKey: 'channelsSection.emailDesc',
    icon: Mail,
    iconBg: 'bg-amber-500/15',
    iconColor: 'text-amber-400',
  },
];

export default function ChannelsSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TelegramStatusResponse | null>(null);
  const [waStatus, setWaStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showWaConnectModal, setShowWaConnectModal] = useState(false);
  // Bumping this remounts the TelegramSection so it reloads from settings
  // after the onboarding modal persists changes.
  const [reloadKey, setReloadKey] = useState(0);
  // Independent counter so the WhatsApp inline card remounts after its tour
  // persists an allowlist or pairs a new device.
  const [waReloadKey, setWaReloadKey] = useState(0);

  const refreshStatus = useCallback(async () => {
    const s = await window.cerebro.telegram.status();
    setStatus(s);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = setInterval(refreshStatus, 5_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    void (async () => {
      const s = await window.cerebro.whatsapp.status();
      setWaStatus(s);
    })();
    const off = window.cerebro.whatsapp.onStatusChanged((s) => setWaStatus(s));
    return off;
  }, []);

  const tokenConfigured = Boolean(status?.hasToken);

  const telegramStatusPill = (() => {
    if (!status) return null;
    if (status.running) {
      return (
        <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          {t('telegramSection.statusRunning')}
        </span>
      );
    }
    if (tokenConfigured) {
      return (
        <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-border-subtle bg-bg-elevated text-text-tertiary">
          {t('channelsSection.statusConfigured')}
        </span>
      );
    }
    return null;
  })();

  const telegramDescription = (() => {
    if (status?.botUsername && tokenConfigured) {
      return t('channelsSection.telegramDescConnected', { username: status.botUsername });
    }
    return t('channelsSection.telegramDesc');
  })();

  return (
    <div className="pb-12">
      <h2 className="text-lg font-medium text-text-primary">{t('channelsSection.title')}</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        {t('channelsSection.description')}
      </p>

      <div className="mt-6 space-y-2">
        <IntegrationCard
          icon={TelegramIcon}
          iconBg="bg-sky-500/15"
          iconColor="text-sky-400"
          name={t('channelsSection.telegram')}
          description={telegramDescription}
          status={telegramStatusPill}
          primaryAction={{
            label: tokenConfigured ? t('channelsSection.setupTour') : t('channelsSection.connect'),
            onClick: () => setShowConnectModal(true),
          }}
        >
          <TelegramSection key={reloadKey} />
        </IntegrationCard>

        <IntegrationCard
          icon={WhatsAppIcon}
          iconBg="bg-emerald-500/15"
          iconColor="text-emerald-400"
          name={t('whatsappSection.title')}
          description={
            waStatus?.state === 'connected' && waStatus.phoneNumber
              ? t('channelsSection.whatsappDescConnected', { phone: waStatus.phoneNumber })
              : t('channelsSection.whatsappDesc')
          }
          status={waStatus?.state === 'connected' ? (
            <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              {t('whatsappSection.statePillConnected')}
            </span>
          ) : waStatus?.state === 'pairing' ? (
            <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400">
              {t('whatsappSection.statePillPairing')}
            </span>
          ) : null}
          primaryAction={{
            label: waStatus?.state === 'connected'
              ? t('channelsSection.setupTour')
              : t('channelsSection.connect'),
            onClick: () => setShowWaConnectModal(true),
          }}
        >
          <WhatsAppSection key={waReloadKey} />
        </IntegrationCard>

        {COMING_SOON_CHANNELS.map((c) => (
          <IntegrationCard
            key={c.id}
            icon={c.icon}
            iconBg={c.iconBg}
            iconColor={c.iconColor}
            name={t(c.nameKey)}
            description={t(c.descKey)}
            comingSoon
            status={
              <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-2 py-1 rounded-full border border-border-subtle">
                {t('common.comingSoon')}
              </span>
            }
          />
        ))}
      </div>

      {showConnectModal && (
        <TelegramConnectModal
          onClose={() => { setShowConnectModal(false); setReloadKey((k) => k + 1); void refreshStatus(); }}
          onPersisted={() => { setReloadKey((k) => k + 1); void refreshStatus(); }}
        />
      )}

      {showWaConnectModal && (
        <WhatsAppConnectModal
          onClose={() => {
            setShowWaConnectModal(false);
            setWaReloadKey((k) => k + 1);
            void (async () => {
              const s = await window.cerebro.whatsapp.status();
              setWaStatus(s);
            })();
          }}
          onPersisted={() => {
            setWaReloadKey((k) => k + 1);
            void (async () => {
              const s = await window.cerebro.whatsapp.status();
              setWaStatus(s);
            })();
          }}
        />
      )}
    </div>
  );
}
