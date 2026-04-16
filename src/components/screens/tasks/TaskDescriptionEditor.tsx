import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Eye } from 'lucide-react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';

interface TaskDescriptionEditorProps {
  taskId: string;
  value: string;
  onSave: (md: string) => void;
}

export default function TaskDescriptionEditor({ taskId, value, onSave }: TaskDescriptionEditorProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const handleEdit = useCallback(() => {
    setDraft(value);
    setIsEditing(true);
  }, [value]);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    if (draft !== value) {
      onSave(draft);
    }
  }, [draft, value, onSave]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          {t('tasks.drawerDescription')}
        </span>
        <button
          onClick={isEditing ? handleBlur : handleEdit}
          className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
          title={isEditing ? t('tasks.drawerPreview') : t('tasks.drawerEdit')}
        >
          {isEditing ? <Eye size={14} /> : <Pencil size={14} />}
        </button>
      </div>

      {isEditing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          autoFocus
          placeholder={t('tasks.drawerDescriptionPlaceholder')}
          className={clsx(
            'w-full min-h-[120px] p-3 rounded-lg text-sm',
            'bg-bg-elevated text-text-primary placeholder:text-text-tertiary',
            'border border-border-subtle focus:border-accent outline-none',
            'resize-y',
          )}
        />
      ) : (
        <div
          onClick={handleEdit}
          className={clsx(
            'rounded-lg p-3 text-sm cursor-pointer',
            'bg-bg-surface border border-border-subtle hover:border-border-default transition-colors',
            !value && 'text-text-tertiary italic',
          )}
        >
          {value ? (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown>{value}</ReactMarkdown>
            </div>
          ) : (
            t('tasks.drawerDescriptionPlaceholder')
          )}
        </div>
      )}
    </div>
  );
}
