import { useTranslation } from 'react-i18next';
import type { ActionMeta } from '../../../utils/step-defaults';
import Tooltip, { TooltipCard } from '../../ui/Tooltip';

interface ActionSidebarItemProps {
  actionType: string;
  meta: ActionMeta;
}

export default function ActionSidebarItem({ actionType, meta }: ActionSidebarItemProps) {
  const { t } = useTranslation();
  const Icon = meta.icon;
  const disabled = !meta.isAvailable;

  const tooltipLabel = (
    <TooltipCard
      title={meta.name}
      description={meta.description}
      hint={
        disabled
          ? t('routineTooltips.actionComingSoon', { name: meta.name })
          : t('routineTooltips.actionDragHint')
      }
    />
  );

  return (
    <Tooltip label={tooltipLabel} size="md" side="left">
      <div
        draggable={!disabled}
        onDragStart={(e) => {
          if (disabled) return;
          e.dataTransfer.setData('application/cerebro-action-type', actionType);
          e.dataTransfer.effectAllowed = 'move';
        }}
        aria-label={meta.name}
        className={`flex items-center gap-2.5 px-3 py-2 rounded-md transition-colors ${
          disabled
            ? 'opacity-50 cursor-default'
            : 'cursor-grab active:cursor-grabbing hover:bg-bg-hover'
        }`}
      >
        <div
          className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: `${meta.colorHex}15` }}
        >
          <Icon size={14} style={{ color: meta.colorHex }} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-text-primary truncate">{meta.name}</div>
          <div className="text-[10px] text-text-tertiary truncate leading-tight">
            {meta.description}
          </div>
        </div>

        {disabled && (
          <span className="text-[9px] font-medium text-text-tertiary bg-bg-hover px-1.5 py-0.5 rounded flex-shrink-0">
            soon
          </span>
        )}
      </div>
    </Tooltip>
  );
}
