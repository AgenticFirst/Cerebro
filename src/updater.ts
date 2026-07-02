import { app, BrowserWindow, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import semver from 'semver';
import { IPC_CHANNELS } from './types/ipc';
import type {
  UpdateInfo,
  UpdateDownloadProgress,
  UpdateAsset,
  UpdateErrorKind,
  UpdateErrorEvent,
} from './types/ipc';

/**
 * Updater-specific error that carries an UpdateErrorKind. main.ts's IPC
 * handlers pull `.kind` off this so the renderer can pick the right banner
 * copy without string-matching on `.message`. Falls back to `'unknown'` for
 * thrown Errors that aren't UpdaterError instances.
 */
export class UpdaterError extends Error {
  readonly kind: UpdateErrorKind;
  constructor(kind: UpdateErrorKind, message: string) {
    super(message);
    this.name = 'UpdaterError';
    this.kind = kind;
  }
}

export function toErrorEvent(err: unknown): UpdateErrorEvent {
  if (err instanceof UpdaterError) {
    return { message: err.message, kind: err.kind };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { message, kind: 'unknown' };
}

const REPO_OWNER = 'AgenticFirst';
const REPO_NAME = 'Cerebro';
const RELEASES_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
const USER_AGENT = `Cerebro-Updater/${app.getVersion()}`;
const FIRST_CHECK_DELAY_MS = 30_000;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RENDERER_ACK_TIMEOUT_MS = 5_000;

/**
 * Network timeouts for `downloadUpdate`. Exposed via `setDownloadTimeoutsForTests`
 * so the test suite can drop them to ~200ms without waiting half a minute per
 * case. The numbers below are the production defaults.
 *
 * INITIAL_BYTE: how long we wait for the first byte after the request lands.
 * Mirrors `fetchLatestRelease`'s 15s timeout but a touch more generous since
 * GitHub's CDN sometimes takes a moment on cold buckets.
 *
 * STALL: how long we tolerate zero bytes arriving on an already-flowing
 * stream. Enterprise proxies that close the half-open connection without
 * tearing it down at the TCP level land here.
 */
let initialByteTimeoutMs = 30_000;
let stallTimeoutMs = 30_000;

export function setDownloadTimeoutsForTests(opts: {
  initialByteMs?: number;
  stallMs?: number;
}): void {
  if (opts.initialByteMs !== undefined) initialByteTimeoutMs = opts.initialByteMs;
  if (opts.stallMs !== undefined) stallTimeoutMs = opts.stallMs;
}

export function resetDownloadTimeoutsForTests(): void {
  initialByteTimeoutMs = 30_000;
  stallTimeoutMs = 30_000;
}

/**
 * Admin opt-out. Set `CEREBRO_DISABLE_AUTO_UPDATES=1` in the environment (or
 * via the .desktop/systemd unit that launches Cerebro) to disable all in-app
 * update activity: no poll, no banner, every IPC handler short-circuits.
 *
 * Empty string and "0" do not count as enabled-but-falsy — we treat them as
 * the same as not set, matching the convention that *any* value other than
 * "0"/"false"/"" enables the flag. We use the strict opt-in form here:
 * the var must be present AND non-empty AND not literally "0"/"false".
 */
export function autoUpdatesDisabled(): boolean {
  const raw = process.env.CEREBRO_DISABLE_AUTO_UPDATES;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/**
 * Audit logger. Appends a single JSON line per significant updater event to
 * `<userData>/logs/updater.log`, rotating once the file exceeds ~1 MB. The
 * enterprise support story is "ssh in, `cat ~/.config/Cerebro/logs/updater.log`,
 * and you can see exactly what happened on this machine."
 *
 * No PII; only the version tag, asset name, outcome string. Crucially this
 * never throws: a failing log write must not be allowed to break the updater.
 */
const MAX_LOG_BYTES = 1_000_000;
const LOG_ROTATE_KEEP = 5;
let cachedLogPath: string | null = null;

function getUpdaterLogPath(): string {
  if (cachedLogPath) return cachedLogPath;
  const dir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  cachedLogPath = path.join(dir, 'updater.log');
  return cachedLogPath;
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    const st = fs.statSync(logPath);
    if (st.size < MAX_LOG_BYTES) return;
    for (let i = LOG_ROTATE_KEEP - 1; i >= 0; i--) {
      const src = i === 0 ? logPath : `${logPath}.${i}`;
      const dst = `${logPath}.${i + 1}`;
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {
        // continue
      }
    }
  } catch {
    // file probably doesn't exist yet — that's fine.
  }
}

export type UpdaterAuditEvent =
  | 'check_skipped_disabled'
  | 'check'
  | 'available'
  | 'download_start'
  | 'download_resume'
  | 'download_complete'
  | 'verify_ok'
  | 'verify_fail'
  | 'apply_start'
  | 'apply_ok'
  | 'apply_rollback'
  | 'dismiss';

export function logUpdaterEvent(
  event: UpdaterAuditEvent,
  payload: Record<string, string | number | boolean | null> = {},
): void {
  try {
    const logPath = getUpdaterLogPath();
    rotateLogIfNeeded(logPath);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        appVersion: app.getVersion(),
        event,
        ...payload,
      }) + '\n';
    fs.appendFileSync(logPath, line);
  } catch {
    // Log failures must never propagate; updater correctness comes first.
  }
}

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
  cachedLogPath = null;
  resetDownloadTimeoutsForTests();
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
 * How the currently-running Cerebro got onto this machine. Drives which
 * release asset we download: an AppImage user gets the next AppImage, a
 * .deb install gets the next .deb, etc. Picking the wrong kind means the
 * update can never actually replace the running install — the historical
 * failure mode was a .deb user receiving an AppImage that ran once from
 * the updates dir while /usr/lib/cerebro stayed on the old version.
 */
