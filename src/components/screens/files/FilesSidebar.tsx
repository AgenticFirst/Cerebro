import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  Clock,
  Star,
  FolderOpen,
  Folder,
  Trash2,
  Plus,
  Inbox,
  Briefcase,
  MoreHorizontal,
} from 'lucide-react';
import { useFiles } from '../../../context/FilesContext';
import type { Bucket, SidebarFilter } from '../../../types/files';

function isSameFilter(a: SidebarFilter, b: SidebarFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'bucket' && b.kind === 'bucket') return a.bucketId === b.bucketId;
  return true;
}

interface SidebarRowProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number | null;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  trailing?: React.ReactNode;
}

function SidebarRow({ active, icon, label, count, onClick, onContextMenu, trailing }: SidebarRowProps) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={clsx(
        'group w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors cursor-pointer',
        active
          ? 'bg-accent/10 text-text-primary'
          : 'text-text-secondary hover:bg-white/[0.03] hover:text-text-primary',
      )}
    >
      <span className={clsx('flex-shrink-0', active ? 'text-accent' : 'text-text-tertiary')}>
        {icon}
      </span>
      <span className="text-[13px] truncate flex-1">{label}</span>
      {count != null && count > 0 && (
        <span className="text-[10px] tabular-nums text-text-tertiary">{count}</span>
      )}
      {trailing}
    </button>
  );
}

function SectionHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pt-3 pb-1">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary select-none">
        {label}
      </span>
      {action}
    </div>
  );
}

interface FilesSidebarProps {
  onCreateBucket: () => void;
  onBucketContextMenu: (bucket: Bucket, e: React.MouseEvent) => void;
}

export default function FilesSidebar({ onCreateBucket, onBucketContextMenu }: FilesSidebarProps) {
  const { t } = useTranslation();
  const { buckets, activeFilter, setActiveFilter } = useFiles();
  const [hoveredBucketId, setHoveredBucketId] = useState<string | null>(null);

  const sortedBuckets = useMemo(
    () => [...buckets].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    }),
    [buckets],
  );

  return (
    <div className="w-[220px] flex-shrink-0 border-r border-border-subtle bg-bg-surface/50 flex flex-col min-h-0 overflow-y-auto py-1.5">
      <div className="px-2.5">
        <SidebarRow
          active={activeFilter.kind === 'recent'}
          icon={<Clock size={14} />}
          label={t('files.sectionRecent')}
          onClick={() => setActiveFilter({ kind: 'recent' })}
        />
        <SidebarRow
          active={activeFilter.kind === 'starred'}
          icon={<Star size={14} />}
          label={t('files.sectionStarred')}
          onClick={() => setActiveFilter({ kind: 'starred' })}
        />
      </div>

      <SectionHeader
        label={t('files.sectionBuckets')}
        action={(
          <button
            onClick={onCreateBucket}
            className="p-1 rounded text-text-tertiary hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
            title={t('files.newBucket')}
          >
            <Plus size={12} />
          </button>
        )}
      />

      <div className="px-2.5">
        {sortedBuckets.map((bucket) => {
          const isActive = isSameFilter(activeFilter, { kind: 'bucket', bucketId: bucket.id });
          const labelOverride = bucket.isDefault ? t('files.bucketDefault') : bucket.name;
          return (
            <div
              key={bucket.id}
              onMouseEnter={() => setHoveredBucketId(bucket.id)}
              onMouseLeave={() => setHoveredBucketId(null)}
            >
              <SidebarRow
                active={isActive}
                icon={isActive ? <FolderOpen size={14} /> : <Folder size={14} />}
                label={labelOverride}
                count={bucket.fileCount}
                onClick={() => setActiveFilter({ kind: 'bucket', bucketId: bucket.id })}
                onContextMenu={(e) => onBucketContextMenu(bucket, e)}
                trailing={(!bucket.isDefault && hoveredBucketId === bucket.id) ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); onBucketContextMenu(bucket, e); }}
                    className="p-0.5 rounded text-text-tertiary hover:text-text-primary hover:bg-white/[0.06]"
                  >
                    <MoreHorizontal size={12} />
                  </button>
                ) : undefined}
              />
            </div>
          );
        })}
        <SidebarRow
          active={activeFilter.kind === 'unfiled'}
          icon={<Inbox size={14} />}
          label={t('files.sourceUnfiled')}
          onClick={() => setActiveFilter({ kind: 'unfiled' })}
        />
      </div>

      <SectionHeader label={t('files.sectionSources')} />

      <div className="px-2.5">
        <SidebarRow
          active={activeFilter.kind === 'workspaces'}
          icon={<Briefcase size={14} />}
          label={t('files.sourceWorkspaces')}
          onClick={() => setActiveFilter({ kind: 'workspaces' })}
        />
        <SidebarRow
          active={activeFilter.kind === 'trash'}
          icon={<Trash2 size={14} />}
          label={t('files.sourceTrash')}
          onClick={() => setActiveFilter({ kind: 'trash' })}
        />
      </div>
    </div>
  );
}
