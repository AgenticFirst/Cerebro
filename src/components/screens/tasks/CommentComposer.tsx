import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, MessageSquare } from 'lucide-react';
import clsx from 'clsx';
import { useTasks } from '../../../context/TaskContext';
import { useExperts } from '../../../context/ExpertContext';
import MentionTextarea from './MentionTextarea';
import { extractMentionIds } from '../../../lib/mentions';

interface CommentComposerProps {
  taskId: string;
  currentExpertId: string | null;
  hasPendingQueuedInstruction: boolean;
  onCommentAdded: () => void;
}

export default function CommentComposer({
  taskId,
  currentExpertId,
  hasPendingQueuedInstruction,
  onCommentAdded,
}: CommentComposerProps) {
  const { t } = useTranslation();
  const { addComment, sendInstruction } = useTasks();
  const { experts } = useExperts();

  const assignableExperts = useMemo(
    () => experts.filter((e) => e.type === 'expert' && e.isEnabled),
    [experts],
  );

  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);

  const isEmpty = text.trim().length === 0;
  const sendDisabled = isEmpty || isSending || hasPendingQueuedInstruction;

  const handleSubmit = useCallback(
    async (kind: 'comment' | 'instruction') => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;
      if (kind === 'instruction' && hasPendingQueuedInstruction) return;
      setIsSending(true);
      try {
        if (kind === 'instruction') {
          const mentionIds = extractMentionIds(trimmed, assignableExperts);
          const targetExpertId = mentionIds[0] ?? currentExpertId;
          await sendInstruction(taskId, trimmed, targetExpertId);
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
    [
      taskId,
      text,
      isSending,
      hasPendingQueuedInstruction,
      addComment,
      sendInstruction,
      onCommentAdded,
      assignableExperts,
      currentExpertId,
    ],
  );

  return (
    <div className="space-y-2">
      <MentionTextarea
        value={text}
        onChange={setText}
        experts={assignableExperts}
        placeholder={t('tasks.commentPlaceholder')}
        rows={3}
        className={clsx(
          'w-full p-3 rounded-lg text-sm resize-none',
          'bg-bg-elevated text-text-primary placeholder:text-text-tertiary',
          'border border-border-subtle focus:border-accent outline-none',
        )}
      />
      {hasPendingQueuedInstruction && (
        <p className="text-[11px] text-amber-400/80 italic">{t('tasks.queuedAlreadyPending')}</p>
      )}
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
          disabled={sendDisabled}
          title={hasPendingQueuedInstruction ? t('tasks.queuedAlreadyPending') : undefined}
          className={clsx(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer',
            sendDisabled
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
