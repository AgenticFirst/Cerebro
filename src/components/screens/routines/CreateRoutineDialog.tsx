import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Hand, Clock, Webhook } from 'lucide-react';
import { TelegramIcon } from '../../icons/BrandIcons';
import clsx from 'clsx';
import type { CreateRoutineInput, TriggerType } from '../../../types/routines';
import type { DayOfWeek } from '../../../utils/cron-helpers';
import { scheduleToCron, WEEKDAYS } from '../../../utils/cron-helpers';
import SchedulePicker from '../../ui/SchedulePicker';
import Tooltip from '../../ui/Tooltip';

interface CreateRoutineDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateRoutineInput) => Promise<boolean>;
}

export default function CreateRoutineDialog({
  isOpen,
  onClose,
  onCreate,
}: CreateRoutineDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<TriggerType>('manual');
  const [scheduleDays, setScheduleDays] = useState<DayOfWeek[]>([...WEEKDAYS]);
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setDescription('');
      setTriggerType('manual');
      setScheduleDays([...WEEKDAYS]);
      setScheduleTime('09:00');
      setTimeout(() => nameRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const canSubmit =
    name.trim() &&
    !isSubmitting &&
    (triggerType !== 'cron' || scheduleDays.length > 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const input: CreateRoutineInput = {
        name: name.trim(),
        description: description.trim(),
        triggerType,
      };
      if (triggerType === 'cron' && scheduleDays.length > 0) {
        input.cronExpression = scheduleToCron({ days: scheduleDays, time: scheduleTime });
      }
      const success = await onCreate(input);
      if (success) onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  const triggers: Array<{ type: TriggerType; icon: typeof Hand; label: string; desc: string; tipKey: string }> = [
    { type: 'manual', icon: Hand, label: t('triggers.manual'), desc: t('createRoutine.triggerManualDesc'), tipKey: 'routineTooltips.triggerManual' },
    { type: 'cron', icon: Clock, label: t('triggers.scheduled'), desc: t('createRoutine.triggerScheduledDesc'), tipKey: 'routineTooltips.triggerScheduled' },
    { type: 'webhook', icon: Webhook, label: t('triggers.webhook'), desc: t('createRoutine.triggerWebhookDesc'), tipKey: 'routineTooltips.triggerWebhook' },
    { type: 'telegram_message', icon: TelegramIcon as unknown as typeof Hand, label: t('triggers.telegramMessage'), desc: t('createRoutine.triggerTelegramDesc'), tipKey: 'routineTooltips.triggerTelegram' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-elevated rounded-xl border border-border-subtle p-6 w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-medium text-text-primary">{t('createRoutine.title')}</h3>
          <Tooltip label={t('routineTooltips.close')} shortcut="Esc">
            <button
              onClick={onClose}
              aria-label={t('routineTooltips.close')}
              className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('createRoutine.name')}
            </label>
            <Tooltip label={t('routineTooltips.nameField')}>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('createRoutine.namePlaceholder')}
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors"
              />
            </Tooltip>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('createRoutine.description')}{' '}
              <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
            </label>
            <Tooltip label={t('routineTooltips.descField')}>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('createRoutine.descPlaceholder')}
                rows={2}
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors resize-none"
              />
            </Tooltip>
          </div>

          {/* Trigger Type */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('createRoutine.trigger')}
            </label>
            <div className="flex gap-2">
              {triggers.map((trigger) => {
                const Icon = trigger.icon;
                return (
                  <Tooltip key={trigger.type} label={t(trigger.tipKey)}>
                    <button
                      type="button"
                      onClick={() => setTriggerType(trigger.type)}
                      className={clsx(
                        'flex-1 flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors border',
                        triggerType === trigger.type
                          ? 'bg-accent/10 border-accent/30 text-accent'
                          : 'bg-bg-surface border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
                      )}
                    >
                      <Icon size={15} />
                      {trigger.label}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          {/* Schedule Picker (conditional) */}
          {triggerType === 'cron' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t('createRoutine.schedule')}
              </label>
              <SchedulePicker
                days={scheduleDays}
                time={scheduleTime}
                onDaysChange={setScheduleDays}
                onTimeChange={setScheduleTime}
              />
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Tooltip label={t('routineTooltips.cancel')}>
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-1.5 text-sm text-text-secondary hover:text-text-primary rounded-lg hover:bg-bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
            </Tooltip>
            <Tooltip label={t('routineTooltips.create')}>
              <button
                type="submit"
                disabled={!canSubmit}
                className="px-3.5 py-1.5 text-sm font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isSubmitting ? t('common.creating') : t('createRoutine.createRoutine')}
              </button>
            </Tooltip>
          </div>
        </form>
      </div>
    </div>
  );
}
