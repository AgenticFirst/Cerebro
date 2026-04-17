import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useTasks, type Task } from '../../context/TaskContext';
import KanbanBoard from './tasks/KanbanBoard';
import TaskDetailDrawer from './tasks/TaskDetailDrawer';
import NewTaskDialog from './tasks/NewTaskDialog';

export default function TasksScreen() {
  const { t } = useTranslation();
  const { tasks } = useTasks();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const selectedTask = selectedTaskId ? tasks.find((x) => x.id === selectedTaskId) ?? null : null;

  const handleCardClick = useCallback(
    (task: Task) => setSelectedTaskId(task.id),
    [],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-5 pt-3 pb-2 flex items-center justify-between flex-shrink-0">
        <h1 className="text-base font-semibold text-text-primary">{t('tasks.title')}</h1>
        <button
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/10 hover:bg-accent/20 text-accent text-[13px] font-medium transition-colors cursor-pointer border border-accent/20"
        >
          <Plus size={14} />
          {t('tasks.newTask')}
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <KanbanBoard onCardClick={handleCardClick} />
      </div>

      <TaskDetailDrawer
        task={selectedTask}
        onClose={() => setSelectedTaskId(null)}
      />

      <NewTaskDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
