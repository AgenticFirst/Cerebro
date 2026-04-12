import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useTasks } from '../../../context/TaskContext';

interface TaskFollowUpInputProps {
  taskId: string;
}

export default function TaskFollowUpInput({ taskId }: TaskFollowUpInputProps) {
  const { followUpTask } = useTasks();
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [value]);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await followUpTask(taskId, trimmed);
      setValue('');
    } catch (err) {
      console.error('Follow-up failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  }, [value, isSubmitting, followUpTask, taskId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="px-4 py-3 border-t border-border-subtle bg-bg-primary flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Follow up... (e.g. &quot;add dark mode&quot;, &quot;make section 2 shorter&quot;)"
          rows={1}
          disabled={isSubmitting}
          className={clsx(
            'flex-1 resize-none rounded-lg px-3 py-2 text-sm',
            'bg-bg-secondary border border-border-subtle',
            'text-text-primary placeholder:text-text-tertiary',
            'focus:outline-none focus:border-accent/50',
            'scrollbar-thin transition-colors',
            isSubmitting && 'opacity-50',
          )}
        />
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || isSubmitting}
          className={clsx(
            'flex-shrink-0 p-2 rounded-lg transition-colors cursor-pointer',
            value.trim() && !isSubmitting
              ? 'bg-accent text-white hover:bg-accent/80'
              : 'bg-bg-secondary text-text-tertiary',
          )}
        >
          {isSubmitting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <ArrowUp size={16} />
          )}
        </button>
    </div>
  );
}
