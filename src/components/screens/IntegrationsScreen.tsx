import { useState } from 'react';
import { Cpu, Puzzle, MessageSquare, Wifi, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import EngineSection from './integrations/EngineSection';
import ConnectedAppsSection from './integrations/ConnectedAppsSection';
import ChannelsSection from './integrations/ChannelsSection';
import EmptySection from './integrations/EmptySection';

type Section = 'engine' | 'connected-apps' | 'channels' | 'remote-access';

const SECTION_KEYS: Record<Section, string> = {
  'engine': 'integrations.engine',
  'connected-apps': 'integrations.connectedApps',
  'channels': 'integrations.channels',
  'remote-access': 'integrations.remoteAccess',
};

interface SectionNavItem {
  id: Section;
  icon: LucideIcon;
}

const SECTIONS: SectionNavItem[] = [
  { id: 'engine', icon: Cpu },
  { id: 'connected-apps', icon: Puzzle },
  { id: 'channels', icon: MessageSquare },
  { id: 'remote-access', icon: Wifi },
];

export default function IntegrationsScreen() {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<Section>('engine');

  return (
    <div className="flex h-full">
      {/* Inner sidebar */}
      <div className="w-48 flex-shrink-0 border-r border-white/[0.06] py-4 px-2.5">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-tertiary px-2.5 mb-3 select-none">
          {t('integrations.title')}
        </div>
        <div className="space-y-px">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                data-tour-id={section.id === 'connected-apps' ? 'integrations-apps' : undefined}
                className={clsx(
                  'group relative w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-md',
                  'transition-all duration-150 cursor-pointer',
                  isActive
                    ? 'nav-item-active text-text-primary font-medium'
                    : 'text-text-secondary hover:text-text-primary hover:bg-white/[0.04]',
                )}
              >
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
                <span className="text-[13px] leading-none">{t(SECTION_KEYS[section.id])}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content pane */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-2xl px-8 py-8">
          {activeSection === 'engine' && <EngineSection />}
          {activeSection === 'connected-apps' && <ConnectedAppsSection />}
          {activeSection === 'channels' && <ChannelsSection />}
          {activeSection === 'remote-access' && (
            <EmptySection
              sectionTitle={t('integrations.remoteAccess')}
              sectionDescription={t('integrations.remoteAccessDescription')}
              icon={Wifi}
              comingSoonText={t('integrations.remoteAccessComingSoon')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
