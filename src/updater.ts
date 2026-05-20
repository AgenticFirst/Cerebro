import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import semver from 'semver';
import { IPC_CHANNELS } from './types/ipc';
import type {
  UpdateInfo,
  UpdateDownloadProgress,
  UpdateAsset,
} from './types/ipc';

const REPO_OWNER = 'AgenticFirst';
const REPO_NAME = 'Cerebro';
const RELEASES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const USER_AGENT = `Cerebro-Updater/${app.getVersion()}`;
const FIRST_CHECK_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RENDERER_ACK_TIMEOUT_MS = 5_000;

export interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

export interface GithubRelease {
  tag_name: string;
  name: string;
  body: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  assets: GithubAsset[];
}

let pollTimer: NodeJS.Timeout | null = null;
let mainWindow: BrowserWindow | null = null;
let lastSeenEtag: string | null = null;
let cachedRelease: GithubRelease | null = null;
let pendingUpdateInfo: UpdateInfo | null = null;
let rendererAcked = false;
let inFlightCheck: Promise<UpdateInfo | null> | null = null;

/** Test-only: reset module-level cache so each test sees a clean slate. */
export function __resetUpdaterStateForTests(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  mainWindow = null;
  lastSeenEtag = null;
  cachedRelease = null;
  pendingUpdateInfo = null;
  rendererAcked = false;
  inFlightCheck = null;
}

/**
 * Architecture aliases that show up in Forge / Electron Packager artifact
 * names. The keys are Node.js arch values; the values are the substrings
 * that appear in actual filenames.
 */
const ARCH_ALIASES: Record<string, string[]> = {
  arm64: ['arm64', 'aarch64'],
  x64: ['x64', 'x86_64', 'amd64'],
  ia32: ['ia32', 'x86', 'i386', 'i686'],
};

function archMatches(filename: string, arch: NodeJS.Architecture): boolean {
  const aliases = ARCH_ALIASES[arch];
  if (!aliases) return false;
  return aliases.some((token) => filename.includes(token));
}

/**
 * Picks the right release asset for the current OS + CPU.
 *
 * Order of preference:
 *   1. Asset with a matching extension AND the current arch in its filename
 *      (e.g. arm64 user → `Cerebro-1.0.0-arm64.dmg`).
 *   2. Asset with a matching extension and no arch token at all
 *      (universal builds, or single-arch releases).
 *   3. Any asset with a matching extension (last-resort fallback so we don't
 *      strand users when the publisher accidentally only shipped one arch).
 */
export function pickAssetForPlatform(
  assets: GithubAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): UpdateAsset | null {
  const candidatesByExt = (...exts: string[]): GithubAsset[] =>
    assets.filter((a) => {
      const lower = a.name.toLowerCase();
      return exts.some((ext) => lower.endsWith(ext));
    });

  const allArchTokens = Object.values(ARCH_ALIASES).flat();
  const hasAnyArchToken = (filename: string) =>
    allArchTokens.some((token) => filename.includes(token));

  const choose = (matchingExt: GithubAsset[]): GithubAsset | undefined => {
    if (matchingExt.length === 0) return undefined;
    // 1. exact arch match
    const exact = matchingExt.find((a) => archMatches(a.name.toLowerCase(), arch));
    if (exact) return exact;
    // 2. arch-agnostic name (no arch token at all)
    const archAgnostic = matchingExt.find((a) => !hasAnyArchToken(a.name.toLowerCase()));
    if (archAgnostic) return archAgnostic;
    // 3. last resort
    return matchingExt[0];
  };

  let chosen: GithubAsset | undefined;

  if (platform === 'darwin') {
    chosen = choose(candidatesByExt('.dmg'));
  } else if (platform === 'win32') {
    // Squirrel "Setup.exe" is the auto-update-aware installer; bare ".exe"
    // is the fallback for cases where Forge only emits the inner binary.
    chosen =
      choose(candidatesByExt('setup.exe')) ?? choose(candidatesByExt('.exe'));
  } else if (platform === 'linux') {
    chosen =
      choose(candidatesByExt('.appimage')) ??
      choose(candidatesByExt('.deb')) ??
      choose(candidatesByExt('.rpm'));
  }

  if (!chosen) return null;
  return {
    name: chosen.name,
    url: chosen.browser_download_url,
    size: chosen.size,
    contentType: chosen.content_type,
  };
}

