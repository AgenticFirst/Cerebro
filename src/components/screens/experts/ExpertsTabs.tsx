import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { MessageSquare, Network } from 'lucide-react';
import { useExperts } from '../../../context/ExpertContext';
import HierarchyView from './HierarchyView';
import MessagesTab from './messages/MessagesTab';

const TABS = [
  { id: 'messages' as const, labelKey: 'experts.tabMessages', icon: MessageSquare },
  { id: 'hierarchy' as const, labelKey: 'experts.tabHierarchy', icon: Network },
];

export default function ExpertsTabs() {
  const { t } = useTranslation();
  const { lastExpertsTab, setLastExpertsTab } = useExperts();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-4 pt-3 border-b border-border-subtle bg-bg-base">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = lastExpertsTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setLastExpertsTab(tab.id)}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium',
                'border-b-2 -mb-px transition-colors duration-150 cursor-pointer',
                isActive
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary',
              )}
            >
              <Icon size={14} strokeWidth={isActive ? 2 : 1.5} />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>
      <div className="flex-1 flex overflow-hidden">
        {lastExpertsTab === 'messages' ? <MessagesTab /> : <HierarchyView />}
      </div>
    </div>
  );
}
