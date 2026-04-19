import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ExternalLink,
  Eye,
  FolderOpen,
  Pencil,
  ArrowRight,
  Copy,
  Star,
  Download,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import type { FileItem } from '../../../types/files';

export interface FileContextMenuAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
}

interface FileContextMenuProps {
  position: { x: number; y: number };
  item: FileItem;
  isTrashed: boolean;
  onClose: () => void;
  onPreview: (item: FileItem) => void;
  onOpen: (item: FileItem) => void;
  onReveal: (item: FileItem) => void;
  onRename: (item: FileItem) => void;
  onMove: () => void;
  onCopy: () => void;
  onStar: (item: FileItem) => void;
  onDownload: (item: FileItem) => void;
  onSoftDelete: () => void;
  onRestore: () => void;
  onHardDelete: () => void;
}

export default function FileContextMenu(props: FileContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const { item, isTrashed, position, onClose } = props;

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const actions: FileContextMenuAction[] = isTrashed
    ? [
        { key: 'restore', label: t('files.actionRestore'), icon: <RotateCcw size={12} />, onClick: () => { props.onRestore(); onClose(); } },
        { key: 'hard-delete', label: t('files.actionDeleteForever'), icon: <Trash2 size={12} />, onClick: () => { props.onHardDelete(); onClose(); }, danger: true, separator: true },
      ]
    : [
        { key: 'preview', label: t('files.actionPreview'), icon: <Eye size={12} />, onClick: () => { props.onPreview(item); onClose(); } },
        { key: 'open', label: t('files.actionOpen'), icon: <ExternalLink size={12} />, onClick: () => { props.onOpen(item); onClose(); } },
        { key: 'reveal', label: t('files.actionReveal'), icon: <FolderOpen size={12} />, onClick: () => { props.onReveal(item); onClose(); }, separator: true },
        ...(item.storageKind === 'managed' ? [
          { key: 'rename', label: t('files.actionRename'), icon: <Pencil size={12} />, onClick: () => { props.onRename(item); onClose(); } },
          { key: 'move', label: t('files.actionMove'), icon: <ArrowRight size={12} />, onClick: () => { props.onMove(); onClose(); } },
        ] : []),
        { key: 'copy', label: t('files.actionCopy'), icon: <Copy size={12} />, onClick: () => { props.onCopy(); onClose(); } },
        { key: 'star', label: item.starred ? t('files.actionUnstar') : t('files.actionStar'), icon: <Star size={12} />, onClick: () => { props.onStar(item); onClose(); } },
        { key: 'download', label: t('files.actionDownload'), icon: <Download size={12} />, onClick: () => { props.onDownload(item); onClose(); }, separator: true },
        ...(item.storageKind === 'managed' ? [
          { key: 'delete', label: t('files.actionDelete'), icon: <Trash2 size={12} />, onClick: () => { props.onSoftDelete(); onClose(); }, danger: true },
        ] : []),
      ];

  return (
    <div
      ref={ref}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 min-w-[180px] bg-bg-surface border border-border-subtle rounded-lg shadow-xl py-1 animate-fade-in"
    >
      {actions.map((action, idx) => {
        const showSep = action.separator && idx < actions.length - 1;
        return (
          <div key={action.key}>
            <button
              onClick={action.onClick}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors cursor-pointer ${
                action.danger
                  ? 'text-red-400 hover:bg-red-400/10'
                  : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'
              }`}
            >
              <span className="text-text-tertiary flex-shrink-0">{action.icon}</span>
              <span className="flex-1">{action.label}</span>
            </button>
            {showSep && <div className="my-1 border-t border-border-subtle" />}
          </div>
        );
      })}
    </div>
  );
}