export type InstallKind = 'appimage' | 'deb' | 'rpm' | 'mac-app' | 'unknown';

export function detectInstallKind(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  fileExists: (p: string) => boolean = fs.existsSync,
): InstallKind {
  if (platform === 'darwin') return 'mac-app';
  if (platform !== 'linux') return 'unknown';
  if (env.APPIMAGE) return 'appimage';
  // Package-managed installs land under /usr (deb/rpm) or /opt. Anything
  // else (home dir, /tmp, mounted drive) we can't safely upgrade in place.
  if (execPath.startsWith('/usr') || execPath.startsWith('/opt')) {
    // dpkg before rpm: Debian systems often have the `rpm` tool installed
    // as a utility, but Fedora-family systems rarely carry dpkg.
    if (fileExists('/usr/bin/dpkg') || fileExists('/etc/debian_version')) return 'deb';
    if (
      fileExists('/usr/bin/rpm') ||
      fileExists('/etc/redhat-release') ||
      fileExists('/etc/fedora-release')
    ) {
      return 'rpm';
    }
  }
  return 'unknown';
}

/**
 * Picks the right release asset for the current OS + CPU + install kind.
 *
 * Order of preference within an extension tier:
 *   1. Asset with a matching extension AND the current arch in its filename
 *      (e.g. arm64 user → `Cerebro-1.0.0-arm64.dmg`).
 *   2. Asset with a matching extension and no arch token at all
 *      (universal builds, or single-arch releases).
 *   3. Any asset with a matching extension (last-resort fallback so we don't
 *      strand users when the publisher accidentally only shipped one arch).
 *
 * The extension tiers themselves follow `installKind`, so an update can
 * actually replace the running install: .deb users get the .deb, AppImage
 * users the AppImage, mac users the darwin .zip (auto-swappable) before
 * the .dmg (manual installer).
 */
