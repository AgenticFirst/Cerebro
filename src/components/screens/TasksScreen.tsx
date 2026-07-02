import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search, X } from 'lucide-react';
import { useTasks, type Task } from '../../context/TaskContext';
import KanbanBoard from './tasks/KanbanBoard';
import TaskDetailDrawer from './tasks/TaskDetailDrawer';
import NewTaskDialog from './tasks/NewTaskDialog';

export default function TasksScreen() {
  const { t } = useTranslation();
  const { tasks } = useTasks();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedTask = selectedTaskId ? (tasks.find((x) => x.id === selectedTaskId) ?? null) : null;

  const handleCardClick = useCallback((task: Task) => setSelectedTaskId(task.id), []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-5 pt-3 pb-2 flex items-center justify-between flex-shrink-0">
        <h1 className="text-base font-semibold text-text-primary">{t('tasks.title')}</h1>
        <div className="flex items-center gap-2">
          <div className="relative w-64">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              ref={searchRef}
              type="text"
              placeholder={t('tasks.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  searchRef.current?.blur();
                }
              }}
              className="w-full bg-bg-base border border-border-subtle rounded-lg pl-8 pr-8 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/30 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  searchRef.current?.focus();
                }}
                aria-label={t('tasks.clearSearch')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            )}
          </div>
          <button
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/10 hover:bg-accent/20 text-accent text-[13px] font-medium transition-colors cursor-pointer border border-accent/20"
          >
            <Plus size={14} />
            {t('tasks.newTask')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0" data-tour-id="tasks-board">
        <KanbanBoard onCardClick={handleCardClick} searchQuery={searchQuery} />
      </div>

      <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTaskId(null)} />

      <NewTaskDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