async function fetchLatestRelease(): Promise<GithubRelease | null> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
    };
    if (lastSeenEtag) headers['If-None-Match'] = lastSeenEtag;

    const req = https.get(RELEASES_API, { headers }, (res) => {
      if (res.statusCode === 304 && cachedRelease) {
        res.resume();
        resolve(cachedRelease);
        return;
      }
      if (res.statusCode === 404) {
        res.resume();
        resolve(null);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        console.warn(`[updater] GitHub API returned ${res.statusCode}`);
        resolve(null);
        return;
      }
      const etag = res.headers['etag'];
      if (typeof etag === 'string') lastSeenEtag = etag;

      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const release = JSON.parse(body) as GithubRelease;
          cachedRelease = release;
          resolve(release);
        } catch (err) {
          console.warn('[updater] Failed to parse release JSON:', err);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.warn('[updater] Network error fetching latest release:', err.message);
      resolve(null);
    });
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function checkNowImpl(): Promise<UpdateInfo | null> {
  if (!app.isPackaged) {
    // Don't pester developers running from source.
    return null;
  }
  const release = await fetchLatestRelease();
  if (!release || release.draft) return null;

  const remoteTag = release.tag_name.replace(/^v/, '');
  const localVersion = app.getVersion();
  if (!semver.valid(remoteTag) || !semver.valid(localVersion)) return null;
  if (!semver.gt(remoteTag, localVersion)) return null;

  const asset = pickAssetForPlatform(release.assets);
  if (!asset) {
    console.warn(
      `[updater] No matching asset for platform=${process.platform}/${process.arch} in release ${release.tag_name}`,
    );
    return null;
  }

  return {
    version: remoteTag,
    name: release.name || release.tag_name,
    notes: release.body || '',
    htmlUrl: release.html_url,
    asset,
  };
}

/**
 * Mutex-guarded entry point — the poll timer and the renderer's manual
 * `checkNow` IPC can race; without the mutex they'd both update
 * `lastSeenEtag` / `cachedRelease` at the same time and double-burn the
 * 60 req/hour unauthenticated quota.
 */
export async function checkNow(): Promise<UpdateInfo | null> {
  if (inFlightCheck) return inFlightCheck;
  const promise = checkNowImpl().finally(() => {
    inFlightCheck = null;
  });
  inFlightCheck = promise;
  return promise;
}

function send<T>(channel: string, payload: T): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function maybeShowNativeFallback(info: UpdateInfo): Promise<void> {
  if (rendererAcked) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Cerebro update available',
    message: `Cerebro ${info.version} is available.`,
    detail: 'Open the release page to download the new installer.',
    buttons: ['Open release page', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    void shell.openExternal(info.htmlUrl);
  }
}

async function runCheck(): Promise<void> {
  try {
    const info = await checkNow();
    if (!info) return;
    if (pendingUpdateInfo && pendingUpdateInfo.version === info.version) return;
    pendingUpdateInfo = info;
    rendererAcked = false;
    send(IPC_CHANNELS.UPDATE_AVAILABLE, info);
    setTimeout(() => {
      void maybeShowNativeFallback(info);
    }, RENDERER_ACK_TIMEOUT_MS);
  } catch (err) {
    console.warn('[updater] check failed:', err);
  }
}

export function startUpdateChecker(window: BrowserWindow): void {
  mainWindow = window;
  if (!app.isPackaged) {
    console.log('[updater] Skipping update checks (running from source)');
    return;
  }
  setTimeout(() => void runCheck(), FIRST_CHECK_DELAY_MS);
  pollTimer = setInterval(() => void runCheck(), POLL_INTERVAL_MS);
}

export function stopUpdateChecker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function ackUpdateBanner(): void {
  rendererAcked = true;
}

/**
 * Where downloaded artifacts live. Persistent (not /tmp) so a download isn't
 * lost if the user defers the restart and the OS purges its temp dir. Also
 * survives a process crash mid-restart — the partial download can be retried.
 *
 * IMPORTANT: this directory is INSIDE the user-data dir, which is independent
 * of the AppImage location. SQLite, settings, memory, chat history all live
 * elsewhere in the same userData dir. Nothing here touches them.
 */
