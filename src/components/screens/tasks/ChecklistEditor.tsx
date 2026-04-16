import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ArrowUpRight, Link } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type Task } from '../../../context/TaskContext';

interface ChecklistEditorProps {
  task: Task;
}

export default function ChecklistEditor({ task }: ChecklistEditorProps) {
  const { t } = useTranslation();
  const { addChecklistItem, updateChecklistItem, deleteChecklistItem, promoteChecklistItem } = useTasks();

  const [newItemText, setNewItemText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const items = task.checklist;
  const doneCount = items.filter((i) => i.is_done).length;
  const totalCount = items.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const handleAdd = useCallback(async () => {
    const trimmed = newItemText.trim();
    if (!trimmed) return;
    await addChecklistItem(task.id, trimmed);
    setNewItemText('');
    inputRef.current?.focus();
  }, [task.id, newItemText, addChecklistItem]);

  const handleAddKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleAdd();
      if (e.key === 'Escape') setNewItemText('');
    },
    [handleAdd],
  );

  const handleToggle = useCallback(
    (itemId: string, isDone: boolean) => {
      updateChecklistItem(task.id, itemId, { is_done: !isDone });
    },
    [task.id, updateChecklistItem],
  );

  const handleEditStart = useCallback((itemId: string, body: string) => {
    setEditingId(itemId);
    setEditText(body);
  }, []);

  const handleEditSave = useCallback(() => {
    if (!editingId) return;
    const trimmed = editText.trim();
    if (trimmed) {
      updateChecklistItem(task.id, editingId, { body: trimmed });
    }
    setEditingId(null);
  }, [task.id, editingId, editText, updateChecklistItem]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleEditSave();
      if (e.key === 'Escape') setEditingId(null);
    },
    [handleEditSave],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          {t('tasks.checklist')}
        </span>
        {totalCount > 0 && (
          <span className="text-xs text-text-tertiary">
            {doneCount}/{totalCount} {t('tasks.drawerItems')}
          </span>
        )}
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <div className="relative w-full h-1.5 rounded-full bg-bg-hover mb-3 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-accent transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* Items */}
      <div className="space-y-0.5">
        {items.map((item) => {
          const isPromoted = !!item.promoted_task_id;

          return (
            <div
              key={item.id}
              className={clsx(
                'group flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-bg-hover transition-colors',
                isPromoted && 'opacity-50',
              )}
            >
              <input
                type="checkbox"
                checked={item.is_done}
                onChange={() => handleToggle(item.id, item.is_done)}
                disabled={isPromoted}
                className="w-3.5 h-3.5 rounded border-border-default accent-[#06B6D4] cursor-pointer"
              />

              {editingId === item.id ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={handleEditSave}
                  onKeyDown={handleEditKeyDown}
                  className="flex-1 text-sm bg-transparent text-text-primary border-b border-accent outline-none"
                />
              ) : (
                <span
                  onClick={() => !isPromoted && handleEditStart(item.id, item.body)}
                  className={clsx(
                    'flex-1 text-sm cursor-pointer',
                    item.is_done
                      ? 'line-through text-text-tertiary'
                      : 'text-text-primary',
                  )}
                >
                  {item.body}
                </span>
              )}

              {isPromoted && (
                <Link size={12} className="text-accent flex-shrink-0" />
              )}

              {!isPromoted && (
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => promoteChecklistItem(task.id, item.id)}
                    className="p-1 rounded text-text-tertiary hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
                    title={t('tasks.drawerPromote')}
                  >
                    <ArrowUpRight size={13} />
                  </button>
                  <button
                    onClick={() => deleteChecklistItem(task.id, item.id)}
                    className="p-1 rounded text-text-tertiary hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer"
                    title={t('tasks.drawerDeleteItem')}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Add item */}
      <div className="flex items-center gap-2 mt-2">
        <Plus size={14} className="text-text-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          value={newItemText}
          onChange={(e) => setNewItemText(e.target.value)}
          onKeyDown={handleAddKeyDown}
          placeholder={t('tasks.drawerAddItem')}
          className="flex-1 text-sm bg-transparent text-text-primary placeholder:text-text-tertiary outline-none"
        />
      </div>
    </div>
  );
}
