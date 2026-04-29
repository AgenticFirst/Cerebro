/**
 * Unified staging directory for ephemeral integration downloads.
 *
 * Replaces the per-bridge `telegram-tmp/` pattern. One root, one TTL,
 * one orphan sweep. Each surface gets its own subdirectory so it's easy
 * to attribute disk usage and to clear a single integration without
 * touching the others.
 */

import * as fs from 'fs';
import * as path from 'path';

export type StagingSource = 'telegram' | 'whatsapp' | 'chat';

export const ATTACHMENT_TTL_MS = 30 * 60 * 1000;   // 30 min — same as legacy Telegram
export const ORPHAN_THRESHOLD_MS = 24 * 60 * 60 * 1000;   // boot-time sweep cutoff

export class IntegrationStaging {
  constructor(private readonly userDataDir: string) {}

  /** Absolute root: `<userData>/integrations-tmp/<source>/` */
  dirFor(source: StagingSource): string {
    const dir = path.join(this.userDataDir, 'integrations-tmp', source);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Build an absolute path inside the staging dir. Caller writes the bytes. */
  pathFor(source: StagingSource, filename: string): string {
    return path.join(this.dirFor(source), filename);
  }

  /** Schedule a per-file unlink after the TTL. Cancellable via the returned handle. */
  scheduleCleanup(absPath: string, ttlMs: number = ATTACHMENT_TTL_MS): NodeJS.Timeout {
    return setTimeout(() => {
      fs.promises.rm(absPath, { force: true }).catch(() => {/* swallow */});
    }, ttlMs);
  }

  /** Boot-time orphan sweep — drops anything older than ORPHAN_THRESHOLD_MS. */
  async sweepOrphans(): Promise<number> {
    const root = path.join(this.userDataDir, 'integrations-tmp');
    if (!fs.existsSync(root)) return 0;
    const cutoff = Date.now() - ORPHAN_THRESHOLD_MS;
    let removed = 0;
    for (const source of fs.readdirSync(root)) {
      const dir = path.join(root, source);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {/* ignore vanished entries */}
      }
    }
    return removed;
  }
}
