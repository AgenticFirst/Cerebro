import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, User, Bot, Send } from 'lucide-react';
import { useTasks, type TaskComment } from '../../../context/TaskContext';
import { useExperts } from '../../../context/ExpertContext';

interface ActivityTimelineProps {
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

export default function ActivityTimeline({ taskId }: ActivityTimelineProps) {
  const { t } = useTranslation();
  const { loadComments } = useTasks();
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

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resolveActor = (comment: TaskComment): string => {
    if (comment.author_kind === 'user') return t('tasks.drawerYou');
    if (comment.expert_id) {
      const expert = experts.find((e) => e.id === comment.expert_id);
      if (expert) return expert.name;
    }
    return t('tasks.drawerExpert');
  };

  if (isLoading && comments.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">
        {t('tasks.drawerLoadingComments')}
      </p>
    );
  }

  if (comments.length === 0) {
    return (
      <p className="text-xs text-text-tertiary text-center py-6">{t('tasks.activityEmpty')}</p>
    );
  }

  return (
    <ol className="space-y-2">
      {comments.map((comment) => {
        const time = formatTime(comment.created_at);

        if (comment.kind === 'system') {
          return (
            <li key={comment.id} className="flex items-start gap-2 py-1">
              <Info size={12} className="text-text-tertiary mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-text-tertiary italic">{comment.body_md}</p>
                <span className="text-[10px] text-text-tertiary/60">{time}</span>
              </div>
            </li>
          );
        }

        const actor = resolveActor(comment);
        const isInstruction = comment.kind === 'instruction';
        const labelKey = isInstruction ? 'tasks.activityInstructed' : 'tasks.activityCommented';

        return (
          <li key={comment.id} className="flex items-start gap-2 py-1">
            {isInstruction ? (
              <Send size={12} className="text-accent mt-0.5 flex-shrink-0" />
            ) : comment.author_kind === 'user' ? (
              <User size={12} className="text-text-tertiary mt-0.5 flex-shrink-0" />
            ) : (
              <Bot size={12} className="text-text-tertiary mt-0.5 flex-shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-xs text-text-tertiary">{t(labelKey, { actor })}</p>
              <span className="text-[10px] text-text-tertiary/60">{time}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