export function pickAssetForPlatform(
  assets: GithubAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  installKind: InstallKind = detectInstallKind(platform),
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

  // Like `choose` but WITHOUT the tier-3 fallback. Used for assets that get
  // auto-installed with no launch verification (the darwin zip swap): a
  // wrong-arch bundle swapped into /Applications can't start and the only
  // recovery is the .bak — better to fall through to the manual .dmg.
  const chooseStrict = (matchingExt: GithubAsset[]): GithubAsset | undefined => {
    if (matchingExt.length === 0) return undefined;
    const exact = matchingExt.find((a) => archMatches(a.name.toLowerCase(), arch));
    if (exact) return exact;
    return matchingExt.find((a) => !hasAnyArchToken(a.name.toLowerCase()));
  };

  let chosen: GithubAsset | undefined;

  if (platform === 'darwin') {
    // Forge's MakerZIP names darwin zips `Cerebro-darwin-<arch>-<ver>.zip`.
    // The name filter keeps a stray non-mac zip (source archive, linux zip)
    // from being auto-swapped over the app bundle.
    const darwinZips = candidatesByExt('.zip').filter((a) => /darwin|mac/i.test(a.name));
    chosen = chooseStrict(darwinZips) ?? choose(candidatesByExt('.dmg'));
  } else if (platform === 'win32') {
    // Squirrel "Setup.exe" is the auto-update-aware installer; bare ".exe"
    // is the fallback for cases where Forge only emits the inner binary.
    chosen = choose(candidatesByExt('setup.exe')) ?? choose(candidatesByExt('.exe'));
  } else if (platform === 'linux') {
    const tiers: Record<string, string[]> = {
      deb: ['.deb', '.appimage', '.rpm'],
      rpm: ['.rpm', '.appimage', '.deb'],
    };
    const order = tiers[installKind] ?? ['.appimage', '.deb', '.rpm'];
    for (const ext of order) {
      chosen = choose(candidatesByExt(ext));
      if (chosen) break;
    }
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
  if (autoUpdatesDisabled()) {
    logUpdaterEvent('check_skipped_disabled');
    return;
  }
  try {
    logUpdaterEvent('check');
    const info = await checkNow();
    if (!info) return;
    if (pendingUpdateInfo && pendingUpdateInfo.version === info.version) return;
    pendingUpdateInfo = info;
    rendererAcked = false;
    logUpdaterEvent('available', {
      remoteVersion: info.version,
      asset: info.asset.name,
    });
    send(IPC_CHANNELS.UPDATE_AVAILABLE, info);
    setTimeout(() => {
      void maybeShowNativeFallback(info);
    }, RENDERER_ACK_TIMEOUT_MS);
  } catch (err) {
    console.warn('[updater] check failed:', err);
  }
}

/**
 * Remove leftovers from the previous update once the new version has
 * proven it boots (we're running, so it did): the pre-swap `.bak` bundle
 * / AppImage kept as the rollback story, and any stale mac zip extract
 * dir. Best-effort — never let cleanup break startup.
 */
export function cleanupStaleUpdateArtifacts(): void {
  try {
    if (process.platform === 'darwin') {
      const bundle = resolveRunningAppBundle();
      if (bundle) fs.rmSync(`${bundle}.bak`, { recursive: true, force: true });
    } else if (process.platform === 'linux' && process.env.APPIMAGE) {
      fs.rmSync(`${process.env.APPIMAGE}.bak`, { force: true });
    }
    fs.rmSync(path.join(getUpdatesDir(), 'extract'), { recursive: true, force: true });
  } catch (err) {
    console.warn('[updater] Stale update artifact cleanup failed:', err);
  }
}

export function startUpdateChecker(window: BrowserWindow): void {
  mainWindow = window;
  if (!app.isPackaged) {
    console.log('[updater] Skipping update checks (running from source)');
    return;
  }
  cleanupStaleUpdateArtifacts();
  if (autoUpdatesDisabled()) {
    console.log('[updater] Auto-updates disabled by CEREBRO_DISABLE_AUTO_UPDATES');
    logUpdaterEvent('check_skipped_disabled');
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

/** Called by the UPDATE_DISMISS handler to record the user closing the
 *  banner. Kept separate from `ackUpdateBanner` so dismiss isn't conflated
 *  with the renderer's "I see the banner" ack. */
export function recordBannerDismissed(): void {
  logUpdaterEvent('dismiss');
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
 * Resumable: a previous `.partial` (from a failed attempt) is kept and the
 * next call sends `Range: bytes=<size>-`. If the CDN honours it we append;
 * if it returns 200 OK we restart fresh. The final file is verified by size
 * + SHA-256 (if published) + magic-bytes (AppImage only) before being moved
 * into place, so a partially-recovered file can't make it to apply.
 */
export async function downloadUpdate(asset: UpdateAsset): Promise<string> {
  if (autoUpdatesDisabled()) {
    throw new UpdaterError('disabled', 'Auto-updates disabled by administrator');
  }

  const updatesDir = getUpdatesDir();
  const safeName = asset.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const destPath = path.join(updatesDir, safeName);
  const partialPath = `${destPath}.partial`;

  // Resume detection: keep an existing partial if it's a *prefix* of the
  // expected size. Anything larger means we already had a complete (or
  // stale-bigger) file from a previous attempt and we should start over to
  // avoid passing a corrupt artifact through.
  let resumeFrom = 0;
  try {
    const st = await fs.promises.stat(partialPath);
    if (asset.size > 0 && st.size > 0 && st.size < asset.size) {
      resumeFrom = st.size;
    } else if (st.size > 0) {
      await fs.promises.unlink(partialPath);
    }
  } catch {
    /* no partial — fresh start. */
  }

  logUpdaterEvent(resumeFrom > 0 ? 'download_resume' : 'download_start', {
    asset: asset.name,
    resumeFrom,
    total: asset.size,
  });

  await streamAssetToPartial(asset, partialPath, resumeFrom);

  // Atomic finalize: nothing tries to apply a half-downloaded file.
  await fs.promises.rename(partialPath, destPath);

  // Integrity verification BEFORE we declare the download complete. If this
  // throws, we wipe both the dest and partial so a Retry forces a fresh
  // download (a corrupt prefix can't poison the next attempt's resume).
  try {
    await verifyDownloadedAsset(destPath, asset);
  } catch (verifyErr) {
    await safeUnlink(destPath);
    await safeUnlink(partialPath);
    logUpdaterEvent('verify_fail', {
      asset: asset.name,
      error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
    });
    throw verifyErr;
  }
  logUpdaterEvent('verify_ok', { asset: asset.name });

  // chmod AppImages now so retries don't have to repeat it.
  if (process.platform === 'linux' && /\.appimage$/i.test(asset.name)) {
    try {
      await fs.promises.chmod(destPath, 0o755);
    } catch (err) {
      console.warn('[updater] Failed to chmod downloaded AppImage:', err);
    }
  }

  logUpdaterEvent('download_complete', { asset: asset.name });
  send(IPC_CHANNELS.UPDATE_DOWNLOADED, { path: destPath, asset });
  return destPath;
}

/**
 * Core streamer for `downloadUpdate`. Handles:
 *   - Redirect following (the GitHub releases CDN is at a different origin
 *     than the API).
 *   - Initial-byte timeout via `req.setTimeout` (socket inactivity timer).
 *   - Stall detection via an explicit byte-watchdog (stronger than socket
 *     inactivity, which can be confused by TCP-level keep-alives).
 *   - Resume via `Range: bytes=<from>-`; if the server returns 200 OK
 *     instead of 206 we restart from 0.
 *   - Wraps every failure in `UpdaterError('network', ...)` so callers can
 *     route to the right banner UX.
 */
function streamAssetToPartial(
  asset: UpdateAsset,
  partialPath: string,
  resumeFrom: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stallTimer: NodeJS.Timeout | null = null;
    let activeReq: ReturnType<typeof https.get> | null = null;
    let settled = false;

    const cleanup = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (activeReq) {
        activeReq.removeAllListeners();
        try {
          activeReq.destroy();
        } catch {
          /* already gone */
        }
        activeReq = null;
      }
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        rejectOnce(
          new UpdaterError(
            'network',
            'Download stalled — no data received from GitHub for too long.',
          ),
        );
      }, stallTimeoutMs);
    };

    const followRedirects = (url: string, hops: number) => {
      if (hops > 5) {
        rejectOnce(new UpdaterError('network', 'Too many redirects while downloading update.'));
        return;
      }
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: 'application/octet-stream',
      };
      if (resumeFrom > 0) {
        headers['Range'] = `bytes=${resumeFrom}-`;
      }

      const req = https.get(url, { headers }, (res) => {
        const status = res.statusCode ?? 0;
        if (
          (status === 301 || status === 302 || status === 307 || status === 308) &&
          res.headers.location
        ) {
          res.resume();
          followRedirects(res.headers.location, hops + 1);
          return;
        }
        const isPartial = status === 206;
        const isFull = status === 200;
        if (!isPartial && !isFull) {
          res.resume();
          rejectOnce(new UpdaterError('network', `Download failed: HTTP ${status}.`));
          return;
        }

        // Server ignored our Range request and returned the full file — fall
        // back to fresh download by overwriting the partial.
        const appending = isPartial && resumeFrom > 0;
        const writeFlags = appending ? 'a' : 'w';
        let received = appending ? resumeFrom : 0;
        const totalRemaining = Number(res.headers['content-length']);
        const total = Number.isFinite(totalRemaining) ? received + totalRemaining : asset.size || 0;
        let lastEmit = 0;

        armStallTimer();

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          armStallTimer();
          const now = Date.now();
          if (now - lastEmit > 250 || (total > 0 && received >= total)) {
            lastEmit = now;
            const progress: UpdateDownloadProgress = {
              transferred: received,
              total,
              percent: total > 0 ? (received / total) * 100 : 0,
            };
            send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, progress);
          }
        });

        const out = fs.createWriteStream(partialPath, { flags: writeFlags });
        pipeline(res, out)
          .then(() => resolveOnce())
          .catch((err) => {
            rejectOnce(
              new UpdaterError(
                'network',
                `Download write failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          });
      });

      activeReq = req;
      req.setTimeout(initialByteTimeoutMs, () => {
        rejectOnce(
          new UpdaterError(
            'network',
            "Download timed out — couldn't reach GitHub or the connection went silent.",
          ),
        );
      });
      req.on('error', (err) => {
        rejectOnce(new UpdaterError('network', `Network error: ${err.message}`));
      });
    };
    followRedirects(asset.url, 0);
  });
}

/**
 * Three-layer integrity check applied after a download but before we declare
 * the file ready for apply. The layers are ordered cheap-to-expensive and
 * each layer is sufficient on its own — we short-circuit as soon as one
 * succeeds.
 *
 *   1. Size: must match the GitHub asset metadata exactly. Catches truncated
 *      downloads from servers that close mid-stream without an error.
 *   2. SHA-256: looked up via (a) a sibling `<asset>.sha256` published with
 *      the release, falling back to (b) a `<hex64>  <asset-name>` line in the
 *      release notes. When we have one, mismatch is hard reject — the file
 *      was corrupted between GitHub and disk.
 *   3. Magic bytes: AppImage only. Catches HTML error pages saved as
 *      `.AppImage` (rare but happens when an asset 404s mid-redirect).
 *
 * No hash and no AppImage → we keep the size check only. We log a warning so
 * we notice that newer releases ship without hashes.
 */
/** Test-only: seed `cachedRelease` so `findExpectedSha256` can scan a fake
 *  release.body / asset listing without needing a real HTTP fetch. */
export function __setCachedReleaseForTests(release: GithubRelease | null): void {
  cachedRelease = release;
}

export async function verifyDownloadedAsset(filePath: string, asset: UpdateAsset): Promise<void> {
  // ── Layer 1: size ─────────────────────────────────────────────
  const st = await fs.promises.stat(filePath);
  if (asset.size > 0 && st.size !== asset.size) {
    throw new UpdaterError(
      'verify',
      `Downloaded file is the wrong size (expected ${asset.size} bytes, got ${st.size}). The download didn't finish cleanly.`,
    );
  }

  // ── Layer 2: SHA-256 ──────────────────────────────────────────
  const expectedSha = await findExpectedSha256(asset);
  if (expectedSha) {
    const actualSha = await sha256OfFile(filePath);
    if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
      throw new UpdaterError(
        'verify',
        `Downloaded file failed its hash check. The download was likely corrupted in transit — please retry.`,
      );
    }
    return;
  }

  // ── Layer 3: magic bytes ──────────────────────────────────────
  if (process.platform === 'linux' && /\.appimage$/i.test(asset.name)) {
    await verifyAppImageMagic(filePath);
    return;
  }
  if (/\.zip$/i.test(asset.name)) {
    await verifyZipMagic(filePath);
    return;
  }

  console.warn(
    `[updater] No SHA-256 available for ${asset.name}; only size was verified. ` +
      `Publish a sibling ${asset.name}.sha256 asset to enable hash verification.`,
  );
}

async function findExpectedSha256(asset: UpdateAsset): Promise<string | null> {
  const release = cachedRelease;
  if (!release) return null;

  // (a) sibling .sha256 asset
  const siblingName = `${asset.name}.sha256`;
  const sibling = release.assets.find((a) => a.name === siblingName);
  if (sibling) {
    try {
      const body = await fetchTextAsset(sibling.browser_download_url);
      const first = body.trim().split(/\s+/)[0];
      if (/^[a-f0-9]{64}$/i.test(first)) return first;
    } catch (err) {
      console.warn('[updater] Failed to fetch sha256 sibling asset:', err);
    }
  }

  // (b) line in release.body — match either "<hex64>  <asset-name>" or
  //     "<asset-name>: <hex64>". Lenient enough to handle both publisher
  //     conventions without forcing one.
  if (release.body) {
    const escaped = asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`([a-fA-F0-9]{64})[\\s\\t]+(?:\\*?)${escaped}\\b`),
      new RegExp(`${escaped}[:\\s]+([a-fA-F0-9]{64})\\b`),
    ];
    for (const pat of patterns) {
      const m = pat.exec(release.body);
      if (m) return m[1];
    }
  }

  return null;
}

