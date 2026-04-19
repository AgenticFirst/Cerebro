import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Eye, Maximize2 } from 'lucide-react';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import { useExperts } from '../../../context/ExpertContext';
import { normalizeToTokens } from '../../../lib/mentions';
import { mentionMarkdownComponents } from './MentionBadge';
import MentionTextarea from './MentionTextarea';
import { useMarkdownDocument } from '../../../context/MarkdownDocumentContext';

interface TaskDescriptionEditorProps {
  taskId: string;
  value: string;
  onSave: (md: string) => void;
}

export default function TaskDescriptionEditor({ taskId, value, onSave }: TaskDescriptionEditorProps) {
  const { t } = useTranslation();
  const { experts } = useExperts();
  const { open: openMarkdown } = useMarkdownDocument();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const assignableExperts = useMemo(
    () => experts.filter((e) => e.type === 'expert' && e.isEnabled),
    [experts],
  );

  const handleExpand = useCallback(() => {
    // Close inline edit mode (if open) so we don't have two editors fighting
    // over the same string.
    if (isEditing) {
      if (draft !== value) onSave(draft);
      setIsEditing(false);
    }
    openMarkdown({
      title: t('tasks.drawerDescription'),
      subtitle: taskId,
      content: value,
      onSave: (md) => onSave(md),
      initialMode: 'split',
    });
  }, [isEditing, draft, value, onSave, openMarkdown, t, taskId]);

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

  const previewBody = useMemo(
    () => normalizeToTokens(value, experts),
    [value, experts],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          {t('tasks.drawerDescription')}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleExpand}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={t('markdown.expand')}
          >
            <Maximize2 size={13} />
          </button>
          <button
            onClick={isEditing ? handleBlur : handleEdit}
            className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            title={isEditing ? t('tasks.drawerPreview') : t('tasks.drawerEdit')}
          >
            {isEditing ? <Eye size={14} /> : <Pencil size={14} />}
          </button>
        </div>
      </div>

      {isEditing ? (
        <MentionTextarea
          value={draft}
          onChange={setDraft}
          experts={assignableExperts}
          autoFocus
          onBlur={handleBlur}
          placeholder={t('tasks.drawerDescriptionPlaceholder')}
          rows={6}
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
              <ReactMarkdown components={mentionMarkdownComponents}>
                {previewBody}
              </ReactMarkdown>
            </div>
          ) : (
            t('tasks.drawerDescriptionPlaceholder')
          )}
        </div>
      )}
    </div>
  );
}
