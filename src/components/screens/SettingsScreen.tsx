import { useEffect, useMemo, useState } from 'react';
import { Brain, Palette, Info, Shield, FlaskConical, Mic, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import MemorySection from './settings/MemorySection';
import AppearanceSection from './settings/AppearanceSection';
import SandboxSection from './settings/SandboxSection';
import BetaFeaturesSection from './settings/BetaFeaturesSection';
import VoiceSection from './settings/VoiceSection';
import { consumePendingSettingsSection } from './settings/pending-section';
import { useFeatureFlags } from '../../context/FeatureFlagsContext';

type Section = 'memory' | 'sandbox' | 'voice' | 'appearance' | 'beta' | 'about';

interface SectionNavItem {
  id: Section;
  icon: LucideIcon;
}

const SECTIONS: SectionNavItem[] = [
  { id: 'memory', icon: Brain },
  { id: 'sandbox', icon: Shield },
  { id: 'voice', icon: Mic },
  { id: 'appearance', icon: Palette },
  { id: 'beta', icon: FlaskConical },
  { id: 'about', icon: Info },
];

export default function SettingsScreen() {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();

  // Voice is hidden from the sidebar AND from direct routing when the
  // beta flag is off — the master switch lives in Settings → Beta.
  const visibleSections = useMemo(
    () => SECTIONS.filter((s) => (s.id === 'voice' ? flags['voice-calls'] : true)),
    [flags],
  );

  const [activeSection, setActiveSection] = useState<Section>(() => {
    const pending = consumePendingSettingsSection();
    if (pending === 'voice' && !flags['voice-calls']) {
      // A caller (e.g. Phone-button click) asked us to land on Voice but
      // the flag is off — that should never happen because the gating in
      // VoiceContext also checks the flag, but be defensive: fall back to
      // Beta so the user can flip the flag and try again.
      return 'beta';
    }
    return pending ?? 'memory';
  });

  // If the user disables the flag while Voice is the active section,
  // bounce them back to Memory so they don't see a dangling pane.
  useEffect(() => {
    if (activeSection === 'voice' && !flags['voice-calls']) {
      setActiveSection('memory');
    }
  }, [activeSection, flags]);

  return (
    <div className="flex h-full">
      {/* Inner sidebar */}
      <div className="w-48 flex-shrink-0 border-r border-white/[0.06] py-4 px-2.5">
        <div className="text-xs font-semibold uppercase tracking-[0.08em] text-text-tertiary px-2.5 mb-3 select-none">
          {t('settings.title')}
        </div>
        <div className="space-y-px">
          {visibleSections.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
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
                <span className="text-[13px] leading-none">{t(`settings.${section.id}`)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content pane */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className={clsx(
          'px-8 py-8',
          activeSection === 'memory'
            ? 'max-w-5xl h-full flex flex-col'
            : activeSection === 'sandbox'
              ? 'max-w-3xl'
              : 'max-w-2xl',
        )}>
          {activeSection === 'memory' && <MemorySection />}
          {activeSection === 'sandbox' && <SandboxSection />}
          {activeSection === 'voice' && <VoiceSection />}
          {activeSection === 'appearance' && <AppearanceSection />}
          {activeSection === 'beta' && <BetaFeaturesSection />}
          {activeSection === 'about' && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Info size={32} className="text-text-tertiary mb-3" />
              <p className="text-sm text-text-tertiary">{t('settings.aboutComingSoon')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
