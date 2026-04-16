import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type TaskPriority } from '../../../context/TaskContext';
import { useExperts } from '../../../context/ExpertContext';

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
}

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

export default function NewTaskDialog({ open, onClose }: NewTaskDialogProps) {
  const { t } = useTranslation();
  const { createTask } = useTasks();
  const { experts } = useExperts();
  const titleRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [expertId, setExpertId] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [dueDate, setDueDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset form and auto-focus on open
  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setExpertId('');
      setPriority('normal');
      setDueDate('');
      setStartDate('');
      setIsSubmitting(false);
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const canSubmit = title.trim().length > 0 && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await createTask({
        title: title.trim(),
        description_md: description.trim() || undefined,
        expert_id: expertId || null,
        priority,
        due_at: dueDate || null,
        start_at: startDate || null,
      });
      onClose();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filter to non-team experts for assignment
  const assignableExperts = experts.filter((e) => e.type === 'expert' && e.isEnabled);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-bg-elevated border border-border-subtle rounded-xl max-w-lg w-full mx-4 p-6 animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-medium text-text-primary">
            {t('tasks.newTask')}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('tasks.titleLabel')}
            </label>
            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('tasks.titlePlaceholder')}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              {t('tasks.descriptionLabel')}{' '}
              <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('tasks.descriptionPlaceholder')}
              rows={3}
              className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/40 transition-colors resize-none"
            />
          </div>

          {/* Expert + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Expert */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t('tasks.expertLabel')}{' '}
                <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
              </label>
              <select
                value={expertId}
                onChange={(e) => setExpertId(e.target.value)}
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/40 transition-colors appearance-none"
              >
                <option value="">{t('tasks.expertNone')}</option>
                {assignableExperts.map((expert) => (
                  <option key={expert.id} value={expert.id}>
                    {expert.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t('tasks.priorityLabel')}
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                className="w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent/40 transition-colors appearance-none"
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {t(`tasks.priority_${p}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Date row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Start date */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t('tasks.startDateLabel')}{' '}
                <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={clsx(
                  'w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary',
                  'focus:outline-none focus:border-accent/40 transition-colors',
                  '[color-scheme:dark]',
                )}
              />
            </div>

            {/* Due date */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t('tasks.dueDateLabel')}{' '}
                <span className="text-text-tertiary font-normal">{t('common.optional')}</span>
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={clsx(
                  'w-full bg-bg-surface border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary',
                  'focus:outline-none focus:border-accent/40 transition-colors',
                  '[color-scheme:dark]',
                )}
              />
            </div>
          </div>

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
              {isSubmitting ? t('common.loading') : t('tasks.createTask')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
