import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type ApiBucket,
  type ApiFileItem,
  type Bucket,
  type FileItem,
  type FilesSortKey,
  type FilesViewMode,
  type FileSource,
  type SidebarFilter,
  type StorageKind,
  bucketFromApi,
  fileItemFromApi,
} from '../types/files';
import { loadSetting, saveSetting } from '../lib/settings';
import { useToast } from './ToastContext';

const SETTING_VIEW_MODE = 'files_view_mode';
const SETTING_SORT_KEY = 'files_sort_key';
const SETTING_LAST_FILTER = 'files_last_filter';

function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

interface SaveExternalArgs {
  sourcePath: string;
  source: FileSource;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  sourceTaskId?: string | null;
  bucketId?: string | null;
  // Optional explicit display name (defaults to basename of sourcePath)
  displayName?: string;
}

interface FilesContextValue {
  buckets: Bucket[];
  defaultBucket: Bucket | null;
  items: FileItem[];
  activeFilter: SidebarFilter;
  viewMode: FilesViewMode;
  sortKey: FilesSortKey;
  selectedItemIds: Set<string>;
  isLoading: boolean;

  setActiveFilter: (filter: SidebarFilter) => void;
  setViewMode: (mode: FilesViewMode) => void;
  setSortKey: (key: FilesSortKey) => void;
  setSelectedItemIds: (ids: Set<string>) => void;
  toggleSelected: (id: string, opts?: { multi?: boolean }) => void;
  clearSelection: () => void;

  refreshBuckets: () => Promise<void>;
  refreshItems: () => Promise<void>;

  createBucket: (args: { name: string; color?: string | null; icon?: string | null }) => Promise<Bucket | null>;
  renameBucket: (bucketId: string, name: string) => Promise<void>;
  updateBucket: (bucketId: string, patch: Partial<Pick<Bucket, 'name' | 'color' | 'icon' | 'isPinned'>>) => Promise<void>;
  deleteBucket: (bucketId: string, reassignTo?: string | null) => Promise<void>;

  uploadFiles: (sourcePaths: string[], bucketId: string | null) => Promise<FileItem[]>;
  saveExternalToFiles: (args: SaveExternalArgs) => Promise<FileItem | null>;
  renameItem: (id: string, name: string) => Promise<void>;
  moveItems: (ids: string[], bucketId: string | null) => Promise<void>;
  copyItems: (ids: string[], bucketId: string | null) => Promise<void>;
  starItem: (id: string, starred: boolean) => Promise<void>;
  softDelete: (ids: string[]) => Promise<void>;
  restore: (ids: string[]) => Promise<void>;
  hardDelete: (ids: string[]) => Promise<void>;
  emptyTrash: () => Promise<void>;
  touchItem: (id: string) => Promise<void>;
}

const FilesContext = createContext<FilesContextValue | null>(null);

