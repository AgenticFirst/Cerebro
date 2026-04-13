import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Hand, Clock, Webhook } from 'lucide-react';
import clsx from 'clsx';
import type { CreateRoutineInput, TriggerType } from '../../../types/routines';
import type { DayOfWeek } from '../../../utils/cron-helpers';
import { scheduleToCron, WEEKDAYS } from '../../../utils/cron-helpers';
import SchedulePicker from '../../ui/SchedulePicker';

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

  const triggers = useMemo<Array<{ type: TriggerType; icon: typeof Hand; label: string; desc: string }>>(() => [
    { type: 'manual', icon: Hand, label: t('triggers.manual'), desc: t('createRoutine.triggerManualDesc') },
    { type: 'cron', icon: Clock, label: t('triggers.scheduled'), desc: t('createRoutine.triggerScheduledDesc') },
    { type: 'webhook', icon: Webhook, label: t('triggers.webhook'), desc: t('createRoutine.triggerWebhookDesc') },
  ], [t]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-elevated rounded-xl border border-border-subtle p-6 w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-medium text-text-primary">{t('createRoutine.title')}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('createRoutine.name')}
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('createRoutine.namePlaceholder')}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('createRoutine.description')}{' '}
              <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('createRoutine.descPlaceholder')}
              rows={2}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors resize-none"
            />
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
                  <button
                    key={trigger.type}
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
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-sm text-text-secondary hover:text-text-primary rounded-lg hover:bg-bg-hover transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-3.5 py-1.5 text-sm font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting ? t('common.creating') : t('createRoutine.createRoutine')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
