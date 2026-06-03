import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { resolveMediaInput } from '../actions/utils/media-resolver';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

const existsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const statSync = fs.statSync as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  existsSync.mockReset();
  statSync.mockReset();
});

describe('resolveMediaInput — file_path branch', () => {
  it('strips the leading @ from a `@/abs/path` chat annotation', async () => {
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ isFile: () => true, size: 42 });

    const resolved = await resolveMediaInput(9999, undefined, '@/home/agents-ia/Desktop/logo.png');

    expect(resolved.absPath).toBe('/home/agents-ia/Desktop/logo.png');
    expect(resolved.fileName).toBe('logo.png');
    expect(resolved.sizeBytes).toBe(42);
    expect(existsSync).toHaveBeenCalledWith('/home/agents-ia/Desktop/logo.png');
  });

  it('passes a plain absolute path through unchanged', async () => {
    existsSync.mockReturnValue(true);
    statSync.mockReturnValue({ isFile: () => true, size: 7 });

    const resolved = await resolveMediaInput(9999, undefined, '/tmp/report.pdf');

    expect(resolved.absPath).toBe('/tmp/report.pdf');
    expect(resolved.fileName).toBe('report.pdf');
  });

  it('throws when the path is not absolute (after stripping)', async () => {
    await expect(resolveMediaInput(9999, undefined, 'report.pdf')).rejects.toThrow(
      /must be an absolute path/,
    );
  });

  it('throws when the file does not exist on disk', async () => {
    existsSync.mockReturnValue(false);
    await expect(resolveMediaInput(9999, undefined, '@/tmp/missing.png')).rejects.toThrow(
      /not found on disk: \/tmp\/missing\.png/,
    );
  });

  it('throws when neither file_item_id nor file_path is provided', async () => {
    await expect(resolveMediaInput(9999, undefined, undefined)).rejects.toThrow(
      /must provide either file_item_id or file_path/,
    );
  });
});
