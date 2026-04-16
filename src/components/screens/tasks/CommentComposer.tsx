import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import { useTasks } from '../../../context/TaskContext';

interface CommentComposerProps {
  taskId: string;
  onCommentAdded: () => void;
}

export default function CommentComposer({ taskId, onCommentAdded }: CommentComposerProps) {
  const { t } = useTranslation();
  const { addComment, sendInstruction } = useTasks();

  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);

  const isEmpty = text.trim().length === 0;

  const handleSubmit = useCallback(
    async (kind: 'comment' | 'instruction') => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;
      setIsSending(true);
      try {
        if (kind === 'instruction') {
          // Send to Expert: creates comment AND triggers a follow-up run
          await sendInstruction(taskId, trimmed);
        } else {
          await addComment(taskId, kind, trimmed);
        }
        setText('');
        onCommentAdded();
      } catch (err) {
        console.error('[CommentComposer] Failed to submit:', err);
      } finally {
        setIsSending(false);
      }
    },
    [taskId, text, isSending, addComment, sendInstruction, onCommentAdded],
  );

  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('tasks.commentPlaceholder')}
        rows={3}
        className={clsx(
          'w-full p-3 rounded-lg text-sm resize-none',
          'bg-bg-elevated text-text-primary placeholder:text-text-tertiary',
          'border border-border-subtle focus:border-accent outline-none',
        )}
      />
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={() => handleSubmit('comment')}
          disabled={isEmpty || isSending}
          className={clsx(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
            isEmpty || isSending
              ? 'bg-bg-hover text-text-tertiary cursor-not-allowed'
              : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border border-border-subtle',
          )}
        >
          <MessageSquare size={13} />
          {t('tasks.comment')}
        </button>
        <button
          onClick={() => handleSubmit('instruction')}
          disabled={isEmpty || isSending}
          className={clsx(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
            isEmpty || isSending
              ? 'bg-accent/20 text-accent/40 cursor-not-allowed'
              : 'bg-accent text-white hover:bg-accent/90',
          )}
        >
          <Send size={13} />
          {t('tasks.sendToExpert')}
        </button>
      </div>
    </div>
  );
}
