/**
 * Boot-time restore application.
 *
 * The Python backend stages a backup into `<userData>/.backup-staging/` and
 * writes `<userData>/.backup-pending.json`. The actual file swap happens
 * here, on the next Electron boot, BEFORE Python opens the SQLite file —
 * that's the only point we can replace `cerebro.db` without racing the live
 * connection.
 *
 * If anything goes wrong we abort the swap and leave the user's previous
 * state intact; the staging directory and marker file are left in place so
 * the next boot can retry.
 */

import fs from 'node:fs';
import path from 'node:path';

const PENDING_MARKER_FILENAME = '.backup-pending.json';
const STAGING_DIR_NAME = '.backup-staging';
const COMPLETION_FLAG_FILENAME = '.backup-restore-flag.json';

interface PendingMarker {
  staging_dir: string;
  rollback_id: string;
  created_at: string;
  contents: string[];
  cerebro_version?: string | null;
  is_undo?: boolean;
}

interface CompletionFlag {
  rollback_id: string;
  applied_at: string;
  is_undo: boolean;
  contents: string[];
}

const RESTORABLE_DIRS = ['files', 'agent-memory', 'task-workspaces'] as const;

function readMarker(userDataDir: string): PendingMarker | null {
  const markerPath = path.join(userDataDir, PENDING_MARKER_FILENAME);
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    return JSON.parse(raw) as PendingMarker;
  } catch {
    return null;
  }
}

function removeMarker(userDataDir: string): void {
  try {
    fs.unlinkSync(path.join(userDataDir, PENDING_MARKER_FILENAME));
  } catch {
    /* not there — already cleaned */
  }
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore — caller will surface via stat */
  }
}

/**
 * Move a directory atomically when possible, falling back to a copy + remove
 * if `rename` fails because src and dest are on different filesystems (rare
 * inside userData, but cheap to guard against).
 */
function moveDir(src: string, dest: string): void {
  rmrf(dest);
  try {
    fs.renameSync(src, dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    // Cross-device — copy then remove.
    fs.cpSync(src, dest, { recursive: true });
    rmrf(src);
  }
}

/**
 * Apply a pending restore if `.backup-pending.json` exists. No-op when the
 * marker is missing. Returns a summary that main.ts can hand to the UI so
 * the post-restart toast lines up with what actually happened.
 */
export function applyPendingRestore(userDataDir: string): {
  applied: boolean;
  rollback_id?: string;
  is_undo?: boolean;
  error?: string;
} {
  const marker = readMarker(userDataDir);
  if (!marker) return { applied: false };

  const stagingDir = marker.staging_dir.startsWith('/')
    ? marker.staging_dir
    : path.join(userDataDir, STAGING_DIR_NAME);

  if (!fs.existsSync(stagingDir)) {
    removeMarker(userDataDir);
    return { applied: false, error: 'staging directory missing' };
  }

  try {
    // 1. Swap the DB file.
    const stagedDb = path.join(stagingDir, 'cerebro.db');
    const liveDb = path.join(userDataDir, 'cerebro.db');
    if (fs.existsSync(stagedDb)) {
      // SQLite auxiliary files would otherwise outlive the swap and corrupt
      // the freshly-restored DB.
      for (const aux of ['cerebro.db-wal', 'cerebro.db-shm', 'cerebro.db-journal']) {
        rmrf(path.join(userDataDir, aux));
      }
      rmrf(liveDb);
      fs.renameSync(stagedDb, liveDb);
    }

    // 2. Swap restorable dirs that the staging actually contains.
    for (const name of RESTORABLE_DIRS) {
      const stagedDir = path.join(stagingDir, name);
      if (!fs.existsSync(stagedDir)) continue;
      const liveDir = path.join(userDataDir, name);
      moveDir(stagedDir, liveDir);
    }

    // 3. Drop the staging dir + marker.
    rmrf(stagingDir);
    removeMarker(userDataDir);

    // 4. Record success so the renderer can show its toast on next health-up.
    const flag: CompletionFlag = {
      rollback_id: marker.rollback_id,
      applied_at: new Date().toISOString(),
      is_undo: Boolean(marker.is_undo),
      contents: marker.contents ?? [],
    };
    fs.writeFileSync(
      path.join(userDataDir, COMPLETION_FLAG_FILENAME),
      JSON.stringify(flag, null, 2),
      'utf8',
    );

    return {
      applied: true,
      rollback_id: marker.rollback_id,
      is_undo: Boolean(marker.is_undo),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Cerebro] Restore swap failed:', message);
    // Leave the marker + staging in place so the user can investigate; the
    // app will retry on next boot if they fix the underlying issue.
    return { applied: false, error: message };
  }
}

/**
 * Read and clear the one-shot completion flag the renderer uses to render
 * the "Restore complete · Undo" toast right after a relaunch.
 */
export function consumeCompletionFlag(userDataDir: string): CompletionFlag | null {
  const flagPath = path.join(userDataDir, COMPLETION_FLAG_FILENAME);
  try {
    const raw = fs.readFileSync(flagPath, 'utf8');
    const parsed = JSON.parse(raw) as CompletionFlag;
    fs.unlinkSync(flagPath);
    return parsed;
  } catch {
    return null;
  }
}
