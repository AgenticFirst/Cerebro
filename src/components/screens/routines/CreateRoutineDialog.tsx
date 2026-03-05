import { useState, useEffect, useRef } from 'react';
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

  const triggers: Array<{ type: TriggerType; icon: typeof Hand; label: string; desc: string }> = [
    { type: 'manual', icon: Hand, label: 'Manual', desc: 'Run on demand' },
    { type: 'cron', icon: Clock, label: 'Scheduled', desc: 'Run on a schedule' },
    { type: 'webhook', icon: Webhook, label: 'Webhook', desc: 'Run via webhook' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-elevated rounded-xl border border-border-subtle p-6 w-full max-w-md animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-medium text-text-primary">New Routine</h3>
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
              Name
            </label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Daily Standup Summary"
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Description{' '}
              <span className="text-text-tertiary font-normal">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this routine do?"
              rows={2}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors resize-none"
            />
          </div>

          {/* Trigger Type */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Trigger
            </label>
            <div className="flex gap-2">
              {triggers.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.type}
                    type="button"
                    onClick={() => setTriggerType(t.type)}
                    className={clsx(
                      'flex-1 flex flex-col items-center gap-1 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors border',
                      triggerType === t.type
                        ? 'bg-accent/10 border-accent/30 text-accent'
                        : 'bg-bg-surface border-border-subtle text-text-tertiary hover:text-text-secondary hover:border-border-default',
                    )}
                  >
                    <Icon size={15} />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Schedule Picker (conditional) */}
          {triggerType === 'cron' && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Schedule
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-3.5 py-1.5 text-sm font-medium text-bg-base bg-accent hover:bg-accent-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Creating...' : 'Create Routine'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
