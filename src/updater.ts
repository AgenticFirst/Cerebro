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

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

interface GithubRelease {
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

function pickAssetForPlatform(assets: GithubAsset[]): UpdateAsset | null {
  const lower = (name: string) => name.toLowerCase();
  const find = (predicate: (n: string) => boolean) =>
    assets.find((a) => predicate(lower(a.name)));

  let chosen: GithubAsset | undefined;

  if (process.platform === 'darwin') {
    chosen = find((n) => n.endsWith('.dmg'));
  } else if (process.platform === 'win32') {
    chosen =
      find((n) => n.endsWith('setup.exe')) ??
      find((n) => n.endsWith('.exe'));
  } else if (process.platform === 'linux') {
    chosen =
      find((n) => n.endsWith('.appimage')) ??
      find((n) => n.endsWith('.deb')) ??
      find((n) => n.endsWith('.rpm'));
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

export async function checkNow(): Promise<UpdateInfo | null> {
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
      `[updater] No matching asset for platform=${process.platform} in release ${release.tag_name}`,
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

  send(IPC_CHANNELS.UPDATE_DOWNLOADED, { path: destPath, asset });

  // shell.openPath returns a string error message ('' = success).
  const openErr = await shell.openPath(destPath);
  if (openErr) {
    throw new Error(`Failed to open installer: ${openErr}`);
  }
}