function getUpdatesDir(): string {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Download the asset to userData/updates/<safe-name>. Does NOT install —
 * `applyUpdate` does that when the user clicks Restart. Splitting download
 * from apply means:
 *   1. The user controls when the restart happens (no surprise quit).
 *   2. If `applyUpdate` later detects the new version can't launch, the file
 *      is still in a known location so we can retry / rollback / report.
 *   3. The download can take its time without holding the install logic open.
 *
 * Streams to <name>.partial and atomically renames on completion so a
 * crash mid-download can't leave a half-file masquerading as installable.
 */
export async function downloadUpdate(asset: UpdateAsset): Promise<string> {
  const updatesDir = getUpdatesDir();
  const safeName = asset.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const destPath = path.join(updatesDir, safeName);
  const partialPath = `${destPath}.partial`;

  await new Promise<void>((resolve, reject) => {
    const followRedirects = (url: string, hops: number) => {
      if (hops > 5) {
        reject(new Error('Too many redirects while downloading update'));
        return;
      }
      https
        .get(
          url,
          {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/octet-stream',
            },
          },
          (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();
              followRedirects(res.headers.location, hops + 1);
              return;
            }
            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`Download failed: HTTP ${res.statusCode}`));
              return;
            }
            const total =
              Number(res.headers['content-length']) || asset.size || 0;
            let received = 0;
            let lastEmit = 0;
            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              const now = Date.now();
              if (now - lastEmit > 250 || received === total) {
                lastEmit = now;
                const progress: UpdateDownloadProgress = {
                  transferred: received,
                  total,
                  percent: total > 0 ? (received / total) * 100 : 0,
                };
                send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, progress);
              }
            });
            const out = fs.createWriteStream(partialPath);
            pipeline(res, out).then(() => resolve()).catch(reject);
          },
        )
        .on('error', reject);
    };
    followRedirects(asset.url, 0);
  });

  // Atomic finalize: nothing tries to apply a half-downloaded file.
  await fs.promises.rename(partialPath, destPath);

  // chmod AppImages now so retries don't have to repeat it.
  if (process.platform === 'linux' && /\.appimage$/i.test(asset.name)) {
    try {
      await fs.promises.chmod(destPath, 0o755);
    } catch (err) {
      console.warn('[updater] Failed to chmod downloaded AppImage:', err);
    }
  }

  send(IPC_CHANNELS.UPDATE_DOWNLOADED, { path: destPath, asset });
  return destPath;
}

/**
 * Resolve the path of a previously-downloaded artifact. Used by `applyUpdate`
 * so the renderer doesn't have to remember the on-disk path — it just hands
 * back the same asset descriptor it received from UPDATE_DOWNLOADED.
 */
function downloadedPathFor(asset: UpdateAsset): string {
  const safeName = asset.name.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(getUpdatesDir(), safeName);
}

/**
 * Install the previously-downloaded artifact and restart, with a hard
 * guarantee: we do NOT quit the current process until the new version has
 * been observed running for `LAUNCH_VERIFY_MS`. If verification fails the
 * old install is rolled back from a sibling .bak file. This is the only
 * place that calls `app.quit()` in the updater.
 *
 * Per-platform behavior:
 *
 *   Linux .AppImage:
 *     1. If $APPIMAGE is set + writable: copy the running file to .bak,
 *        atomically rename the downloaded file over $APPIMAGE.
 *     2. Spawn the AppImage with `--appimage-extract-and-run`. This avoids
 *        the libfuse2 dependency (Ubuntu 22.04+, Fedora 36+ no longer ship
 *        it) and bypasses AppImageLauncher's integration prompt. The trade
 *        is ~500ms slower startup + ~500 MB extra temp disk for the extract.
 *     3. Watch the child for `LAUNCH_VERIFY_MS`. If it exits before then,
 *        rollback (rename .bak back over $APPIMAGE) and throw — current
 *        process keeps running. If it survives, app.quit().
 *
 *   Linux .deb/.rpm: reveal in the file manager. No quit, no spawn — the
 *     user runs the system package GUI. (Same as before: no portable way to
 *     auto-install without sudo, and dpkg/rpm need the current process to
 *     not be running anyway.)
 *
 *   macOS .dmg / Windows Setup.exe: shell.openPath. These have always-
 *     present, well-defined handlers; the user manually quits + installs.
 */
const LAUNCH_VERIFY_MS = 2000;

export async function applyUpdate(asset: UpdateAsset): Promise<void> {
  const downloadedPath = downloadedPathFor(asset);
  try {
    await fs.promises.access(downloadedPath, fs.constants.R_OK);
  } catch {
    throw new Error(
      `Downloaded update is missing. Please click "Update now" again to re-download.`,
    );
  }

  if (process.platform === 'linux') {
    if (/\.appimage$/i.test(asset.name)) {
      await applyLinuxAppImage(downloadedPath);
      return;
    }
    if (/\.(deb|rpm)$/i.test(asset.name)) {
      // Reveal-only. Do not quit — dpkg/rpm need to run while we're idle,
      // and we have no way to wait on the user. Update apply succeeds as
      // soon as the file is in front of them.
      try {
        shell.showItemInFolder(downloadedPath);
      } catch (err) {
        console.warn('[updater] showItemInFolder failed:', err);
      }
      return;
    }
  }

  // macOS .dmg, Windows .exe / Setup.exe.
  const openErr = await shell.openPath(downloadedPath);
  if (openErr) {
    throw new Error(`Failed to open installer: ${openErr}`);
  }
}

