import { useState } from 'react';
import { Brain, Palette, Info, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import MemorySection from './settings/MemorySection';

type Section = 'memory' | 'appearance' | 'about';

interface SectionNavItem {
  id: Section;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: SectionNavItem[] = [
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

export default function SettingsScreen() {
  const [activeSection, setActiveSection] = useState<Section>('memory');

  return (
    <div className="flex h-full">
      {/* Inner sidebar */}
      <div className="w-48 flex-shrink-0 border-r border-white/[0.06] py-4 px-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary px-2.5 mb-3 select-none">
          Settings
        </div>
        <div className="space-y-px">
          {SECTIONS.map((section) => {
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
                <span className="text-[13px] leading-none">{section.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content pane */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-2xl px-8 py-8">
          {activeSection === 'memory' && <MemorySection />}
          {activeSection === 'appearance' && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Palette size={32} className="text-text-tertiary mb-3" />
              <p className="text-sm text-text-tertiary">Appearance settings coming soon</p>
            </div>
          )}
          {activeSection === 'about' && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Info size={32} className="text-text-tertiary mb-3" />
              <p className="text-sm text-text-tertiary">About Cerebro coming soon</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
