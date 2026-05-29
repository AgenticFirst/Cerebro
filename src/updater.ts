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

export function startUpdateChecker(window: BrowserWindow): void {
  mainWindow = window;
  if (!app.isPackaged) {
    console.log('[updater] Skipping update checks (running from source)');
    return;
  }
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
        rejectOnce(
          new UpdaterError('network', 'Too many redirects while downloading update.'),
        );
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
        const total = Number.isFinite(totalRemaining)
          ? received + totalRemaining
          : asset.size || 0;
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

  // ── Layer 3: AppImage magic bytes ─────────────────────────────
  if (process.platform === 'linux' && /\.appimage$/i.test(asset.name)) {
    await verifyAppImageMagic(filePath);
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
    const elfOk =
      buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
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
      logUpdaterEvent('apply_ok', { asset: asset.name, mode: 'reveal' });
      return;
    }
  }

  // macOS .dmg, Windows .exe / Setup.exe.
  const openErr = await shell.openPath(downloadedPath);
  if (openErr) {
    throw new UpdaterError('apply', `Failed to open installer: ${openErr}`);
  }
  logUpdaterEvent('apply_ok', { asset: asset.name, mode: 'open' });
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
  try {
    await launchAndVerify(launchPath);
  } catch (launchErr) {
    // Rollback so the user's install is restored to its prior working state.
    let rolledBack = false;
    if (backupPath && runningAppImage) {
      try {
        await fs.promises.rename(backupPath, runningAppImage);
        rolledBack = true;
        console.log('[updater] Rolled back to previous AppImage after failed launch');
      } catch (rollbackErr) {
        console.error('[updater] Rollback failed — user may need to reinstall manually:', rollbackErr);
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
  logUpdaterEvent('apply_ok', { asset: path.basename(launchPath), mode: 'appimage' });
  // Tiny delay so the renderer can paint the "restarting" state before we
  // tear down the window. Also gives the IPC reply time to land — critical:
  // if we app.quit() before the handler's `{ ok: true }` reply is sent the
  // renderer sees "reply was never sent" on its way out.
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