function fetchTextAsset(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, hops: number) => {
      if (hops > 5) {
        reject(new Error('Too many redirects fetching sha256'));
        return;
      }
      const req = https.get(u, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
        const status = res.statusCode ?? 0;
        if (
          (status === 301 || status === 302 || status === 307 || status === 308) &&
          res.headers.location
        ) {
          res.resume();
          follow(res.headers.location, hops + 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`sha256 fetch failed: HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.setTimeout(15_000, () => {
        req.destroy(new Error('sha256 fetch timed out'));
      });
      req.on('error', reject);
    };
    follow(url, 0);
  });
}

async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyAppImageMagic(filePath: string): Promise<void> {
  // Type-2 AppImage begins with ELF magic (\x7fELF) and carries an 'AI'
  // signature at file offset 8 followed by a version byte at offset 10.
  // We check ELF strictly (everything is broken if this fails) and warn
  // loudly on missing 'AI' (a custom non-AppImage ELF could be valid).
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);
    const elfOk = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    if (!elfOk) {
      throw new UpdaterError(
        'verify',
        `Downloaded file isn't a valid AppImage (ELF magic missing). The download likely got an HTML error page in place of the binary.`,
      );
    }
    const aiOk = buf[8] === 0x41 && buf[9] === 0x49;
    if (!aiOk) {
      console.warn(
        '[updater] AppImage missing AI signature at offset 8; continuing because size matched',
      );
    }
  } finally {
    await fh.close();
  }
}