async function applyLinuxAppImage(downloadedPath: string): Promise<void> {
  let launchPath = downloadedPath;
  let backupPath: string | null = null;
  const runningAppImage = process.env.APPIMAGE;

  // ── Step 1: Try to replace the running AppImage in place ───────
  if (runningAppImage) {
    backupPath = `${runningAppImage}.bak`;
    try {
      // Stage a backup BEFORE overwriting so rollback is always possible.
      await fs.promises.copyFile(runningAppImage, backupPath);
    } catch (err) {
      console.warn('[updater] Could not back up running AppImage (will continue without rollback):', err);
      backupPath = null;
    }

    try {
      await fs.promises.rename(downloadedPath, runningAppImage);
      await fs.promises.chmod(runningAppImage, 0o755);
      launchPath = runningAppImage;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        try {
          await fs.promises.copyFile(downloadedPath, runningAppImage);
          await fs.promises.chmod(runningAppImage, 0o755);
          await fs.promises.unlink(downloadedPath);
          launchPath = runningAppImage;
        } catch (copyErr) {
          console.warn('[updater] Cross-device replace failed; launching from updates dir:', copyErr);
          // Backup is useless if we never replaced — delete it so we don't
          // leave .bak files lying around.
          await safeUnlink(backupPath);
          backupPath = null;
        }
      } else {
        console.warn('[updater] In-place replace failed; launching from updates dir:', err);
        await safeUnlink(backupPath);
        backupPath = null;
      }
    }
  }

  // ── Step 2: Verify the new binary can actually launch ──────────
  try {
    await launchAndVerify(launchPath);
  } catch (launchErr) {
    // Rollback so the user's install is restored to its prior working state.
    if (backupPath && runningAppImage) {
      try {
        await fs.promises.rename(backupPath, runningAppImage);
        console.log('[updater] Rolled back to previous AppImage after failed launch');
      } catch (rollbackErr) {
        console.error('[updater] Rollback failed — user may need to reinstall manually:', rollbackErr);
      }
    }
    throw new Error(
      `Couldn't start the new version of Cerebro. Your current install is unchanged. ` +
        `Details: ${(launchErr as Error).message}`,
    );
  }

  // ── Step 3: Launch verified — clean up + quit ──────────────────
  if (backupPath) {
    await safeUnlink(backupPath);
  }
  // Tiny delay so the renderer can paint the "restarting" state before we
  // tear down the window.
  setTimeout(() => app.quit(), 300);
}

async function safeUnlink(p: string | null): Promise<void> {
  if (!p) return;
  try {
    await fs.promises.unlink(p);
  } catch {
    // Best-effort cleanup; don't care if it's already gone.
  }
}

/**
 * Spawn the new AppImage and watch it for `LAUNCH_VERIFY_MS`. If the child
 * exits within that window we treat the launch as failed; otherwise we treat
 * it as successful and resolve. Uses `--appimage-extract-and-run` so the new
 * version works even on systems without libfuse2 and without triggering
 * AppImageLauncher integration prompts.
 */
function launchAndVerify(launchPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Strip AppImage runtime variables so the child re-initializes cleanly.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.APPIMAGE;
    delete childEnv.APPDIR;
    delete childEnv.OWD;
    delete childEnv.ARGV0;

    let child;
    try {
      child = spawn(launchPath, ['--appimage-extract-and-run'], {
        detached: true,
        // Capture stderr so an early-exit failure tells us *why* (e.g.
        // "FUSE: failed", glibc version mismatch). stdin/stdout ignored so
        // the child doesn't keep our pipe alive after we quit.
        stdio: ['ignore', 'ignore', 'pipe'],
        env: childEnv,
      });
    } catch (err) {
      reject(err);
      return;
    }

    if (!child.pid) {
      reject(new Error('Failed to spawn new Cerebro process (no pid returned)'));
      return;
    }

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });

    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      const tail = stderr.trim().split('\n').slice(-3).join(' | ');
      const why = tail || (signal ? `signal=${signal}` : `exit code ${code}`);
      reject(new Error(`new version exited during launch verification: ${why}`));
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      // Still alive after LAUNCH_VERIFY_MS — treat as a successful start.
      // Detach from the child so our pending app.quit() doesn't drag it down
      // and so its stderr pipe stops feeding back into this process.
      child.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.stderr?.destroy();
      child.unref();
      resolve();
    }, LAUNCH_VERIFY_MS);
  });
}
