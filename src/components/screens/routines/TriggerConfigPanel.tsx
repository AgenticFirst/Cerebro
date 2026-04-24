import { X, Zap, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Node } from '@xyflow/react';
import SchedulePicker from '../../ui/SchedulePicker';
import type { DayOfWeek } from '../../../utils/cron-helpers';
import { cronToSchedule, scheduleToCron, WEEKDAYS } from '../../../utils/cron-helpers';
import { TRIGGER_TEAL as TEAL } from '../../../utils/step-defaults';
import Tooltip from '../../ui/Tooltip';

interface TriggerConfigPanelProps {
  node: Node;
  onUpdate: (nodeId: string, partial: Record<string, unknown>) => void;
  onClose: () => void;
}

export default function TriggerConfigPanel({ node, onUpdate, onClose }: TriggerConfigPanelProps) {
  const { t } = useTranslation();
  const data = node.data as { triggerType: string; config: Record<string, unknown> };
  const triggerType = data.triggerType;
  const config = data.config ?? {};

  const updateConfig = (partial: Record<string, unknown>) => {
    onUpdate(node.id, {
      config: { ...config, ...partial },
    });
  };

  // Schedule state from cron
  const schedule = (() => {
    if (triggerType !== 'trigger_schedule') return null;
    const cron = config.cron_expression as string;
    if (!cron) return { days: WEEKDAYS as DayOfWeek[], time: '09:00' };
    return cronToSchedule(cron);
  })();

  return (
    <div className="absolute top-0 right-0 bottom-0 w-[380px] z-20 bg-bg-surface border-l border-border-subtle shadow-xl flex flex-col animate-slide-in-right overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
        <div
          className="w-6 h-6 rounded flex items-center justify-center"
          style={{ backgroundColor: `${TEAL}20` }}
        >
          <Zap size={14} style={{ color: TEAL }} />
        </div>
        <span className="text-sm font-semibold text-text-primary flex-1">
          Trigger Configuration
        </span>
        <Tooltip label={t('routineTooltips.closePanel')} shortcut="Esc">
          <button
            onClick={onClose}
            aria-label={t('routineTooltips.closePanel')}
            className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="p-4 space-y-5">
        {/* Trigger type display */}
        <div>
          <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
            Type
          </label>
          <div className="text-sm text-text-primary capitalize">
            {triggerType.replace('trigger_', '')}
          </div>
        </div>

        {/* Schedule config */}
        {triggerType === 'trigger_schedule' && schedule && (
          <div>
            <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              Schedule
              <Tooltip label={t('routineTooltips.triggerCronHint')}>
                <span className="cursor-help"><Info size={10} /></span>
              </Tooltip>
            </label>
            <SchedulePicker
              selectedDays={schedule.days}
              time={schedule.time}
              onDaysChange={(days) => {
                const cron = scheduleToCron({ days, time: schedule.time });
                updateConfig({ cron_expression: cron });
              }}
              onTimeChange={(time) => {
                const cron = scheduleToCron({ days: schedule.days, time });
                updateConfig({ cron_expression: cron });
              }}
            />
          </div>
        )}

        {/* Manual — nothing to configure */}
        {triggerType === 'trigger_manual' && (
          <div className="bg-bg-hover/50 rounded-lg p-3">
            <p className="text-xs text-text-tertiary">
              This routine will run when you click the "Run" button.
            </p>
          </div>
        )}

        {/* Webhook config */}
        {triggerType === 'trigger_webhook' && (
          <>
            <div>
              <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                Path
                <Tooltip label={t('routineTooltips.triggerWebhookUrl')}>
                  <span className="cursor-help"><Info size={10} /></span>
                </Tooltip>
              </label>
              <input
                type="text"
                value={(config.path as string) ?? ''}
                onChange={(e) => updateConfig({ path: e.target.value })}
                placeholder="/webhook/my-endpoint"
                className="w-full h-8 px-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
              />
            </div>
            <div>
              <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                Secret (optional)
                <Tooltip label={t('routineTooltips.triggerWebhookSecret')}>
                  <span className="cursor-help"><Info size={10} /></span>
                </Tooltip>
              </label>
              <input
                type="password"
                value={(config.secret as string) ?? ''}
                onChange={(e) => updateConfig({ secret: e.target.value })}
                placeholder="Auth token for verification"
                className="w-full h-8 px-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
              />
            </div>
          </>
        )}

        {/* App Event config */}
        {triggerType === 'trigger_app_event' && (
          <div className="bg-bg-hover/50 rounded-lg p-3">
            <p className="text-xs text-text-tertiary">
              App Event triggers are coming soon. Configure your app integrations in Connections first.
            </p>
          </div>
        )}

        {/* WhatsApp Message config */}
        {triggerType === 'trigger_whatsapp_message' && (
          <>
            <div>
              <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                Phone number
              </label>
              <input
                type="text"
                value={(config.phone_number as string) ?? ''}
                onChange={(e) => updateConfig({ phone_number: e.target.value })}
                placeholder="+14155552671  or  *"
                className="w-full h-8 px-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
              />
              <p className="mt-1 text-[10px] text-text-tertiary">
                Customer phone number in E.164 format, or <code>*</code> to match any number in the WhatsApp allowlist.
              </p>
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                Filter
              </label>
              <select
                value={(config.filter_type as string) ?? 'none'}
                onChange={(e) => updateConfig({ filter_type: e.target.value })}
                className="w-full h-8 px-2 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50"
              >
                <option value="none">No filter (any message)</option>
                <option value="keyword">Contains keyword</option>
                <option value="prefix">Starts with</option>
                <option value="regex">Matches regex</option>
              </select>
            </div>
            {((config.filter_type as string) ?? 'none') !== 'none' && (
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                  Filter Value
                </label>
                <input
                  type="text"
                  value={(config.filter_value as string) ?? ''}
                  onChange={(e) => updateConfig({ filter_value: e.target.value })}
                  placeholder={
                    (config.filter_type as string) === 'regex'
                      ? '^(hola|hi|hello)\\b'
                      : (config.filter_type as string) === 'prefix'
                        ? 'support:'
                        : 'help'
                  }
                  className="w-full h-8 px-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 font-mono"
                />
              </div>
            )}
            <p className="text-[10px] text-text-tertiary">
              Available variables in steps: <code>{'{{__trigger__.phone_number}}'}</code>, <code>{'{{__trigger__.message_text}}'}</code>,
              <code>{'{{__trigger__.customer_display_name}}'}</code>, <code>{'{{__trigger__.conversation_history}}'}</code>.
            </p>
          </>
        )}

        {/* Telegram Message config */}
        {triggerType === 'trigger_telegram_message' && (
          <>
            <div>
              <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                Chat ID
              </label>
              <input
                type="text"
                value={(config.chat_id as string) ?? ''}
                onChange={(e) => updateConfig({ chat_id: e.target.value })}
                placeholder="123456789  or  *"
                className="w-full h-8 px-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
              />
              <p className="mt-1 text-[10px] text-text-tertiary">
                Numeric Telegram chat id, or <code>*</code> to match any chat in the bot's allowlist.
              </p>
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                Filter
              </label>
              <select
                value={(config.filter_type as string) ?? 'none'}
                onChange={(e) => updateConfig({ filter_type: e.target.value })}
                className="w-full h-8 px-2 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary focus:outline-none focus:border-accent/50"
              >
                <option value="none">No filter (any message)</option>
                <option value="keyword">Contains keyword</option>
                <option value="prefix">Starts with</option>
                <option value="regex">Matches regex</option>
              </select>
            </div>
            {((config.filter_type as string) ?? 'none') !== 'none' && (
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
                  Filter Value
                </label>
                <input
                  type="text"
                  value={(config.filter_value as string) ?? ''}
                  onChange={(e) => updateConfig({ filter_value: e.target.value })}
                  placeholder={
                    (config.filter_type as string) === 'regex'
                      ? '^standup\\b'
                      : (config.filter_type as string) === 'prefix'
                        ? '/run '
                        : 'standup'
                  }
                  className="w-full h-8 px-3 text-xs bg-bg-base border border-border-subtle rounded-md text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 font-mono"
                />
                <p className="mt-1 text-[10px] text-text-tertiary">
                  Matching messages are consumed by this routine — the AI agent will not also reply.
                  Available variables in steps: <code>{'{{chat_id}}'}</code>, <code>{'{{message_text}}'}</code>,
                  <code>{'{{sender_username}}'}</code>, <code>{'{{sender_id}}'}</code>.
                </p>
              </div>
            )}
            {((config.filter_type as string) ?? 'none') === 'none' && (
              <p className="text-[10px] text-text-tertiary">
                Available variables in steps: <code>{'{{chat_id}}'}</code>, <code>{'{{message_text}}'}</code>,
                <code>{'{{sender_username}}'}</code>, <code>{'{{sender_id}}'}</code>.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