async function verifyZipMagic(filePath: string): Promise<void> {
  // Zip archives start with 'PK'. Catches HTML error pages saved as .zip —
  // same failure mode the AppImage ELF check guards against.
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    await fh.read(buf, 0, 2, 0);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new UpdaterError(
        'verify',
        `Downloaded file isn't a valid zip archive. The download likely got an HTML error page in place of the update.`,
      );
    }
  } finally {
    await fh.close();
  }
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
 * What `applyUpdate` did with the downloaded artifact. `restarting` means
 * the install succeeded and the current process is about to quit into the
 * new version — the renderer just keeps its spinner up. `manual` means we
 * handed the user an installer to finish themselves (dmg/exe, pkexec
 * declined, pkexec unavailable, unresolvable bundle path) — the renderer
 * must leave the "Restarting…" state or it spins forever.
 */
export type UpdateApplyMode = 'restarting' | 'manual';

export interface UpdateApplyOutcome {
  mode: UpdateApplyMode;
  /** Why we fell back to manual, so the banner can pick specific copy. */
  reason?: 'pkexec-missing' | 'auth-dismissed' | 'no-bundle' | 'installer-opened';
}

/**
 * Install the previously-downloaded artifact and restart, with a hard
 * guarantee: we do NOT quit the current process until the update is either
 * verified (Linux: new binary observed running for `LAUNCH_VERIFY_MS`) or
 * safely reversible (macOS: previous bundle kept as .bak). This is the only
 * place that calls `app.quit()` in the updater.
 *
 * Per-platform behavior:
 *
 *   Linux .AppImage — `applyLinuxAppImage`:
 *     1. If $APPIMAGE is set + writable: copy the running file to .bak,
 *        atomically rename the downloaded file over $APPIMAGE.
 *     2. Spawn the new AppImage plainly first (FUSE is proven working —
 *        the current process is running from an AppImage). If that launch
 *        fails with FUSE-looking symptoms, retry once with
 *        `--appimage-extract-and-run` (covers hosts that lost libfuse2).
 *     3. Watch the child for `LAUNCH_VERIFY_MS`. If it exits before then,
 *        rollback (rename .bak back over $APPIMAGE) and throw — current
 *        process keeps running. If it survives, app.quit().
 *
 *   Linux .deb/.rpm — `applyLinuxPackage`: install via `pkexec dpkg -i` /
 *     `pkexec rpm -U` (polkit shows the system password dialog), then
 *     launch-verify the in-place-upgraded binary and quit. If pkexec is
 *     missing or the user dismisses the auth dialog, fall back to revealing
 *     the package in the file manager (`manual`).
 *
 *   macOS .zip — `applyDarwinZip`: extract with ditto, verify signature,
 *     swap the running .app bundle (previous kept as .app.bak), then
 *     app.relaunch() + quit. Rolls back from .bak if the swap fails.
 *
 *   macOS .dmg / Windows Setup.exe: shell.openPath. These have always-
 *     present, well-defined handlers; the user manually quits + installs.
 */
const LAUNCH_VERIFY_MS = 2000;

export async function applyUpdate(asset: UpdateAsset): Promise<UpdateApplyOutcome> {
  if (autoUpdatesDisabled()) {
    throw new UpdaterError('disabled', 'Auto-updates disabled by administrator');
  }

  const downloadedPath = downloadedPathFor(asset);
  try {
    await fs.promises.access(downloadedPath, fs.constants.R_OK);
  } catch {
    throw new UpdaterError(
      'verify',
      `Downloaded update is missing. Please click "Update now" again to re-download.`,
    );
  }

  logUpdaterEvent('apply_start', { asset: asset.name, platform: process.platform });

  if (process.platform === 'linux') {
    if (/\.appimage$/i.test(asset.name)) {
      return applyLinuxAppImage(downloadedPath);
    }
    if (/\.(deb|rpm)$/i.test(asset.name)) {
      return applyLinuxPackage(downloadedPath, asset.name);
    }
  }

  if (process.platform === 'darwin' && /\.zip$/i.test(asset.name)) {
    return applyDarwinZip(downloadedPath, asset.name);
  }

  // macOS .dmg, Windows .exe / Setup.exe.
  const openErr = await shell.openPath(downloadedPath);
  if (openErr) {
    throw new UpdaterError('apply', `Failed to open installer: ${openErr}`);
  }
  logUpdaterEvent('apply_ok', { asset: asset.name, mode: 'open' });
  return { mode: 'manual', reason: 'installer-opened' };
}

