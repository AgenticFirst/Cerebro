/**
 * Durable chat file delivery — importDeliveredFiles copies the files an
 * assistant message delivered (`@/path` refs) into managed Files storage and
 * records the mapping on the message metadata. Everything is best-effort:
 * missing files are skipped, and failures never throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importDeliveredFiles } from '../lib/delivered-files';

const statPath = vi.fn();
const importToBucket = vi.fn();
const invoke = vi.fn();

beforeEach(() => {
  statPath.mockReset();
  importToBucket.mockReset();
  invoke.mockReset();
  vi.stubGlobal('window', {
    cerebro: { shell: { statPath }, files: { importToBucket }, invoke },
  });
  vi.stubGlobal('crypto', {
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  });
});

function mockBackend({ registerOk = true } = {}) {
  invoke.mockImplementation(async (req: { method: string; path: string }) => {
    if (req.method === 'GET' && req.path === '/files/buckets') {
      return { ok: true, status: 200, data: [{ id: 'bucket1', is_default: true }] };
    }
    if (req.method === 'POST' && req.path === '/files/items') {
      return registerOk
        ? { ok: true, status: 200, data: { id: 'item1' } }
        : { ok: false, status: 400, data: null };
    }
    if (req.method === 'PATCH') {
      return { ok: true, status: 200, data: {} };
    }
    throw new Error(`unexpected request ${req.method} ${req.path}`);
  });
}

describe('importDeliveredFiles', () => {
  it('imports delivered files and patches the mapping onto the message', async () => {
    mockBackend();
    statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 100 });
    importToBucket.mockResolvedValue({
      destRelPath: 'bucket1/aaaaaaaabbbbccccddddeeeeeeeeeeee.docx',
      sha256: 'abc',
      sizeBytes: 100,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const result = await importDeliveredFiles('conv1', 'msg1', 'Done.\n\n@/tmp/report.docx');

    expect(result).toEqual({
      '/tmp/report.docx': {
        fileItemId: 'item1',
        storagePath: 'bucket1/aaaaaaaabbbbccccddddeeeeeeeeeeee.docx',
      },
    });
    // Registered with the delivery source + message provenance.
    const register = invoke.mock.calls.find(([req]) => req.path === '/files/items')![0];
    expect(register.body).toMatchObject({
      source: 'chat-delivery',
      source_conversation_id: 'conv1',
      source_message_id: 'msg1',
      storage_kind: 'managed',
    });
    // Mapping persisted via metadata PATCH (snake_case).
    const patch = invoke.mock.calls.find(([req]) => req.method === 'PATCH')![0];
    expect(patch.path).toBe('/conversations/conv1/messages/msg1');
    expect(patch.body.metadata.delivered_files['/tmp/report.docx']).toEqual({
      file_item_id: 'item1',
      storage_path: 'bucket1/aaaaaaaabbbbccccddddeeeeeeeeeeee.docx',
    });
  });

  it('skips refs whose files do not exist and returns null when nothing imported', async () => {
    mockBackend();
    statPath.mockResolvedValue({ exists: false, isDirectory: false, size: 0 });

    const result = await importDeliveredFiles('conv1', 'msg1', 'Done.\n\n@/tmp/gone.docx');

    expect(result).toBeNull();
    expect(importToBucket).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([req]) => req.method === 'PATCH')).toBe(false);
  });

  it('returns null without touching the backend when the message has no refs', async () => {
    const result = await importDeliveredFiles('conv1', 'msg1', 'Just a plain answer.');
    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('continues past a file whose import fails', async () => {
    mockBackend();
    statPath.mockResolvedValue({ exists: true, isDirectory: false, size: 10 });
    importToBucket.mockRejectedValueOnce(new Error('disk error')).mockResolvedValueOnce({
      destRelPath: 'bucket1/x.pdf',
      sha256: 'x',
      sizeBytes: 10,
      mime: null,
    });

    const result = await importDeliveredFiles(
      'conv1',
      'msg1',
      'Two files.\n\n@/tmp/bad.docx\n@/tmp/good.pdf',
    );

    expect(result).toEqual({
      '/tmp/good.pdf': { fileItemId: 'item1', storagePath: 'bucket1/x.pdf' },
    });
  });
});