export function FilesProvider({ children }: { children: ReactNode }) {
  const { addToast } = useToast();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [items, setItems] = useState<FileItem[]>([]);
  const [activeFilter, setActiveFilterState] = useState<SidebarFilter>({ kind: 'recent' });
  const [viewMode, setViewModeState] = useState<FilesViewMode>('grid');
  const [sortKey, setSortKeyState] = useState<FilesSortKey>('created');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);

  const defaultBucket = useMemo(
    () => buckets.find((b) => b.isDefault) ?? null,
    [buckets],
  );

  // Load persisted preferences on mount
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadSetting<FilesViewMode>(SETTING_VIEW_MODE),
      loadSetting<FilesSortKey>(SETTING_SORT_KEY),
      loadSetting<SidebarFilter>(SETTING_LAST_FILTER),
    ]).then(([vm, sk, filter]) => {
      if (cancelled) return;
      if (vm === 'grid' || vm === 'list') setViewModeState(vm);
      if (sk === 'created' || sk === 'updated' || sk === 'name' || sk === 'opened') setSortKeyState(sk);
      if (filter && typeof filter === 'object' && 'kind' in filter) {
        setActiveFilterState(filter);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const setActiveFilter = useCallback((filter: SidebarFilter) => {
    setActiveFilterState(filter);
    setSelectedItemIds(new Set());
    saveSetting(SETTING_LAST_FILTER, filter);
  }, []);

  const setViewMode = useCallback((mode: FilesViewMode) => {
    setViewModeState(mode);
    saveSetting(SETTING_VIEW_MODE, mode);
  }, []);

  const setSortKey = useCallback((key: FilesSortKey) => {
    setSortKeyState(key);
    saveSetting(SETTING_SORT_KEY, key);
  }, []);

  const toggleSelected = useCallback((id: string, opts?: { multi?: boolean }) => {
    setSelectedItemIds((prev) => {
      const next = new Set(opts?.multi ? prev : []);
      if (prev.has(id) && opts?.multi) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedItemIds(new Set()), []);

  const refreshBuckets = useCallback(async () => {
    const res = await window.cerebro.invoke<ApiBucket[]>({
      method: 'GET',
      path: '/files/buckets',
    });
    if (res.ok && Array.isArray(res.data)) {
      setBuckets(res.data.map(bucketFromApi));
    }
  }, []);

  const refreshItems = useCallback(async () => {
    setIsLoading(true);
    try {
      let path: string;
      if (activeFilter.kind === 'recent') {
        path = `/files/items/recent?limit=50`;
      } else if (activeFilter.kind === 'starred') {
        path = `/files/items?starred=true&order=${sortKey}`;
      } else if (activeFilter.kind === 'trash') {
        path = `/files/items?only_deleted=true&order=updated`;
      } else if (activeFilter.kind === 'workspaces') {
        path = `/files/items?storage_kind=workspace&order=${sortKey}`;
      } else if (activeFilter.kind === 'unfiled') {
        path = `/files/items?unfiled=true&order=${sortKey}`;
      } else {
        path = `/files/items?bucket_id=${activeFilter.bucketId}&order=${sortKey}`;
      }
      const res = await window.cerebro.invoke<ApiFileItem[]>({ method: 'GET', path });
      if (res.ok && Array.isArray(res.data)) {
        setItems(res.data.map(fileItemFromApi));
      } else {
        setItems([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [activeFilter, sortKey]);

  // Buckets load at startup so chat's "Save to Files" can resolve the default
  // bucket without waiting. Items only fetch once a consumer has opened the
  // Files screen — the FilesScreen useEffect calls refreshItems on mount.
  useEffect(() => {
    refreshBuckets().catch(console.error);
  }, [refreshBuckets]);

  // Re-fetch items whenever the filter or sort changes — but only after the
  // first explicit refresh, so the provider doesn't fire a hot-path query on
  // app startup before the user navigates to Files.
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (!hasFetchedRef.current) return;
    refreshItems().catch(console.error);
  }, [refreshItems]);

  const refreshItemsExplicit = useCallback(async () => {
    hasFetchedRef.current = true;
    await refreshItems();
  }, [refreshItems]);

  const createBucket = useCallback<FilesContextValue['createBucket']>(async ({ name, color, icon }) => {
    const res = await window.cerebro.invoke<ApiBucket>({
      method: 'POST',
      path: '/files/buckets',
      body: { name, color: color ?? null, icon: icon ?? null, is_pinned: false },
    });
    if (!res.ok) {
      addToast('Failed to create bucket', 'error');
      return null;
    }
    const created = bucketFromApi(res.data);
    setBuckets((prev) => [...prev, created]);
    return created;
  }, [addToast]);

  const updateBucket = useCallback<FilesContextValue['updateBucket']>(async (bucketId, patch) => {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.color !== undefined) body.color = patch.color;
    if (patch.icon !== undefined) body.icon = patch.icon;
    if (patch.isPinned !== undefined) body.is_pinned = patch.isPinned;
    const res = await window.cerebro.invoke<ApiBucket>({
      method: 'PATCH',
      path: `/files/buckets/${bucketId}`,
      body,
    });
    if (!res.ok) {
      addToast('Failed to update bucket', 'error');
      return;
    }
    const updated = bucketFromApi(res.data);
    setBuckets((prev) => prev.map((b) => (b.id === bucketId ? updated : b)));
  }, [addToast]);

  const renameBucket = useCallback(async (bucketId: string, name: string) => {
    await updateBucket(bucketId, { name });
  }, [updateBucket]);

  const deleteBucket = useCallback<FilesContextValue['deleteBucket']>(async (bucketId, reassignTo) => {
    const target = buckets.find((b) => b.id === bucketId);
    if (target?.isDefault) {
      addToast('The Default bucket cannot be deleted', 'error');
      return;
    }
    const qs = reassignTo ? `?reassign_to=${reassignTo}` : '';
    const res = await window.cerebro.invoke({
      method: 'DELETE',
      path: `/files/buckets/${bucketId}${qs}`,
    });
    if (!res.ok) {
      addToast('Failed to delete bucket', 'error');
      return;
    }
    setBuckets((prev) => prev.filter((b) => b.id !== bucketId));
    // If the active bucket was deleted, fall back to Recent.
    if (activeFilter.kind === 'bucket' && activeFilter.bucketId === bucketId) {
      setActiveFilter({ kind: 'recent' });
    } else {
      refreshItems();
    }
  }, [activeFilter, addToast, buckets, refreshItems, setActiveFilter]);

  const registerItem = useCallback(async (params: {
    bucketId: string | null;
    name: string;
    ext: string;
    mime: string | null;
    sizeBytes: number;
    sha256: string | null;
    storageKind: StorageKind;
    storagePath: string;
    source: FileSource;
    sourceConversationId?: string | null;
    sourceMessageId?: string | null;
    sourceTaskId?: string | null;
  }): Promise<FileItem | null> => {
    const res = await window.cerebro.invoke<ApiFileItem>({
      method: 'POST',
      path: '/files/items',
      body: {
        bucket_id: params.bucketId,
        name: params.name,
        ext: params.ext,
        mime: params.mime,
        size_bytes: params.sizeBytes,
        sha256: params.sha256,
        storage_kind: params.storageKind,
        storage_path: params.storagePath,
        source: params.source,
        source_conversation_id: params.sourceConversationId ?? null,
        source_message_id: params.sourceMessageId ?? null,
        source_task_id: params.sourceTaskId ?? null,
      },
    });
    if (!res.ok) {
      addToast('Failed to register file', 'error');
      return null;
    }
    return fileItemFromApi(res.data);
  }, [addToast]);

  const importOne = useCallback(async (
    sourcePath: string,
    bucketId: string,
    args: {
      name?: string;
      source: FileSource;
      sourceConversationId?: string | null;
      sourceMessageId?: string | null;
      sourceTaskId?: string | null;
    },
  ): Promise<FileItem | null> => {
    const baseName = args.name ?? sourcePath.split('/').pop() ?? 'untitled';
    const ext = extOf(baseName);
    const fileId = newId();
    const importRes = await window.cerebro.files.importToBucket({
      sourcePath,
      bucketId,
      fileId,
      destExt: ext,
    });
    return registerItem({
      bucketId,
      name: baseName,
      ext,
      mime: importRes.mime,
      sizeBytes: importRes.sizeBytes,
      sha256: importRes.sha256,
      storageKind: 'managed',
      storagePath: importRes.destRelPath,
      source: args.source,
      sourceConversationId: args.sourceConversationId,
      sourceMessageId: args.sourceMessageId,
      sourceTaskId: args.sourceTaskId,
    });
  }, [registerItem]);

  const uploadFiles = useCallback<FilesContextValue['uploadFiles']>(async (sourcePaths, bucketIdArg) => {
    const targetBucket = bucketIdArg ?? defaultBucket?.id;
    if (!targetBucket) {
      addToast('Default bucket not ready yet — try again', 'error');
      return [];
    }
    const results = await Promise.all(sourcePaths.map(async (src) => {
      try {
        return await importOne(src, targetBucket, { source: 'upload' });
      } catch (err) {
        console.error('[files] upload failed for', src, err);
        addToast(`Upload failed: ${src.split('/').pop()}`, 'error');
        return null;
      }
    }));
    const created = results.filter((it): it is FileItem => it !== null);
    if (created.length > 0) {
      addToast(`Saved ${created.length} file${created.length === 1 ? '' : 's'} to Files`, 'success');
      await Promise.all([refreshBuckets(), refreshItems()]);
    }
    return created;
  }, [addToast, defaultBucket, importOne, refreshBuckets, refreshItems]);

  const saveExternalToFiles = useCallback<FilesContextValue['saveExternalToFiles']>(async (args) => {
    const targetBucket = args.bucketId ?? defaultBucket?.id;
    if (!targetBucket) {
      addToast('Default bucket not ready yet — try again', 'error');
      return null;
    }
    const item = await importOne(args.sourcePath, targetBucket, {
      name: args.displayName,
      source: args.source,
      sourceConversationId: args.sourceConversationId,
      sourceMessageId: args.sourceMessageId,
      sourceTaskId: args.sourceTaskId,
    });
    if (item) {
      addToast('Saved to Files → Default', 'success');
      await Promise.all([refreshBuckets(), refreshItems()]);
    }
    return item;
  }, [addToast, defaultBucket, importOne, refreshBuckets, refreshItems]);

  const patchItem = useCallback(async (id: string, body: Record<string, unknown>) => {
    const res = await window.cerebro.invoke<ApiFileItem>({
      method: 'PATCH',
      path: `/files/items/${id}`,
      body,
    });
    if (!res.ok) {
      addToast('Update failed', 'error');
      return null;
    }
    return fileItemFromApi(res.data);
  }, [addToast]);

  const renameItem = useCallback(async (id: string, name: string) => {
    const updated = await patchItem(id, { name });
    if (updated) setItems((prev) => prev.map((it) => (it.id === id ? updated : it)));
  }, [patchItem]);

  const moveItems = useCallback<FilesContextValue['moveItems']>(async (ids, bucketId) => {
    await Promise.all(ids.map((id) => patchItem(id, { bucket_id: bucketId })));
    await Promise.all([refreshBuckets(), refreshItems()]);
  }, [patchItem, refreshBuckets, refreshItems]);

  const copyItems = useCallback<FilesContextValue['copyItems']>(async (ids, bucketIdArg) => {
    const targetBucket = bucketIdArg ?? defaultBucket?.id;
    if (!targetBucket) {
      addToast('Pick a bucket to copy into', 'error');
      return;
    }
    const results = await Promise.all(ids.map(async (id) => {
      const src = items.find((it) => it.id === id);
      if (!src) return null;
      try {
        if (src.storageKind === 'managed') {
          const newFileId = newId();
          const ipcResult = await window.cerebro.files.copyManaged({
            srcRelPath: src.storagePath,
            destBucketId: targetBucket,
            destFileId: newFileId,
            destExt: src.ext,
          });
          const res = await window.cerebro.invoke<ApiFileItem>({
            method: 'POST',
            path: `/files/items/${id}/copy`,
            body: { bucket_id: targetBucket, new_storage_path: ipcResult.destRelPath },
          });
          return res.ok ? true : null;
        }
        // Workspace storage_path may be either absolute or relative to the task's workspace dir.
        const sourceAbs = src.storagePath.startsWith('/')
          ? src.storagePath
          : src.sourceTaskId
            ? `${await window.cerebro.taskTerminal.getWorkspacePath(src.sourceTaskId)}/${src.storagePath}`
            : src.storagePath;
        const item = await importOne(sourceAbs, targetBucket, {
          name: src.name,
          source: 'workspace-save',
          sourceTaskId: src.sourceTaskId,
        });
        return item ? true : null;
      } catch (err) {
        console.error('[files] copy failed for', id, err);
        return null;
      }
    }));
    const copied = results.filter(Boolean).length;
    if (copied > 0) {
      addToast(`Copied ${copied} file${copied === 1 ? '' : 's'}`, 'success');
      await Promise.all([refreshBuckets(), refreshItems()]);
    }
  }, [addToast, defaultBucket, importOne, items, refreshBuckets, refreshItems]);

  const starItem = useCallback(async (id: string, starred: boolean) => {
    const updated = await patchItem(id, { starred });
    if (updated) setItems((prev) => prev.map((it) => (it.id === id ? updated : it)));
  }, [patchItem]);

  const softDelete = useCallback<FilesContextValue['softDelete']>(async (ids) => {
    await Promise.all(ids.map((id) =>
      window.cerebro.invoke({ method: 'DELETE', path: `/files/items/${id}` })
    ));
    await Promise.all([refreshBuckets(), refreshItems()]);
    clearSelection();
  }, [clearSelection, refreshBuckets, refreshItems]);

  const restore = useCallback<FilesContextValue['restore']>(async (ids) => {
    await Promise.all(ids.map((id) => patchItem(id, { restore: true })));
    await refreshItems();
    clearSelection();
  }, [clearSelection, patchItem, refreshItems]);

  const hardDelete = useCallback<FilesContextValue['hardDelete']>(async (ids) => {
    const toUnlink = ids
      .map((id) => items.find((i) => i.id === id))
      .filter((it): it is FileItem => !!it && it.storageKind === 'managed')
      .map((it) => it.storagePath);
    await Promise.all(ids.map((id) =>
      window.cerebro.invoke({ method: 'DELETE', path: `/files/items/${id}?hard=true` })
    ));
    if (toUnlink.length > 0) {
      await window.cerebro.files.deleteManagedBatch(toUnlink);
    }
    await refreshItems();
    clearSelection();
  }, [clearSelection, items, refreshItems]);

  const emptyTrash = useCallback(async () => {
    const res = await window.cerebro.invoke<string[]>({
      method: 'POST',
      path: '/files/trash/empty',
    });
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      await window.cerebro.files.deleteManagedBatch(res.data);
    }
    await Promise.all([refreshBuckets(), refreshItems()]);
    clearSelection();
    addToast('Trash emptied', 'success');
  }, [addToast, clearSelection, refreshBuckets, refreshItems]);

  const touchItem = useCallback(async (id: string) => {
    await window.cerebro.invoke({ method: 'POST', path: `/files/items/${id}/touch` });
  }, []);

  const value = useMemo<FilesContextValue>(() => ({
    buckets,
    defaultBucket,
    items,
    activeFilter,
    viewMode,
    sortKey,
    selectedItemIds,
    isLoading,
    setActiveFilter,
    setViewMode,
    setSortKey,
    setSelectedItemIds,
    toggleSelected,
    clearSelection,
    refreshBuckets,
    refreshItems: refreshItemsExplicit,
    createBucket,
    renameBucket,
    updateBucket,
    deleteBucket,
    uploadFiles,
    saveExternalToFiles,
    renameItem,
    moveItems,
    copyItems,
    starItem,
    softDelete,
    restore,
    hardDelete,
    emptyTrash,
    touchItem,
  }), [
    buckets, defaultBucket, items, activeFilter, viewMode, sortKey, selectedItemIds, isLoading,
    setActiveFilter, setViewMode, setSortKey, toggleSelected, clearSelection,
    refreshBuckets, refreshItemsExplicit, createBucket, renameBucket, updateBucket, deleteBucket,
    uploadFiles, saveExternalToFiles, renameItem, moveItems, copyItems, starItem,
    softDelete, restore, hardDelete, emptyTrash, touchItem,
  ]);

  return <FilesContext.Provider value={value}>{children}</FilesContext.Provider>;
}

export function useFiles(): FilesContextValue {
  const ctx = useContext(FilesContext);
  if (!ctx) throw new Error('useFiles must be used within FilesProvider');
  return ctx;
}
