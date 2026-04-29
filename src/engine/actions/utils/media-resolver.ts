/**
 * Shared helper for outbound-media chat actions: turn `{file_item_id?, file_path?}`
 * into a verified absolute path.
 *
 * `file_item_id` is the canonical reference — it survives renames, supports
 * sha-based de-dup, and ties the send to a registered FileItem row so the
 * approval card can show provenance. `file_path` is an escape hatch for
 * files Cerebro just generated (e.g., a Write tool dropped a PDF) and hasn't
 * registered yet.
 */

import * as fs from 'fs';
import * as http from 'http';

interface FileItemRow {
  id: string;
  name: string;
  storage_path: string;
  mime: string | null;
  size_bytes: number;
}

export interface ResolvedMedia {
  absPath: string;
  fileName: string;
  mime: string | null;
  sizeBytes: number;
}

export async function resolveMediaInput(
  port: number,
  fileItemId: string | undefined,
  filePath: string | undefined,
): Promise<ResolvedMedia> {
  if (fileItemId) {
    const row = await fetchFileItem(port, fileItemId);
    if (!row) {
      throw new Error(`file_item_id ${fileItemId} not found`);
    }
    if (!fs.existsSync(row.storage_path)) {
      throw new Error(`file_item ${fileItemId} bytes are missing on disk`);
    }
    return {
      absPath: row.storage_path,
      fileName: row.name,
      mime: row.mime,
      sizeBytes: row.size_bytes,
    };
  }
  if (filePath) {
    if (!filePath.startsWith('/')) {
      throw new Error('file_path must be an absolute path');
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`file_path not found on disk: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`file_path is not a regular file: ${filePath}`);
    }
    return {
      absPath: filePath,
      fileName: basename(filePath),
      mime: null,
      sizeBytes: stat.size,
    };
  }
  throw new Error('must provide either file_item_id or file_path');
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function fetchFileItem(port: number, id: string): Promise<FileItemRow | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/files/items/${encodeURIComponent(id)}`,
        method: 'GET',
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          if (!res.statusCode || res.statusCode >= 400) { resolve(null); return; }
          try { resolve(JSON.parse(data) as FileItemRow); }
          catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
