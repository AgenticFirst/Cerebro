import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { FileText, FileCode, FileImage, FileVideo, FileAudio, File as FileIcon, Star } from 'lucide-react';
import type { FileItem } from '../../../types/files';
import { previewKindFor, formatBytes, formatRelative } from './utils';

function managedPreviewUrl(storagePath: string): string {
  const segments = storagePath.split('/').filter(Boolean).map(encodeURIComponent);
  return `cerebro-files://local/${segments.join('/')}`;
}

interface FileGridProps {
  items: FileItem[];
  selectedItemIds: Set<string>;
  onSelect: (id: string, e: React.MouseEvent) => void;
  onOpen: (item: FileItem) => void;
  onContextMenu: (item: FileItem, e: React.MouseEvent) => void;
}

function iconFor(item: FileItem) {
  const kind = previewKindFor(item.ext);
  if (kind === 'image') return FileImage;
  if (kind === 'video') return FileVideo;
  if (kind === 'audio') return FileAudio;
  if (kind === 'markdown' || kind === 'text') return FileText;
  if (kind === 'html' || ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'rb', 'java', 'json'].includes(item.ext)) return FileCode;
  return FileIcon;
}

function ImageThumb({ item }: { item: FileItem }) {
  const syncUrl = useMemo(
    () => (item.storageKind === 'managed' ? managedPreviewUrl(item.storagePath) : null),
    [item.storageKind, item.storagePath],
  );
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (syncUrl) return;
    let cancelled = false;
    window.cerebro.files
      .previewUrl({
        storageKind: item.storageKind,
        storagePath: item.storagePath,
        taskId: item.sourceTaskId,
      })
      .then((u) => { if (!cancelled) setResolvedUrl(u); })
      .catch(() => { if (!cancelled) setResolvedUrl(null); });
    return () => { cancelled = true; };
  }, [syncUrl, item.storageKind, item.storagePath, item.sourceTaskId]);

  const url = syncUrl ?? resolvedUrl;
  if (!url) return <div className="w-full h-full bg-bg-surface" />;
  return (
    <img
      src={url}
      alt={item.name}
      className="w-full h-full object-cover"
      loading="lazy"
    />
  );
}

export default function FileGrid({ items, selectedItemIds, onSelect, onOpen, onContextMenu }: FileGridProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 p-4">
      {items.map((item) => {
        const Icon = iconFor(item);
        const isSelected = selectedItemIds.has(item.id);
        const kind = previewKindFor(item.ext);
        const isImage = kind === 'image';
        return (
          <button
            key={item.id}
            onClick={(e) => onSelect(item.id, e)}
            onDoubleClick={() => onOpen(item)}
            onContextMenu={(e) => onContextMenu(item, e)}
            className={clsx(
              'group flex flex-col rounded-lg overflow-hidden text-left transition-all cursor-pointer',
              'border bg-bg-surface/60',
              isSelected
                ? 'border-accent ring-2 ring-accent/30'
                : 'border-border-subtle hover:border-border-strong hover:bg-bg-surface',
            )}
          >
            <div className="aspect-square bg-bg-base relative flex items-center justify-center">
              {isImage ? (
                <ImageThumb item={item} />
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <Icon size={36} className="text-text-tertiary" strokeWidth={1.25} />
                  <span className="text-[10px] uppercase tracking-wider font-mono text-text-tertiary">
                    {item.ext || '\u2014'}
                  </span>
                </div>
              )}
              {item.starred && (
                <span className="absolute top-1.5 right-1.5 text-amber-400">
                  <Star size={12} fill="currentColor" />
                </span>
              )}
            </div>
            <div className="px-2 py-1.5 border-t border-border-subtle">
              <div className="text-[12px] text-text-primary truncate" title={item.name}>
                {item.name}
              </div>
              <div className="text-[10px] text-text-tertiary flex items-center gap-1.5">
                <span>{formatBytes(item.sizeBytes)}</span>
                <span className="opacity-50">·</span>
                <span>{formatRelative(item.createdAt)}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
