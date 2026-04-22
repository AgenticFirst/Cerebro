import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Zap } from 'lucide-react';
import clsx from 'clsx';
import { describeCron } from '../../../utils/cron-helpers';
import { HANDLE_COLORS } from '../../../utils/handle-types';
import { TRIGGER_TEAL as TEAL } from '../../../utils/step-defaults';
import Tooltip, { TooltipCard } from '../../ui/Tooltip';

interface TriggerData {
  triggerType: string;
  config: Record<string, unknown>;
}

function TriggerNode({ data, selected }: NodeProps) {
  const { t } = useTranslation();
  const d = data as TriggerData;
  const type = d.triggerType;

  const label = (() => {
    switch (type) {
      case 'trigger_schedule': return t('triggers.scheduleTrigger');
      case 'trigger_manual': return t('triggers.manualTrigger');
      case 'trigger_webhook': return t('triggers.webhookTrigger');
      case 'trigger_telegram_message': return t('triggers.telegramMessageTrigger');
      case 'trigger_app_event': return t('triggers.appEventTrigger');
      default: return t('triggers.trigger');
    }
  })();

  const detail = (() => {
    switch (type) {
      case 'trigger_schedule': {
        const cron = d.config.cron_expression as string;
        return cron ? describeCron(cron) : t('triggers.noScheduleSet');
      }
      case 'trigger_manual':
        return t('triggers.clickRunToExecute');
      case 'trigger_webhook': {
        const path = (d.config.path as string) || '/webhook/...';
        return `POST ${path}`;
      }
      case 'trigger_telegram_message': {
        const chat = (d.config.chat_id as string) || '';
        if (!chat) return t('triggers.notConfigured');
        const filterType = (d.config.filter_type as string) || 'none';
        const filterValue = ((d.config.filter_value as string) || '').trim();
        const target = chat === '*' ? 'any allowlisted chat' : chat;
        return filterType !== 'none' && filterValue
          ? `${target} · ${filterType}: ${filterValue}`
          : target;
      }
      case 'trigger_app_event': {
        const app = (d.config.app as string) || '';
        const event = (d.config.event as string) || '';
        return app ? `${app}: ${event}` : t('triggers.notConfigured');
      }
      default:
        return '';
    }
  })();

  const hoverCard = useMemo(
    () => (
      <TooltipCard
        title={label}
        description={detail}
        hint={t('routineTooltips.triggerNodeHint')}
      />
    ),
    [label, detail, t],
  );

  return (
    <Tooltip label={hoverCard} size="md" side="top" delay={500}>
      <div
        className={clsx(
          'w-[260px] rounded-lg border bg-teal-500/5 transition-all duration-150',
          selected
            ? 'shadow-lg'
            : 'border-border-subtle hover:border-border-default',
        )}
        style={{
          borderLeftWidth: 4,
          borderLeftColor: TEAL,
          // Set the non-left borders via individual longhand properties to
          // avoid mixing the `borderColor` shorthand with `borderLeftColor`
          // (React warns about shorthand/non-shorthand conflicts on re-render).
          ...(selected
            ? {
                borderTopColor: TEAL,
                borderRightColor: TEAL,
                borderBottomColor: TEAL,
                boxShadow: `0 0 12px ${TEAL}40`,
              }
            : {}),
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
          <div
            className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${TEAL}20` }}
          >
            <Zap size={12} style={{ color: TEAL }} />
          </div>
          <span
            className="text-[10px] font-medium uppercase tracking-wider"
            style={{ color: TEAL }}
          >
            {label}
          </span>
        </div>

        {/* Detail */}
        <div className="px-3 pb-3">
          <span className="text-sm text-text-secondary block truncate">
            {detail}
          </span>
        </div>

        <Handle
          type="source"
          position={Position.Bottom}
          className="!border-bg-surface !w-2 !h-2"
          style={{ backgroundColor: HANDLE_COLORS.signal }}
          title={t('routineTooltips.nodeHandleSource')}
        />
      </div>
    </Tooltip>
  );
}

export default memo(TriggerNode);
