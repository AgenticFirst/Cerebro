import { useCallback, useEffect, useState, type ComponentType } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  GHLIcon,
  GitHubIcon,
  SupabaseIcon,
  GoogleCalendarIcon,
  GmailIcon,
  HubSpotIcon,
  N8nIcon,
  NotionIcon,
} from '../../icons/BrandIcons';
import { Plug } from 'lucide-react';
import IntegrationCard from './IntegrationCard';
import HubSpotSection from './HubSpotSection';
import HubSpotConnectModal from './HubSpotConnectModal';
import CalendarSection from './CalendarSection';
import GmailSection from './GmailSection';
import MCPServersSection from './MCPServersSection';
import GHLSection from './GHLSection';
import GitHubSection from './GitHubSection';
import N8nSection from './N8nSection';
import SupabaseSyncSection from './SupabaseSyncSection';
import type { HubSpotStatusResponse } from '../../../types/ipc';

interface Service {
  id: string;
  nameKey: string;
  descKey: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  color: string;
  textColor: string;
}

const COMING_SOON_SERVICES: Service[] = [
  {
    id: 'notion',
    nameKey: 'connectedApps.notion',
    descKey: 'connectedApps.notionDesc',
    icon: NotionIcon,
    color: 'bg-white/10',
    textColor: 'text-white/80',
  },
];

function ComingSoonCard({ service }: { service: Service }) {
  const { t } = useTranslation();
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
        <div className="text-sm font-medium text-text-primary">{t(service.nameKey)}</div>
        <div className="text-xs text-text-secondary">{t(service.descKey)}</div>
      </div>
      <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-2 py-1 rounded-full border border-border-subtle flex-shrink-0">
        {t('common.comingSoon')}
      </span>
    </div>
  );
}

export default function ConnectedAppsSection() {
  const { t } = useTranslation();
  const [hubSpotStatus, setHubSpotStatus] = useState<HubSpotStatusResponse | null>(null);
  const [showHubSpotTour, setShowHubSpotTour] = useState(false);
  // Bumping this remounts HubSpotSection so it reloads after the tour saves.
  const [reloadKey, setReloadKey] = useState(0);

  const refreshHubSpot = useCallback(async () => {
    const s = await window.cerebro.hubspot.status();
    setHubSpotStatus((prev) =>
      prev &&
      prev.hasToken === s.hasToken &&
      prev.portalId === s.portalId &&
      prev.defaultPipeline === s.defaultPipeline &&
      prev.defaultStage === s.defaultStage &&
      prev.tokenBackend === s.tokenBackend
        ? prev
        : s,
    );
  }, []);

  useEffect(() => {
    void refreshHubSpot();
    const id = setInterval(refreshHubSpot, 10_000);
    return () => clearInterval(id);
  }, [refreshHubSpot]);

  const hubSpotStatusPill = hubSpotStatus?.hasToken ? (
    <span className="text-[10px] font-medium px-2 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
      Connected
    </span>
  ) : null;

  const hubSpotDescription =
    hubSpotStatus?.hasToken && hubSpotStatus.portalId
      ? `Connected to portal ${hubSpotStatus.portalId}.`
      : 'Open support tickets and update contacts in HubSpot from a routine.';

  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">{t('connectedApps.title')}</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        {t('connectedApps.description')}
      </p>

      <div className="mt-6 space-y-2">
        <IntegrationCard
          icon={GitHubIcon}
          iconBg="bg-zinc-500/15"
          iconColor="text-text-primary"
          name="GitHub"
          description={t('connectedApps.githubDesc')}
          defaultExpanded={false}
        >
          <GitHubSection />
        </IntegrationCard>

        <IntegrationCard
          icon={HubSpotIcon}
          iconBg="bg-orange-500/15"
          iconColor="text-orange-400"
          name="HubSpot CRM"
          description={hubSpotDescription}
          status={hubSpotStatusPill}
          primaryAction={{
            label: hubSpotStatus?.hasToken ? 'Setup tour' : 'Connect',
            onClick: () => setShowHubSpotTour(true),
          }}
        >
          <HubSpotSection key={reloadKey} />
        </IntegrationCard>

        <IntegrationCard
          icon={GoogleCalendarIcon}
          iconBg="bg-blue-500/15"
          iconColor="text-blue-400"
          name={t('calendar.title')}
          description={t('calendar.section.description')}
          defaultExpanded={false}
        >
          <CalendarSection />
        </IntegrationCard>

        <IntegrationCard
          icon={GmailIcon}
          iconBg="bg-red-500/15"
          iconColor="text-red-400"
          name="Gmail"
          description={t('gmail.section.cardDescription')}
          defaultExpanded={false}
        >
          <GmailSection />
        </IntegrationCard>

        <IntegrationCard
          icon={Plug}
          iconBg="bg-cyan-500/15"
          iconColor="text-cyan-400"
          name={t('mcp.section.title')}
          description={t('mcp.section.cardDescription')}
          defaultExpanded={false}
        >
          <MCPServersSection />
        </IntegrationCard>

        <IntegrationCard
          icon={GHLIcon}
          iconBg="bg-indigo-500/15"
          iconColor="text-indigo-400"
          name="GoHighLevel"
          description={t('connectedApps.ghlDesc')}
          defaultExpanded={false}
        >
          <GHLSection />
        </IntegrationCard>

        <IntegrationCard
          icon={N8nIcon}
          iconBg="bg-pink-500/15"
          iconColor="text-pink-400"
          name="n8n"
          description={t('connectedApps.n8nDesc')}
          defaultExpanded={false}
        >
          <N8nSection />
        </IntegrationCard>

        <IntegrationCard
          icon={SupabaseIcon}
          iconBg="bg-emerald-500/15"
          iconColor="text-emerald-400"
          name="Supabase"
          description={t('connectedApps.supabaseDesc')}
          defaultExpanded={false}
        >
          <SupabaseSyncSection />
        </IntegrationCard>
      </div>

      {showHubSpotTour && (
        <HubSpotConnectModal
          onClose={() => {
            setShowHubSpotTour(false);
            setReloadKey((k) => k + 1);
            void refreshHubSpot();
          }}
          onPersisted={() => {
            setReloadKey((k) => k + 1);
            void refreshHubSpot();
          }}
        />
      )}

      <div className="mt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-3">
          {t('common.comingSoon')}
        </div>
        <div className="space-y-2">
          {COMING_SOON_SERVICES.map((service) => (
            <ComingSoonCard key={service.id} service={service} />
          ))}
        </div>
      </div>
    </div>
  );
}