/**
 * Minimal promise wrapper over `spawn` for short-lived helper commands
 * (ditto, codesign, xattr, pkexec). Captures up to ~4 KB of each stream so
 * failure messages can carry a useful tail without buffering installer
 * output unboundedly. Rejects only on spawn failure — a non-zero exit is a
 * normal result the caller inspects.
 */
function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      killTimer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, opts.timeoutMs);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString();
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function stderrTailOf(text: string): string {
  return text.trim().split('\n').slice(-3).join(' | ');
}

/**
 * Path of the .app bundle the current process runs from, or null when the
 * executable isn't inside a bundle (dev runs, weird repackaging).
 * `process.execPath` is `<bundle>.app/Contents/MacOS/<binary>` — three
 * levels up is the bundle.
 */
export function resolveRunningAppBundle(execPath: string = process.execPath): string | null {
  const candidate = path.resolve(execPath, '..', '..', '..');
  return /\.app$/i.test(candidate) ? candidate : null;
}

/**
 * macOS auto-install: extract the downloaded darwin zip and swap it over
 * the running bundle, keeping the previous version as `<bundle>.app.bak`.
 *
 * There is deliberately NO launch-verify step here (unlike AppImage): the
 * swapped bundle relaunches as *this same process path*, so we can't watch
 * a child while also being the thing that restarts. The .bak is the
 * recovery story instead — it's kept on success and only cleaned up by the
 * next successful boot (`cleanupStaleUpdateArtifacts`).
 */
async function applyDarwinZip(
  downloadedPath: string,
  assetName: string,
): Promise<UpdateApplyOutcome> {
  const bundlePath = resolveRunningAppBundle();

  // Not in a bundle, or Gatekeeper translocated us to a randomized read-only
  // mount — the real install location is unknowable, so hand over to manual.
  if (!bundlePath || bundlePath.includes('/AppTranslocation/')) {
    try {
      shell.showItemInFolder(downloadedPath);
    } catch (err) {
      console.warn('[updater] showItemInFolder failed:', err);
    }
    logUpdaterEvent('apply_ok', { asset: assetName, mode: 'reveal-zip' });
    return { mode: 'manual', reason: 'no-bundle' };
  }

  // ── Extract ─────────────────────────────────────────────────────
  // ditto (not a JS unzip lib): preserves the symlinks, resource forks and
  // xattrs the code signature depends on. A JS-extracted bundle fails
  // Gatekeeper.
  const extractDir = path.join(getUpdatesDir(), 'extract');
  await fs.promises.rm(extractDir, { recursive: true, force: true });
  let extract;
  try {
    extract = await runCommand('/usr/bin/ditto', ['-x', '-k', downloadedPath, extractDir]);
  } catch (err) {
    throw new UpdaterError(
      'apply',
      `Could not run the archive extractor: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (extract.code !== 0) {
    await fs.promises.rm(extractDir, { recursive: true, force: true });
    throw new UpdaterError(
      'verify',
      `The update archive could not be extracted. Please retry the download. (Technical detail: ${stderrTailOf(extract.stderr) || `ditto exit ${extract.code}`})`,
    );
  }

  const entries = await fs.promises.readdir(extractDir);
  const appEntry = entries.find((e) => e.toLowerCase().endsWith('.app'));
  if (!appEntry) {
    await fs.promises.rm(extractDir, { recursive: true, force: true });
    throw new UpdaterError(
      'verify',
      'The update archive did not contain an app bundle. Please retry the download.',
    );
  }
  const newAppPath = path.join(extractDir, appEntry);

  // Defensive dequarantine. Node's https downloads don't set the quarantine
  // xattr, so this is normally a no-op; best-effort by design.
  try {
    await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newAppPath]);
  } catch (err) {
    console.warn('[updater] xattr dequarantine failed (continuing):', err);
  }

  // ── Signature gate ──────────────────────────────────────────────
  // A signed install must never be downgraded to a broken/unsigned bundle.
  // But a dev/ad-hoc install (current bundle fails verification too) has
  // nothing to protect — warn and continue so local builds can still update.
  try {
    const verifyNew = await runCommand('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      newAppPath,
    ]);
    if (verifyNew.code !== 0) {
      const verifyCurrent = await runCommand('/usr/bin/codesign', [
        '--verify',
        '--deep',
        '--strict',
        bundlePath,
      ]);
      if (verifyCurrent.code === 0) {
        await fs.promises.rm(extractDir, { recursive: true, force: true });
        throw new UpdaterError(
          'verify',
          `The downloaded update failed its code-signature check. Your current install is unchanged. (Technical detail: ${stderrTailOf(verifyNew.stderr) || 'codesign verification failed'})`,
        );
      }
      console.warn(
        '[updater] New bundle unsigned, but so is the current install (dev build) — continuing',
      );
    }
  } catch (err) {
    if (err instanceof UpdaterError) throw err;
    console.warn('[updater] codesign unavailable; skipping signature gate:', err);
  }

  // ── Swap with rollback ──────────────────────────────────────────
  const backupPath = `${bundlePath}.bak`;
  await fs.promises.rm(backupPath, { recursive: true, force: true });
  let backedUp = false;
  try {
    await fs.promises.rename(bundlePath, backupPath);
    backedUp = true;
    try {
      await fs.promises.rename(newAppPath, bundlePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') throw err;
      // userData on a different volume than the install — ditto again for
      // xattr/signature fidelity, then drop the source copy.
      const copy = await runCommand('/usr/bin/ditto', [newAppPath, bundlePath]);
      if (copy.code !== 0) {
        throw new Error(`ditto copy failed: ${stderrTailOf(copy.stderr) || copy.code}`);
      }
    }
  } catch (swapErr) {
    // Restore the previous bundle so the install is never left half-swapped.
    let rolledBack = false;
    if (backedUp) {
      try {
        await fs.promises.rm(bundlePath, { recursive: true, force: true });
        await fs.promises.rename(backupPath, bundlePath);
        rolledBack = true;
      } catch (rollbackErr) {
        console.error(
          '[updater] Rollback failed — user may need to reinstall manually:',
          rollbackErr,
        );
      }
    }
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    logUpdaterEvent('apply_rollback', {
      asset: assetName,
      rolledBack,
      error: swapErr instanceof Error ? swapErr.message : String(swapErr),
    });
    throw new UpdaterError(
      'apply',
      `The update couldn't be installed. Your current install is unchanged and still running normally. ` +
        `(Technical detail: ${swapErr instanceof Error ? swapErr.message : String(swapErr)})`,
    );
  }

  // ── Success: clean up + relaunch ────────────────────────────────
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  await safeUnlink(downloadedPath);
  logUpdaterEvent('apply_ok', { asset: assetName, mode: 'mac-swap' });
  // relaunch() re-execs process.execPath, which now resolves into the
  // swapped-in bundle at the same path (the Forge executable name
  // `cerebro` is stable across versions — renaming it breaks this).
  app.relaunch();
  // Same delay as the AppImage path: let the IPC reply land and the
  // renderer paint "restarting" before teardown.
  setTimeout(() => app.quit(), 300);
  return { mode: 'restarting' };
}

