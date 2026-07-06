import type { DeliveredFileRef } from '../types/chat';
import { parseTrailingFileRefs } from './message-content';

/**
 * Durable delivery for chat file attachments.
 *
 * The agent delivers files as `@/path` refs pointing at wherever it happened
 * to write them (often a temp/workspace dir). Those paths are fragile: the
 * file can be moved or deleted, and on another synced device the path doesn't
 * exist at all. After an assistant message is persisted, this helper copies
 * each delivered file into managed Files storage (which syncs blobs across
 * devices) and records the original-path → managed-copy mapping in the
 * message metadata, where AttachmentChip uses it as a fallback.
 *
 * Best-effort by design: any failure leaves the message exactly as delivered
 * today — chips keep resolving the original path.
 */

interface ApiBucket {
  id: string;
  is_default: boolean;
}

function newFileId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

async function defaultBucketId(): Promise<string | null> {
  const res = await window.cerebro.invoke<ApiBucket[]>({ method: 'GET', path: '/files/buckets' });
  if (!res.ok || !Array.isArray(res.data)) return null;
  return res.data.find((b) => b.is_default)?.id ?? null;
}

/**
 * Import every existing file referenced by `content` into managed storage and
 * PATCH the mapping onto the message metadata. Returns the mapping (keyed by
 * original path) for the caller to mirror into in-memory state, or null when
 * there was nothing to import.
 */
export async function importDeliveredFiles(
  conversationId: string,
  messageId: string,
  content: string,
): Promise<Record<string, DeliveredFileRef> | null> {
  const { attachments } = parseTrailingFileRefs(content);
  if (attachments.length === 0) return null;

  const bucketId = await defaultBucketId();
  if (!bucketId) return null;

  const delivered: Record<string, DeliveredFileRef> = {};
  for (const att of attachments) {
    try {
      const stat = await window.cerebro.shell.statPath(att.filePath);
      if (!stat.exists || stat.isDirectory) continue;

      const fileId = newFileId();
      const importRes = await window.cerebro.files.importToBucket({
        sourcePath: att.filePath,
        bucketId,
        fileId,
        destExt: att.extension,
      });
      const registerRes = await window.cerebro.invoke<{ id: string }>({
        method: 'POST',
        path: '/files/items',
        body: {
          bucket_id: bucketId,
          name: att.fileName,
          ext: att.extension,
          mime: importRes.mime,
          size_bytes: importRes.sizeBytes,
          sha256: importRes.sha256,
          storage_kind: 'managed',
          storage_path: importRes.destRelPath,
          source: 'chat-delivery',
          source_conversation_id: conversationId,
          source_message_id: messageId,
        },
      });
      if (!registerRes.ok) continue;
      delivered[att.filePath] = {
        fileItemId: registerRes.data.id,
        storagePath: importRes.destRelPath,
      };
    } catch (err) {
      console.warn('[chat] delivered-file import failed for', att.filePath, err);
    }
  }

  if (Object.keys(delivered).length === 0) return null;

  const metadata: Record<string, unknown> = {};
  for (const [path, ref] of Object.entries(delivered)) {
    metadata[path] = { file_item_id: ref.fileItemId, storage_path: ref.storagePath };
  }
  const patchRes = await window.cerebro.invoke({
    method: 'PATCH',
    path: `/conversations/${conversationId}/messages/${messageId}`,
    body: { metadata: { delivered_files: metadata } },
  });
  if (!patchRes.ok) {
    // The managed copies exist and sync either way, but without the mapping
    // the chips can't find them — surface it for debugging.
    console.warn('[chat] failed to persist delivered_files metadata for message', messageId);
  }
  return delivered;
}
