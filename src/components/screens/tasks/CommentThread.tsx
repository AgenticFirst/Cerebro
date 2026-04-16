import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Bot, Info } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type TaskComment } from '../../../context/TaskContext';
import CommentComposer from './CommentComposer';

interface CommentThreadProps {
  taskId: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CommentThread({ taskId }: CommentThreadProps) {
  const { t } = useTranslation();
  const { loadComments } = useTasks();

  const [comments, setComments] = useState<TaskComment[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await loadComments(taskId);
      setComments(data);
    } finally {
      setIsLoading(false);
    }
  }, [taskId, loadComments]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (isLoading && comments.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        {t('tasks.drawerLoadingComments')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {comments.length === 0 && !isLoading && (
        <p className="text-xs text-text-tertiary text-center py-4">
          {t('tasks.drawerNoComments')}
        </p>
      )}

      {comments.map((comment) => {
        if (comment.kind === 'system') {
          return (
            <div key={comment.id} className="flex items-start gap-2 py-1">
              <Info size={12} className="text-text-tertiary mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs text-text-tertiary italic">{comment.body_md}</p>
                <span className="text-[10px] text-text-tertiary/60">{formatTime(comment.created_at)}</span>
              </div>
            </div>
          );
        }

        const isInstruction = comment.kind === 'instruction';
        const isUser = comment.author_kind === 'user';

        return (
          <div
            key={comment.id}
            className={clsx(
              'rounded-lg p-3',
              isInstruction
                ? 'border-l-2 border-accent bg-accent/5'
                : 'bg-bg-surface border border-border-subtle',
            )}
          >
            <div className="flex items-center gap-2 mb-1.5">
              {isUser ? (
                <User size={14} className="text-text-secondary" />
              ) : (
                <Bot size={14} className="text-accent" />
              )}
              <span className="text-xs font-medium text-text-secondary">
                {isUser ? t('tasks.drawerYou') : t('tasks.drawerExpert')}
              </span>
              {isInstruction && (
                <span className="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                  {t('tasks.sentToExpert')}
                </span>
              )}
              <span className="text-[10px] text-text-tertiary ml-auto">
                {formatTime(comment.created_at)}
              </span>
            </div>
            <p className="text-sm text-text-primary whitespace-pre-wrap">{comment.body_md}</p>
          </div>
        );
      })}

      <CommentComposer taskId={taskId} onCommentAdded={refresh} />
    </div>
  );
}
