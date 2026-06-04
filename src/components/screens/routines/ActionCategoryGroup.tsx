import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { ActionCategory, ActionMeta } from '../../../utils/step-defaults';
import ActionSidebarItem from './ActionSidebarItem';
import Tooltip from '../../ui/Tooltip';

interface ActionCategoryGroupProps {
  category: ActionCategory;
  actions: [string, ActionMeta][];
}

export default function ActionCategoryGroup({ category, actions }: ActionCategoryGroupProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);
  const Icon = category.icon;

  if (actions.length === 0) return null;

  return (
    <div>
      <Tooltip label={t('routineTooltips.categoryHeader', { name: category.name })} side="left">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-hover transition-colors"
        >
          <ChevronDown
            size={12}
            className={`text-text-tertiary transition-transform ${isExpanded ? '' : '-rotate-90'}`}
          />
          <Icon size={14} style={{ color: category.colorHex }} />
          <span className="text-[11px] font-semibold text-text-secondary tracking-wide">
            {category.name}
          </span>
          <span className="text-[10px] text-text-tertiary ml-auto">{actions.length}</span>
        </button>
      </Tooltip>

      {isExpanded && (
        <div className="pl-2 pr-1 pb-1">
          {actions.map(([type, meta]) => (
            <ActionSidebarItem key={type} actionType={type} meta={meta} />
          ))}
        </div>
      )}
    </div>
  );
}
