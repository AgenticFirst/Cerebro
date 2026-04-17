import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Bot, Info, X, Clock } from 'lucide-react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import { useTasks, type TaskComment } from '../../../context/TaskContext';
import { useExperts } from '../../../context/ExpertContext';
import { normalizeToTokens } from '../../../lib/mentions';
import { mentionMarkdownComponents } from './MentionBadge';
import CommentComposer from './CommentComposer';

interface CommentThreadProps {
  taskId: string;
  currentExpertId: string | null;
  filterSystem?: boolean;
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

export default function CommentThread({
  taskId,
  currentExpertId,
  filterSystem = true,
}: CommentThreadProps) {
  const { t } = useTranslation();
  const { tasks, loadComments, discardQueuedInstruction } = useTasks();
  const { experts } = useExperts();

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

  // Refresh when the parent task transitions (e.g. cancel flips pending
  // instructions to discarded in the DB — the list must reflect that).
  const task = tasks.find((t) => t.id === taskId);
  const taskColumn = task?.column;
  const taskRunId = task?.run_id ?? null;
  useEffect(() => {
    refresh();
  }, [refresh, taskColumn, taskRunId]);

  const visibleComments = useMemo(
    () => (filterSystem ? comments.filter((c) => c.kind !== 'system') : comments),
    [comments, filterSystem],
  );

  const hasPendingQueuedInstruction = useMemo(
    () => comments.some((c) => c.queue_status === 'pending'),
    [comments],
  );

  const handleDiscardQueued = useCallback(async (commentId: string) => {
    await discardQueuedInstruction(taskId, commentId);
    await refresh();
  }, [taskId, discardQueuedInstruction, refresh]);

  if (isLoading && comments.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        {t('tasks.drawerLoadingComments')}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {visibleComments.length === 0 && !isLoading && (
        <p className="text-xs text-text-tertiary text-center py-4">
          {t('tasks.drawerNoComments')}
        </p>
      )}

      {visibleComments.map((comment) => {
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
        const isPending = comment.queue_status === 'pending';
        const normalized = normalizeToTokens(comment.body_md, experts);

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
              {isInstruction && !isPending && (
                <span className="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                  {t('tasks.sentToExpert')}
                </span>
              )}
              {isPending && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-300 bg-amber-500/15 px-1.5 py-0.5 rounded">
                  <Clock size={10} />
                  {t('tasks.queuedWaitingBadge')}
                </span>
              )}
              <span className="text-[10px] text-text-tertiary ml-auto">
                {formatTime(comment.created_at)}
              </span>
              {isPending && (
                <button
                  onClick={() => handleDiscardQueued(comment.id)}
                  title={t('tasks.queueFailedDiscard')}
                  className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="text-sm text-text-primary whitespace-pre-wrap prose prose-invert prose-sm max-w-none prose-p:my-0">
              <ReactMarkdown components={mentionMarkdownComponents}>
                {normalized}
              </ReactMarkdown>
            </div>
          </div>
        );
      })}

      <CommentComposer
        taskId={taskId}
        currentExpertId={currentExpertId}
        hasPendingQueuedInstruction={hasPendingQueuedInstruction}
        onCommentAdded={refresh}
      />
    </div>
  );
}
