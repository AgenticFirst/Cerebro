import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ExternalLink, FolderOpen, Download } from 'lucide-react';
import type { FileItem } from '../../../types/files';
import { previewKindFor, formatBytes, formatRelative } from './utils';
import { useMarkdownDocument } from '../../../context/MarkdownDocumentContext';
import FilePreviewBody from '../../files-preview/FilePreviewBody';

interface FilePreviewDrawerProps {
  item: FileItem;
  onClose: () => void;
}

export default function FilePreviewDrawer({ item, onClose }: FilePreviewDrawerProps) {
  const { t } = useTranslation();
  const { open: openMarkdown } = useMarkdownDocument();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const kind = previewKindFor(item.ext);

  useEffect(() => {
    let cancelled = false;
    setPreviewUrl(null);
    setTextContent(null);
    setLoadError(null);

    if (kind === 'image' || kind === 'html' || kind === 'video' || kind === 'audio' || kind === 'pdf') {
      window.cerebro.files
        .previewUrl({ storageKind: item.storageKind, storagePath: item.storagePath, taskId: item.sourceTaskId })
        .then((u) => { if (!cancelled) setPreviewUrl(u); })
        .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    } else if (kind === 'text' || kind === 'markdown') {
      const loader = item.storageKind === 'managed'
        ? window.cerebro.files.readManagedText(item.storagePath)
        : item.sourceTaskId
          ? window.cerebro.taskTerminal.readFile(item.sourceTaskId, item.storagePath).then((c) => c ?? '')
          : Promise.resolve('');
      loader
        .then((c) => { if (!cancelled) setTextContent(c); })
        .catch((err) => { if (!cancelled) setLoadError(String(err)); });
    }
    return () => { cancelled = true; };
  }, [item.id, item.storagePath, item.storageKind, item.sourceTaskId, kind]);

  // Esc closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleOpen = () => window.cerebro.files.open({
    storageKind: item.storageKind,
    storagePath: item.storagePath,
    taskId: item.sourceTaskId,
  });
  const handleReveal = () => window.cerebro.files.reveal({
    storageKind: item.storageKind,
    storagePath: item.storagePath,
    taskId: item.sourceTaskId,
  });
  const handleDownload = () => window.cerebro.files.download({
    storageKind: item.storageKind,
    storagePath: item.storagePath,
    taskId: item.sourceTaskId,
  });

  useEffect(() => {
    if (kind === 'markdown' && textContent !== null) {
      openMarkdown({
        title: item.name,
        subtitle: item.storagePath,
        content: textContent,
        readOnly: true,
        initialMode: 'view',
        onClose: onClose,
      });
    }
  }, [kind, textContent, item.id, item.name, item.storagePath, openMarkdown, onClose]);


  return (
    <div className="w-[460px] flex-shrink-0 border-l border-border-subtle flex flex-col min-h-0 bg-bg-base animate-slide-in-right">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle flex-shrink-0">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate">{item.name}</div>
          <div className="text-[10px] text-text-tertiary truncate font-mono">
            {formatBytes(item.sizeBytes)} · {formatRelative(item.createdAt)}
          </div>
        </div>
        <button onClick={handleDownload} title={t('files.actionDownload')} className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer">
          <Download size={14} />
        </button>
        <button onClick={handleReveal} title={t('files.actionReveal')} className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer">
          <FolderOpen size={14} />
        </button>
        <button onClick={handleOpen} title={t('files.actionOpen')} className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer">
          <ExternalLink size={14} />
        </button>
        <button onClick={onClose} className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover cursor-pointer">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <FilePreviewBody
          kind={kind}
          name={item.name}
          ext={item.ext}
          previewUrl={previewUrl}
          textContent={textContent}
          loadError={loadError}
          onOpenExternal={handleOpen}
        />
      </div>
    </div>
  );
}