/**
 * Linux .deb/.rpm auto-install via pkexec. polkit puts up the system
 * password dialog; dpkg/rpm upgrade the package in place (the running
 * process keeps its unlinked inode), then we launch-verify the freshly
 * installed binary and quit into it.
 */
async function applyLinuxPackage(
  downloadedPath: string,
  assetName: string,
): Promise<UpdateApplyOutcome> {
  const isDeb = /\.deb$/i.test(assetName);
  const installArgs = isDeb ? ['dpkg', '-i', downloadedPath] : ['rpm', '-U', downloadedPath];

  const revealFallback = (reason: 'pkexec-missing' | 'auth-dismissed', extra = {}) => {
    try {
      shell.showItemInFolder(downloadedPath);
    } catch (err) {
      console.warn('[updater] showItemInFolder failed:', err);
    }
    logUpdaterEvent('apply_ok', { asset: assetName, mode: 'reveal', ...extra });
    return { mode: 'manual' as const, reason };
  };

  if (!fs.existsSync('/usr/bin/pkexec')) {
    return revealFallback('pkexec-missing');
  }

  let result;
  try {
    // 5-minute timeout: the polkit dialog waits on the user typing their
    // password — don't race it.
    result = await runCommand('/usr/bin/pkexec', installArgs, { timeoutMs: 300_000 });
  } catch (err) {
    throw new UpdaterError(
      'apply',
      `Could not start the system installer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // pkexec's own exit codes: 126 = auth dialog dismissed, 127 = not
  // authorized / helper missing. The user said no — that's not an error
  // banner, it's a calm fall-back to the manual path.
  if (result.code === 126 || result.code === 127) {
    return revealFallback('auth-dismissed', { pkexec: result.code });
  }
  if (result.code !== 0) {
    // dpkg dependency failure, apt holding the dpkg lock, rpm conflict…
    // Keep the file on disk so Retry re-runs pkexec once the cause clears.
    throw new UpdaterError(
      'apply',
      `The installer could not complete. Your current install keeps running; you can retry in a moment. ` +
        `(Technical detail: ${stderrTailOf(result.stderr) || `installer exit ${result.code}`})`,
    );
  }

  // Package upgraded in place — process.execPath now points at the NEW
  // binary. Verify it starts before quitting. No rollback is possible at
  // this point (the old package version is gone), so a verify failure is
  // reported without touching the install.
  try {
    await launchAndVerify(process.execPath, []);
  } catch (launchErr) {
    logUpdaterEvent('apply_rollback', {
      asset: assetName,
      rolledBack: false,
      mode: 'pkg',
      error: launchErr instanceof Error ? launchErr.message : String(launchErr),
    });
    throw new UpdaterError(
      'apply',
      `The update installed, but the new version didn't start on its verification run. ` +
        `Quit Cerebro and launch it again manually — the new version is already installed. ` +
        `(Technical detail: ${(launchErr as Error).message})`,
    );
  }

  await safeUnlink(downloadedPath);
  logUpdaterEvent('apply_ok', { asset: assetName, mode: 'pkexec' });
  setTimeout(() => app.quit(), 300);
  return { mode: 'restarting' };
}

