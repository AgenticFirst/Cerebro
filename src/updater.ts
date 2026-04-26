import { app, BrowserWindow, dialog, shell } from 'electron';
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

export async function downloadAndOpen(asset: UpdateAsset): Promise<void> {
  const tempDir = app.getPath('temp');
  const safeName = asset.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const destPath = path.join(tempDir, safeName);

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
            const out = fs.createWriteStream(destPath);
            pipeline(res, out).then(() => resolve()).catch(reject);
          },
        )
        .on('error', reject);
    };
    followRedirects(asset.url, 0);
  });

  // Linux AppImages are downloaded without the executable bit; without
  // chmod +x, double-clicking them just opens a text editor. Same for the
  // shell.openPath call.
  if (process.platform === 'linux' && /\.appimage$/i.test(asset.name)) {
    try {
      await fs.promises.chmod(destPath, 0o755);
    } catch (err) {
      console.warn('[updater] Failed to chmod AppImage:', err);
    }
  }

  send(IPC_CHANNELS.UPDATE_DOWNLOADED, { path: destPath, asset });

  // shell.openPath returns a string error message ('' = success).
  const openErr = await shell.openPath(destPath);
  if (openErr) {
    throw new Error(`Failed to open installer: ${openErr}`);
  }
}
