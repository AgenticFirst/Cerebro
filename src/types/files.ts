export type FileSource = 'upload' | 'chat-save' | 'workspace-save' | 'manual';
export type StorageKind = 'managed' | 'workspace';
export type FilesViewMode = 'grid' | 'list';
export type FilesSortKey = 'created' | 'updated' | 'name' | 'opened';

export interface Bucket {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  isDefault: boolean;
  isPinned: boolean;
  sortOrder: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileItem {
  id: string;
  bucketId: string | null;
  name: string;
  ext: string;
  mime: string | null;
  sizeBytes: number;
  sha256: string | null;
  storageKind: StorageKind;
  storagePath: string;
  source: FileSource;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceTaskId: string | null;
  starred: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

// Wire (snake_case) shapes used when talking to the FastAPI backend.
export interface ApiBucket {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  is_default: boolean;
  is_pinned: boolean;
  sort_order: number;
  file_count: number;
  created_at: string;
  updated_at: string;
}

export interface ApiFileItem {
  id: string;
  bucket_id: string | null;
  name: string;
  ext: string;
  mime: string | null;
  size_bytes: number;
  sha256: string | null;
  storage_kind: StorageKind;
  storage_path: string;
  source: FileSource;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_task_id: string | null;
  starred: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

export function bucketFromApi(api: ApiBucket): Bucket {
  return {
    id: api.id,
    name: api.name,
    color: api.color,
    icon: api.icon,
    isDefault: api.is_default,
    isPinned: api.is_pinned,
    sortOrder: api.sort_order,
    fileCount: api.file_count,
    createdAt: api.created_at,
    updatedAt: api.updated_at,
  };
}

export function fileItemFromApi(api: ApiFileItem): FileItem {
  return {
    id: api.id,
    bucketId: api.bucket_id,
    name: api.name,
    ext: api.ext,
    mime: api.mime,
    sizeBytes: api.size_bytes,
    sha256: api.sha256,
    storageKind: api.storage_kind,
    storagePath: api.storage_path,
    source: api.source,
    sourceConversationId: api.source_conversation_id,
    sourceMessageId: api.source_message_id,
    sourceTaskId: api.source_task_id,
    starred: api.starred,
    deletedAt: api.deleted_at,
    createdAt: api.created_at,
    updatedAt: api.updated_at,
    lastOpenedAt: api.last_opened_at,
  };
}

// Built-in pseudo-buckets that show up in the sidebar but are not real Bucket rows.
export type SidebarFilter =
  | { kind: 'recent' }
  | { kind: 'starred' }
  | { kind: 'bucket'; bucketId: string }
  | { kind: 'unfiled' }
  | { kind: 'workspaces' }
  | { kind: 'trash' };
