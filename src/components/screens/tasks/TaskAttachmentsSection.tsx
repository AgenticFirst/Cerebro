import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Paperclip } from 'lucide-react';
import clsx from 'clsx';
import { useTasks, type TaskAttachment } from '../../../context/TaskContext';
import { useToast } from '../../../context/ToastContext';
import { useDropZone } from '../../../hooks/useDropZone';
import type { AttachmentInfo } from '../../../types/attachments';
import TaskAttachmentChip from './TaskAttachmentChip';

interface TaskAttachmentsSectionProps {
  taskId: string;
}

export default function TaskAttachmentsSection({ taskId }: TaskAttachmentsSectionProps) {
  const { t } = useTranslation();
  const { addToast } = useToast();
  const { listAttachments, addAttachment, removeAttachment } = useTasks();

  const [items, setItems] = useState<TaskAttachment[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listAttachments(taskId)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err) => console.warn('[attachments] load failed:', err));
    return () => {
      cancelled = true;
    };
  }, [taskId, listAttachments]);

  const ingest = useCallback(
    async (hostPaths: string[]) => {
      if (hostPaths.length === 0) return;
      setBusy(true);
      const results = await Promise.allSettled(hostPaths.map((p) => addAttachment(taskId, p)));
      const added: TaskAttachment[] = [];
      let failures = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') added.push(r.value);
        else failures++;
      }
      if (added.length > 0) {
        setItems((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          const merged = [...prev];
          for (const a of added) if (!seen.has(a.id)) merged.push(a);
          return merged;
        });
      }
      if (failures > 0) addToast(t('tasks.attachmentsCopyFailed'), 'error');
      setBusy(false);
    },
    [taskId, addAttachment, addToast, t],
  );

  const handleDrop = useCallback(
    (attachments: AttachmentInfo[]) => {
      ingest(attachments.map((a) => a.filePath));
    },
    [ingest],
  );

  const { isDragOver, dropProps } = useDropZone({ onDrop: handleDrop });

  const handlePick = useCallback(async () => {
    try {
      const paths = await window.cerebro.files.pickFiles();
      await ingest(paths);
    } catch (err) {
      console.warn('[attachments] pick failed:', err);
      addToast(t('tasks.attachmentsCopyFailed'), 'error');
    }
  }, [ingest, addToast, t]);

  const handleRemove = useCallback(
    async (attachment: TaskAttachment) => {
      // Optimistic — flip back if the backend call fails.
      setItems((prev) => prev.filter((p) => p.id !== attachment.id));
      try {
        await removeAttachment(taskId, attachment.id, attachment.storage_path);
      } catch (err) {
        console.warn('[attachments] remove failed:', err);
        setItems((prev) => [...prev, attachment]);
        addToast(t('tasks.attachmentsCopyFailed'), 'error');
      }
    },
    [taskId, removeAttachment, addToast, t],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="block text-xs font-medium text-text-secondary uppercase tracking-wide">
          {t('tasks.attachmentsLabel')}
        </span>
        <button
          type="button"
          onClick={handlePick}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={t('tasks.attachmentsAddTitle')}
        >
          <Paperclip size={12} />
          <span>{t('tasks.attachmentsAdd')}</span>
        </button>
      </div>

      <div
        {...dropProps}
        className={clsx(
          'rounded-md border border-dashed transition-colors',
          isDragOver
            ? 'border-cyan-500/60 bg-cyan-500/5'
            : 'border-border-subtle bg-bg-elevated/30',
          items.length === 0 ? 'p-4' : 'p-2',
        )}
      >
        {items.length === 0 ? (
          <p className="text-xs text-text-tertiary text-center">
            {isDragOver ? t('tasks.attachmentsDropHint') : t('tasks.attachmentsEmpty')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {items.map((att) => (
              <TaskAttachmentChip
                key={att.id}
                attachment={att}
                onRemove={() => handleRemove(att)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