async function applyLinuxAppImage(downloadedPath: string): Promise<UpdateApplyOutcome> {
  let launchPath = downloadedPath;
  let backupPath: string | null = null;
  const runningAppImage = process.env.APPIMAGE;

  if (!runningAppImage) {
    // Shouldn't happen with install-kind-aware asset picking, but make it
    // loud in the audit log: we can only launch the new AppImage from the
    // updates dir — whatever install the user normally launches stays old.
    console.warn(
      '[updater] $APPIMAGE not set — launching downloaded AppImage without replacing an install',
    );
  }

  // ── Step 1: Try to replace the running AppImage in place ───────
  if (runningAppImage) {
    backupPath = `${runningAppImage}.bak`;
    try {
      // Stage a backup BEFORE overwriting so rollback is always possible.
      await fs.promises.copyFile(runningAppImage, backupPath);
    } catch (err) {
      console.warn(
        '[updater] Could not back up running AppImage (will continue without rollback):',
        err,
      );
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
          console.warn(
            '[updater] Cross-device replace failed; launching from updates dir:',
            copyErr,
          );
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

  // Defensive re-chmod on the path we're about to spawn. `downloadUpdate`
  // already chmodded after download, but if `launchPath` is the original
  // downloaded file (we never replaced $APPIMAGE) and the file crossed a
  // mount that stripped the +x bit between then and now, this catches it.
  try {
    await fs.promises.chmod(launchPath, 0o755);
  } catch (err) {
    console.warn('[updater] Defensive chmod on launchPath failed:', err);
  }

  // ── Step 2: Verify the new binary can actually launch ──────────
  // Plain spawn first: FUSE is proven working on this host (the current
  // process is running from an AppImage), and `--appimage-extract-and-run`
  // costs ~500 MB of temp disk, slower startup, AND strips the setuid bit
  // off chrome-sandbox (the extracted copy is user-owned), which crashes
  // Electron outright on distros that restrict unprivileged user
  // namespaces (Ubuntu 23.10+). The flag is kept only as a retry for
  // hosts whose FUSE setup actually broke since the current version was
  // installed.
  try {
    try {
      await launchAndVerify(launchPath, []);
    } catch (firstErr) {
      if (!looksLikeFuseFailure(firstErr)) throw firstErr;
      console.warn(
        '[updater] Plain AppImage launch failed with FUSE-like error; retrying with --appimage-extract-and-run:',
        firstErr,
      );
      await launchAndVerify(launchPath, ['--appimage-extract-and-run']);
    }
  } catch (launchErr) {
    // Rollback so the user's install is restored to its prior working state.
    let rolledBack = false;
    if (backupPath && runningAppImage) {
      try {
        await fs.promises.rename(backupPath, runningAppImage);
        rolledBack = true;
        console.log('[updater] Rolled back to previous AppImage after failed launch');
      } catch (rollbackErr) {
        console.error(
          '[updater] Rollback failed — user may need to reinstall manually:',
          rollbackErr,
        );
      }
    }
    logUpdaterEvent('apply_rollback', {
      asset: path.basename(downloadedPath),
      rolledBack,
      error: launchErr instanceof Error ? launchErr.message : String(launchErr),
    });
    throw new UpdaterError(
      'apply',
      // Reassurance-first phrasing: the user's install is unchanged. Specific
      // technical detail follows so support tickets aren't black boxes.
      `The new version couldn't start on this system. Your current install is unchanged and still running normally. ` +
        `(Technical detail: ${(launchErr as Error).message})`,
    );
  }

  // ── Step 3: Launch verified — clean up + quit ──────────────────
  if (backupPath) {
    await safeUnlink(backupPath);
  }
  logUpdaterEvent('apply_ok', {
    asset: path.basename(launchPath),
    mode: runningAppImage ? 'appimage' : 'appimage-orphan',
  });
  // Tiny delay so the renderer can paint the "restarting" state before we
  // tear down the window. Also gives the IPC reply time to land — critical:
  // if we app.quit() before the handler's `{ ok: true }` reply is sent the
  // renderer sees "reply was never sent" on its way out.
  setTimeout(() => app.quit(), 300);
  return { mode: 'restarting' };
}

async function safeUnlink(p: string | null): Promise<void> {
  if (!p) return;
  try {
    await fs.promises.unlink(p);
  } catch {
    // Best-effort cleanup; don't care if it's already gone.
  }
}

/** Launch-verify failure that carries the child's stderr tail so callers
 *  can pattern-match the cause (e.g. FUSE trouble → retry with
 *  --appimage-extract-and-run). */
class LaunchVerifyError extends Error {
  readonly stderrTail: string;
  constructor(message: string, stderrTail: string) {
    super(message);
    this.name = 'LaunchVerifyError';
    this.stderrTail = stderrTail;
  }
}

/**
 * Does this launch failure look like the AppImage runtime couldn't mount
 * itself (missing/broken libfuse), as opposed to the app itself crashing?
 * Only FUSE-shaped failures are worth retrying with
 * `--appimage-extract-and-run` — an app crash would just crash again.
 */
function looksLikeFuseFailure(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'EACCES') return true;
  const text =
    err instanceof LaunchVerifyError
      ? `${err.message} ${err.stderrTail}`
      : err instanceof Error
        ? err.message
        : String(err);
  return /fuse|libfuse|dlopen|cannot mount|appimages? require/i.test(text);
}

/**
 * Spawn the new binary with the given args and watch it for
 * `LAUNCH_VERIFY_MS`. If the child exits within that window we treat the
 * launch as failed; otherwise we treat it as successful and resolve.
 */
function launchAndVerify(launchPath: string, args: string[] = []): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Strip AppImage runtime variables so the child re-initializes cleanly.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.APPIMAGE;
    delete childEnv.APPDIR;
    delete childEnv.OWD;
    delete childEnv.ARGV0;

    let child;
    try {
      child = spawn(launchPath, args, {
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
      reject(new LaunchVerifyError(`new version exited during launch verification: ${why}`, tail));
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
