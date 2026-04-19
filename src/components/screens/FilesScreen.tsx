import { useEffect, useMemo, useState, useCallback, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  Upload,
  Plus,
  Grid3x3,
  List as ListIcon,
  ArrowUpDown,
  Trash2,
  ArrowRight,
  Copy as CopyIcon,
  FolderOpen,
} from 'lucide-react';
import { useFiles } from '../../context/FilesContext';
import type { Bucket, FileItem, FilesSortKey } from '../../types/files';
import FilesSidebar from './files/FilesSidebar';
import FileGrid from './files/FileGrid';
import FileList from './files/FileList';
import FilePreviewDrawer from './files/FilePreviewDrawer';
import FileContextMenu from './files/FileContextMenu';
import CreateBucketModal from './files/CreateBucketModal';
import MoveCopyDialog from './files/MoveCopyDialog';
import WorkspaceFilesView from './files/WorkspaceFilesView';
import AlertModal from '../ui/AlertModal';

interface ContextMenuState {
  item: FileItem;
  x: number;
  y: number;
}

interface RenameState {
  item: FileItem;
  draft: string;
}

export default function FilesScreen() {
  const { t } = useTranslation();
  const {
    items,
    activeFilter,
    setActiveFilter,
    viewMode,
    setViewMode,
    sortKey,
    setSortKey,
    selectedItemIds,
    toggleSelected,
    clearSelection,
    isLoading,
    buckets,
    defaultBucket,
    uploadFiles,
    refreshItems,
    moveItems,
    copyItems,
    starItem,
    softDelete,
    restore,
    hardDelete,
    emptyTrash,
    touchItem,
    renameItem,
    renameBucket,
    deleteBucket,
  } = useFiles();

  const [previewItem, setPreviewItem] = useState<FileItem | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [showCreateBucket, setShowCreateBucket] = useState(false);
  const [moveCopyMode, setMoveCopyMode] = useState<'move' | 'copy' | null>(null);
  const [bucketContextMenu, setBucketContextMenu] = useState<{ bucket: Bucket; x: number; y: number } | null>(null);
  const [pendingDeleteBucket, setPendingDeleteBucket] = useState<Bucket | null>(null);
  const [renameState, setRenameState] = useState<RenameState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isSortMenuOpen, setSortMenuOpen] = useState(false);

  const isTrash = activeFilter.kind === 'trash';
  const isWorkspaces = activeFilter.kind === 'workspaces';

  const headerLabel = useMemo(() => {
    if (activeFilter.kind === 'recent') return t('files.sectionRecent');
    if (activeFilter.kind === 'starred') return t('files.sectionStarred');
    if (activeFilter.kind === 'trash') return t('files.sourceTrash');
    if (activeFilter.kind === 'workspaces') return t('files.sourceWorkspaces');
    if (activeFilter.kind === 'unfiled') return t('files.sourceUnfiled');
    if (activeFilter.kind === 'bucket') {
      const bucket = buckets.find((b) => b.id === activeFilter.bucketId);
      if (!bucket) return t('files.title');
      return bucket.isDefault ? t('files.bucketDefault') : bucket.name;
    }
    return t('files.title');
  }, [activeFilter, buckets, t]);

  const targetBucketId: string | null = useMemo(() => {
    if (activeFilter.kind === 'bucket') return activeFilter.bucketId;
    return defaultBucket?.id ?? null;
  }, [activeFilter, defaultBucket]);

  // Selection
  const selectedItems = useMemo(
    () => items.filter((it) => selectedItemIds.has(it.id)),
    [items, selectedItemIds],
  );

  const handleSelect = (id: string, e: React.MouseEvent) => {
    toggleSelected(id, { multi: e.metaKey || e.ctrlKey || e.shiftKey });
  };

  const handleOpen = useCallback(async (item: FileItem) => {
    setPreviewItem(item);
    if (item.storageKind === 'managed') {
      touchItem(item.id).catch(() => undefined);
    }
  }, [touchItem]);

  const handleContextMenu = (item: FileItem, e: React.MouseEvent) => {
    e.preventDefault();
    if (!selectedItemIds.has(item.id)) {
      toggleSelected(item.id);
    }
    setContextMenu({ item, x: e.clientX, y: e.clientY });
  };

  const handlePickFiles = async () => {
    const paths = await window.cerebro.files.pickFiles();
    if (paths.length === 0) return;
    await uploadFiles(paths, targetBucketId);
  };

  // Drag & drop import
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      setIsDragging(true);
    }
  };
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const paths = files
      .map((f) => window.cerebro.getPathForFile(f))
      .filter((p) => !!p);
    if (paths.length > 0) await uploadFiles(paths, targetBucketId);
  };

  const sortLabel = useMemo(() => {
    switch (sortKey) {
      case 'name': return t('files.sortName');
      case 'updated': return t('files.sortUpdated');
      case 'opened': return t('files.sortOpened');
      default: return t('files.sortNewest');
    }
  }, [sortKey, t]);

  const handleSortPick = (key: FilesSortKey) => {
    setSortKey(key);
    setSortMenuOpen(false);
  };

  useEffect(() => { refreshItems().catch(() => undefined); }, [refreshItems]);

  // Close preview if its item disappears (e.g., trashed)
  useEffect(() => {
    if (!previewItem) return;
    if (!items.some((it) => it.id === previewItem.id)) setPreviewItem(null);
  }, [items, previewItem]);

  // Handle rename submission
  const handleRenameSubmit = async () => {
    if (!renameState) return;
    const next = renameState.draft.trim();
    if (next && next !== renameState.item.name) {
      await renameItem(renameState.item.id, next);
    }
    setRenameState(null);
  };

  return (
    <div className="flex-1 flex min-h-0">
      <FilesSidebar
        onCreateBucket={() => setShowCreateBucket(true)}
        onBucketContextMenu={(bucket, e) => {
          e.preventDefault();
          if (bucket.isDefault) return;
          setBucketContextMenu({ bucket, x: e.clientX, y: e.clientY });
        }}
      />

      <div
        className="flex-1 flex flex-col min-h-0 relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!isWorkspaces && <div className="app-drag-region h-11 flex-shrink-0" />}
        {/* Header */}
        {!isWorkspaces && (
        <div className="flex items-center justify-between gap-3 px-5 h-[60px] flex-shrink-0 border-b border-border-subtle">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="text-base font-semibold text-text-primary truncate">{headerLabel}</h1>
            {selectedItems.length > 0 && (
              <span className="text-[11px] text-text-tertiary">
                {t('files.selectionCount', { count: selectedItems.length })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {selectedItems.length > 0 && !isTrash && !isWorkspaces && (
              <>
                <button
                  onClick={() => setMoveCopyMode('move')}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer flex items-center gap-1.5"
                >
                  <ArrowRight size={12} /> {t('files.actionMove').replace('\u2026', '')}
                </button>
                <button
                  onClick={() => setMoveCopyMode('copy')}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer flex items-center gap-1.5"
                >
                  <CopyIcon size={12} /> {t('files.actionCopy').replace('\u2026', '')}
                </button>
                <button
                  onClick={() => softDelete(Array.from(selectedItemIds))}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-md text-red-400 hover:bg-red-400/10 cursor-pointer flex items-center gap-1.5"
                >
                  <Trash2 size={12} /> {t('files.actionDelete')}
                </button>
              </>
            )}
            {isTrash && (
              <button
                onClick={emptyTrash}
                className="px-2.5 py-1.5 text-[11px] font-medium rounded-md text-red-400 hover:bg-red-400/10 cursor-pointer flex items-center gap-1.5"
              >
                <Trash2 size={12} /> {t('files.actionEmptyTrash')}
              </button>
            )}
            {!isWorkspaces && (
              <>
                <div className="relative">
                  <button
                    onClick={() => setSortMenuOpen((v) => !v)}
                    className="px-2.5 py-1.5 text-[11px] font-medium rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer flex items-center gap-1.5"
                  >
                    <ArrowUpDown size={12} /> {sortLabel}
                  </button>
                  {isSortMenuOpen && (
                    <div className="absolute right-0 top-full mt-1 z-10 bg-bg-surface border border-border-subtle rounded-lg shadow-xl py-1 min-w-[160px]">
                      {(['created', 'updated', 'name', 'opened'] as FilesSortKey[]).map((key) => (
                        <button
                          key={key}
                          onClick={() => handleSortPick(key)}
                          className={clsx(
                            'w-full text-left px-3 py-1.5 text-[12px] cursor-pointer hover:bg-white/[0.04]',
                            sortKey === key ? 'text-accent' : 'text-text-secondary',
                          )}
                        >
                          {key === 'created' && t('files.sortNewest')}
                          {key === 'updated' && t('files.sortUpdated')}
                          {key === 'name' && t('files.sortName')}
                          {key === 'opened' && t('files.sortOpened')}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5 border border-border-subtle">
                  <button
                    onClick={() => setViewMode('grid')}
                    title={t('files.viewGrid')}
                    className={clsx(
                      'p-1 rounded cursor-pointer transition-colors',
                      viewMode === 'grid' ? 'bg-accent/15 text-accent' : 'text-text-tertiary hover:text-text-primary',
                    )}
                  >
                    <Grid3x3 size={12} />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    title={t('files.viewList')}
                    className={clsx(
                      'p-1 rounded cursor-pointer transition-colors',
                      viewMode === 'list' ? 'bg-accent/15 text-accent' : 'text-text-tertiary hover:text-text-primary',
                    )}
                  >
                    <ListIcon size={12} />
                  </button>
                </div>
              </>
            )}
            {!isTrash && !isWorkspaces && (
              <>
                <button
                  onClick={() => setShowCreateBucket(true)}
                  className="px-2.5 py-1.5 text-[11px] font-medium rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer flex items-center gap-1.5"
                >
                  <Plus size={12} /> {t('files.newBucket')}
                </button>
                <button
                  onClick={handlePickFiles}
                  className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer flex items-center gap-1.5"
                >
                  <Upload size={12} /> {t('files.upload')}
                </button>
              </>
            )}
          </div>
        </div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col">
          {isWorkspaces ? (
            <WorkspaceFilesView />
          ) : items.length === 0 ? (
            <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-text-tertiary">
              {isTrash ? (
                <>
                  <Trash2 size={36} className="opacity-30" />
                  <p className="text-sm text-text-secondary">{t('files.emptyTrash')}</p>
                  <p className="text-xs max-w-sm text-center">{t('files.emptyTrashHint')}</p>
                </>
              ) : (
                <>
                  <FolderOpen size={36} className="opacity-30" />
                  <p className="text-sm text-text-secondary">{t('files.emptyTitle')}</p>
                  <p className="text-xs max-w-sm text-center">{t('files.emptyHint')}</p>
                  <button
                    onClick={handlePickFiles}
                    className="mt-2 px-3 py-1.5 text-[11px] font-medium rounded-md bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer flex items-center gap-1.5"
                  >
                    <Upload size={12} /> {t('files.upload')}
                  </button>
                </>
              )}
            </div>
          ) : viewMode === 'grid' ? (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FileGrid
                items={items}
                selectedItemIds={selectedItemIds}
                onSelect={handleSelect}
                onOpen={handleOpen}
                onContextMenu={handleContextMenu}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <FileList
                items={items}
                selectedItemIds={selectedItemIds}
                onSelect={handleSelect}
                onOpen={handleOpen}
                onContextMenu={handleContextMenu}
              />
            </div>
          )}
        </div>

        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-20 bg-accent/10 border-2 border-dashed border-accent/40 flex items-center justify-center pointer-events-none">
            <div className="px-5 py-3 rounded-lg bg-bg-surface/95 border border-accent/30 text-sm text-text-primary shadow-xl">
              {t('files.dropOverlay', {
                bucket: activeFilter.kind === 'bucket'
                  ? buckets.find((b) => b.id === activeFilter.bucketId)?.name ?? t('files.bucketDefault')
                  : t('files.bucketDefault'),
              })}
            </div>
          </div>
        )}

        {/* Loading veil */}
        {isLoading && items.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-text-tertiary pointer-events-none">
            {t('common.loading')}
          </div>
        )}
      </div>

      {/* Right preview drawer */}
      {previewItem && (
        <FilePreviewDrawer item={previewItem} onClose={() => setPreviewItem(null)} />
      )}

      {/* Item context menu */}
      {contextMenu && (
        <FileContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          item={contextMenu.item}
          isTrashed={isTrash}
          onClose={() => setContextMenu(null)}
          onPreview={handleOpen}
          onOpen={(item) => window.cerebro.files.open({
            storageKind: item.storageKind,
            storagePath: item.storagePath,
            taskId: item.sourceTaskId,
          })}
          onReveal={(item) => window.cerebro.files.reveal({
            storageKind: item.storageKind,
            storagePath: item.storagePath,
            taskId: item.sourceTaskId,
          })}
          onRename={(item) => setRenameState({ item, draft: item.name })}
          onMove={() => setMoveCopyMode('move')}
          onCopy={() => setMoveCopyMode('copy')}
          onStar={(item) => starItem(item.id, !item.starred)}
          onDownload={(item) => window.cerebro.files.download({
            storageKind: item.storageKind,
            storagePath: item.storagePath,
            taskId: item.sourceTaskId,
          })}
          onSoftDelete={() => softDelete(Array.from(selectedItemIds.size > 0 ? selectedItemIds : [contextMenu.item.id]))}
          onRestore={() => restore(Array.from(selectedItemIds.size > 0 ? selectedItemIds : [contextMenu.item.id]))}
          onHardDelete={() => hardDelete(Array.from(selectedItemIds.size > 0 ? selectedItemIds : [contextMenu.item.id]))}
        />
      )}

      {/* Bucket context menu (rename/delete) */}
      {bucketContextMenu && (
        <div
          style={{ left: bucketContextMenu.x, top: bucketContextMenu.y }}
          className="fixed z-50 min-w-[160px] bg-bg-surface border border-border-subtle rounded-lg shadow-xl py-1 animate-fade-in"
          onMouseLeave={() => setBucketContextMenu(null)}
        >
          <button
            onClick={() => {
              const next = window.prompt(t('files.actionRename'), bucketContextMenu.bucket.name);
              if (next && next.trim()) {
                renameBucket(bucketContextMenu.bucket.id, next.trim()).catch(() => undefined);
              }
              setBucketContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-white/[0.04] hover:text-text-primary cursor-pointer"
          >
            {t('files.actionRename')}
          </button>
          <button
            onClick={() => {
              setPendingDeleteBucket(bucketContextMenu.bucket);
              setBucketContextMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-400/10 cursor-pointer"
          >
            {t('files.deleteBucketTitle')}
          </button>
        </div>
      )}

      {/* Modals */}
      {showCreateBucket && (
        <CreateBucketModal
          onClose={() => setShowCreateBucket(false)}
          onCreated={(bucketId) => setActiveFilter({ kind: 'bucket', bucketId })}
        />
      )}

      {moveCopyMode && selectedItems.length > 0 && (
        <MoveCopyDialog
          mode={moveCopyMode}
          count={selectedItems.length}
          onClose={() => setMoveCopyMode(null)}
          onConfirm={async (bucketId) => {
            const ids = Array.from(selectedItemIds);
            if (moveCopyMode === 'move') await moveItems(ids, bucketId);
            else await copyItems(ids, bucketId);
            clearSelection();
          }}
        />
      )}

      {pendingDeleteBucket && (
        <AlertModal
          icon={<Trash2 size={18} className="text-red-400" />}
          iconTone="danger"
          title={t('files.deleteBucketTitle')}
          message={t('files.deleteBucketBody')}
          onClose={() => setPendingDeleteBucket(null)}
          actions={[
            { label: t('common.cancel'), onClick: () => setPendingDeleteBucket(null) },
            {
              label: t('common.delete'),
              primary: true,
              variant: 'danger',
              onClick: async () => {
                await deleteBucket(pendingDeleteBucket.id, defaultBucket?.id ?? null);
                setPendingDeleteBucket(null);
              },
            },
          ]}
        />
      )}

      {renameState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setRenameState(null)} />
          <div className="relative bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-full max-w-sm mx-4 p-5 animate-fade-in">
            <h3 className="text-sm font-medium text-text-primary mb-3">{t('files.actionRename')}</h3>
            <input
              autoFocus
              type="text"
              value={renameState.draft}
              onChange={(e) => setRenameState({ ...renameState, draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit();
                if (e.key === 'Escape') setRenameState(null);
              }}
              className="w-full px-3 py-2 rounded-md bg-bg-base border border-border-subtle text-sm text-text-primary focus:outline-none focus:border-accent/40"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setRenameState(null)}
                className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleRenameSubmit}
                className="px-3 py-1.5 rounded-md text-xs bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
