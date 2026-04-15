import clsx from 'clsx';
import type { Task } from './types';
import { STATUS_CONFIG, formatElapsed } from './helpers';

interface TaskListCardProps {
  task: Task;
  isSelected: boolean;
  onClick: () => void;
}

export default function TaskListCard({ task, isSelected, onClick }: TaskListCardProps) {
  const style = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending;

  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left px-3 py-2.5 rounded-lg transition-colors cursor-pointer',
        'border border-transparent',
        isSelected
          ? 'bg-accent/10 border-accent/20'
          : 'hover:bg-bg-secondary',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <div
          className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', style.dot)}
          style={style.glow ? { boxShadow: '0 0 6px currentColor' } : undefined}
        />
        <span className="text-sm font-medium text-text-primary truncate flex-1">
          {task.title}
        </span>
      </div>
      <p className="text-xs text-text-tertiary line-clamp-2 ml-3.5 mb-1.5">
        {task.goal}
      </p>
      <div className="flex items-center gap-3 ml-3.5 text-[11px] text-text-tertiary">
        <span className={style.text}>{style.label}</span>
        {(task.status === 'running' || task.status === 'completed' || task.status === 'failed') && (
          <span>{formatElapsed(task.started_at, task.completed_at)}</span>
        )}
        {task.created_expert_ids.length > 0 && (
          <span>+{task.created_expert_ids.length} experts</span>
        )}
      </div>
    </button>
  );
}
