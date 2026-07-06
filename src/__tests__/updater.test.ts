/**
 * Acceptance tests for the auto-updater (src/updater.ts).
 *
 * Covers the three areas where bugs are most likely to bite:
 *   1. Platform-asset matching      — picks the correct DMG / exe / AppImage
 *   2. Semver comparison + filters  — only updates from older → newer, real releases
 *   3. Network-layer behavior       — 304 caching, error handling, dev-mode skip
 *
 * Electron and node:https are mocked so the suite runs offline and deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mock state shared across the suite ──────────────────────────

const mockApp = vi.hoisted(() => ({
  isPackaged: true,
  version: '0.1.0',
  getVersion: vi.fn(),
  isPackagedFn: vi.fn(),
  getPath: vi.fn((kind: string) => `/tmp/${kind}`),
}));
mockApp.getVersion.mockImplementation(() => mockApp.version);

const mockHttps = vi.hoisted(() => ({
  // Each test pushes the next response onto this queue.
  responseQueue: [] as Array<{
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
    error?: Error;
  }>,
  lastRequestHeaders: null as Record<string, string> | null,
  lastRequestUrl: null as string | null,
  get: vi.fn(),
}));

mockHttps.get.mockImplementation((url: string, opts: any, cb?: any) => {
  // https.get(url, options, callback) — the updater always calls this 3-arg form.
  const callback = typeof opts === 'function' ? opts : cb;
  mockHttps.lastRequestUrl = url;
  mockHttps.lastRequestHeaders = (opts && opts.headers) ?? null;

  const req = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => void;
    destroy: () => void;
  };
  req.setTimeout = vi.fn();
  req.destroy = vi.fn();

  // Defer to next microtask so the caller can attach .on('error').
  queueMicrotask(() => {
    const next = mockHttps.responseQueue.shift();
    if (!next) {
      req.emit('error', new Error('No mock response queued'));
      return;
    }
    if (next.error) {
      req.emit('error', next.error);
      return;
    }
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
      resume: () => void;
    };
    res.statusCode = next.statusCode;
    res.headers = next.headers ?? {};
    res.resume = vi.fn();
    callback?.(res);
    queueMicrotask(() => {
      if (next.body !== undefined) res.emit('data', Buffer.from(next.body));
      res.emit('end');
    });
  });

  return req;
});

const mockAppQuit = vi.hoisted(() => vi.fn());
const mockAppRelaunch = vi.hoisted(() => vi.fn());
const mockShell = vi.hoisted(() => ({
  openPath: vi.fn(),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => mockApp.version,
    get isPackaged() {
      return mockApp.isPackaged;
    },
    getPath: mockApp.getPath,
    quit: mockAppQuit,
    relaunch: mockAppRelaunch,
  },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn() },
  shell: mockShell,
}));

vi.mock('node:https', () => ({ default: mockHttps, ...mockHttps }));

// child_process.spawn — applyUpdate's Linux AppImage path uses this and then
// watches the returned child for 2s. Tests construct an EventEmitter-backed
// child via makeMockChild() and queue its spawn return below.
type MockChild = ReturnType<typeof makeMockChild>;

function makeMockChild(): {
  emitter: EventEmitter;
  stderr: EventEmitter;
  stdout: EventEmitter;
  pid: number;
  unref: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  once: EventEmitter['once'];
  on: EventEmitter['on'];
} {
  const emitter = new EventEmitter();
  const stderr = new EventEmitter();
  const stdout = new EventEmitter();
  // Attach a no-op destroy so launchAndVerify's child.stderr?.destroy() works.
  (stderr as unknown as { destroy: () => void }).destroy = vi.fn();
  (stdout as unknown as { destroy: () => void }).destroy = vi.fn();
  return {
    emitter,
    stderr,
    stdout,
    pid: 12345,
    unref: vi.fn(),
    kill: vi.fn(),
    removeAllListeners: vi.fn(),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
  };
}

const mockSpawn = vi.hoisted(() => {
  const fn = vi.fn();
  return fn;
});
vi.mock('node:child_process', () => ({ spawn: mockSpawn, default: { spawn: mockSpawn } }));

// fs.promises is the same singleton object whether you reach it via the
// default import (`import fs from 'node:fs'; fs.promises.chmod`) or named
// import. Spying on its methods directly is more reliable than trying to
// re-mock the whole `node:fs` namespace, and leaves `fs.createWriteStream`
// (used by downloadUpdate's actual download) untouched.
import fsPromisesRef from 'node:fs';
const mockFsPromises = {
  chmod: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
};

// ── Import the module under test (after mocks are wired) ────────

import {
  pickAssetForPlatform,
  detectInstallKind,
  resolveRunningAppBundle,
  checkNow,
  applyUpdate,
  __resetUpdaterStateForTests,
  __setCachedReleaseForTests,
  verifyDownloadedAsset,
  toErrorEvent,
  UpdaterError,
  autoUpdatesDisabled,
  type GithubAsset,
} from '../updater';
import type { UpdateAsset } from '../types/ipc';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import realFs from 'node:fs';

// ── Helpers ─────────────────────────────────────────────────────

function makeAsset(name: string, size = 100_000): GithubAsset {
  return {
    name,
    browser_download_url: `https://github.com/AgenticFirst/Cerebro/releases/download/v9/${name}`,
    size,
    content_type: 'application/octet-stream',
  };
}

function makeRelease(
  opts: {
    tag?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: GithubAsset[];
    body?: string;
  } = {},
): string {
  return JSON.stringify({
    tag_name: opts.tag ?? 'v0.2.0',
    name: opts.tag ?? 'v0.2.0',
    body: opts.body ?? 'Notes',
    html_url: `https://github.com/AgenticFirst/Cerebro/releases/tag/${opts.tag ?? 'v0.2.0'}`,
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
    assets: opts.assets ?? [
      makeAsset('Cerebro-0.2.0.dmg'),
      makeAsset('Cerebro-0.2.0 Setup.exe'),
      makeAsset('Cerebro-0.2.0.AppImage'),
    ],
  });
}

beforeEach(() => {
  __resetUpdaterStateForTests();
  mockApp.isPackaged = true;
  mockApp.version = '0.1.0';
  mockHttps.responseQueue.length = 0;
  mockHttps.lastRequestHeaders = null;
  mockHttps.lastRequestUrl = null;
  mockHttps.get.mockClear();
});

// ── pickAssetForPlatform ────────────────────────────────────────

describe('pickAssetForPlatform', () => {
  const allAssets = [
    makeAsset('Cerebro-1.0.0.dmg'),
    makeAsset('Cerebro-1.0.0-darwin-arm64.zip'),
    makeAsset('Cerebro-1.0.0 Setup.exe'),
    makeAsset('cerebro_1.0.0_amd64.deb'),
    makeAsset('cerebro-1.0.0.x86_64.rpm'),
    makeAsset('Cerebro-1.0.0.AppImage'),
  ];

  it('picks the darwin .zip over the .dmg on darwin (auto-swappable)', () => {
    const asset = pickAssetForPlatform(allAssets, 'darwin', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0-darwin-arm64.zip');
  });

  it('falls back to the .dmg on darwin when no darwin zip is published', () => {
    const assets = [makeAsset('Cerebro-1.0.0.dmg'), makeAsset('Cerebro-1.0.0 Setup.exe')];
    const asset = pickAssetForPlatform(assets, 'darwin', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0.dmg');
  });

  it('ignores non-mac zips on darwin (no darwin/mac token in the name)', () => {
    const assets = [makeAsset('Cerebro-1.0.0-source.zip'), makeAsset('Cerebro-1.0.0.dmg')];
    const asset = pickAssetForPlatform(assets, 'darwin', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0.dmg');
  });

  it('does NOT auto-pick a wrong-arch darwin zip — falls through to the dmg', () => {
    // The zip path auto-installs with no launch verification; a wrong-arch
    // swap would brick the install. The dmg is opened manually, so a
    // wrong-arch dmg is recoverable — that's the safe last resort.
    const assets = [
      makeAsset('Cerebro-darwin-arm64-1.0.0.zip'),
      makeAsset('Cerebro-1.0.0-arm64.dmg'),
    ];
    const asset = pickAssetForPlatform(assets, 'darwin', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0-arm64.dmg');
  });

  it('picks the Setup.exe on win32 (not the bare .exe)', () => {
    const assets = [makeAsset('cerebro-helper.exe'), makeAsset('Cerebro-1.0.0 Setup.exe')];
    const asset = pickAssetForPlatform(assets, 'win32', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0 Setup.exe');
  });

  it('falls back to a plain .exe on win32 if no Setup.exe is published', () => {
    const assets = [makeAsset('Cerebro-1.0.0.exe')];
    const asset = pickAssetForPlatform(assets, 'win32', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0.exe');
  });

  it('prefers AppImage over deb/rpm on linux', () => {
    // Pass 'unknown' explicitly: the default install-kind detection probes
    // the real host (dpkg/rpm presence, execPath), so a bare call flips
    // between AppImage and .deb depending on the machine running the tests.
    const asset = pickAssetForPlatform(allAssets, 'linux', 'x64', 'unknown');
    expect(asset?.name).toBe('Cerebro-1.0.0.AppImage');
  });

  it('prefers the .deb on linux when running from a deb install', () => {
    const asset = pickAssetForPlatform(allAssets, 'linux', 'x64', 'deb');
    expect(asset?.name).toBe('cerebro_1.0.0_amd64.deb');
  });

  it('prefers the .rpm on linux when running from an rpm install', () => {
    const asset = pickAssetForPlatform(allAssets, 'linux', 'x64', 'rpm');
    expect(asset?.name).toBe('cerebro-1.0.0.x86_64.rpm');
  });

  it('deb install falls back to AppImage when no .deb is published', () => {
    const assets = [makeAsset('Cerebro-1.0.0.AppImage'), makeAsset('cerebro-1.0.0.x86_64.rpm')];
    const asset = pickAssetForPlatform(assets, 'linux', 'x64', 'deb');
    expect(asset?.name).toBe('Cerebro-1.0.0.AppImage');
  });

  it('falls back to .deb when AppImage is missing on linux', () => {
    const assets = [makeAsset('cerebro_1.0.0_amd64.deb'), makeAsset('cerebro-1.0.0.x86_64.rpm')];
    const asset = pickAssetForPlatform(assets, 'linux', 'x64', 'unknown');
    expect(asset?.name).toBe('cerebro_1.0.0_amd64.deb');
  });

  it('falls back to .rpm when only rpm exists on linux', () => {
    const assets = [makeAsset('cerebro-1.0.0.x86_64.rpm')];
    const asset = pickAssetForPlatform(assets, 'linux', 'x64');
    expect(asset?.name).toBe('cerebro-1.0.0.x86_64.rpm');
  });

  it('matches case-insensitively (UPPERCASE.DMG, .AppImage, .APPIMAGE)', () => {
    expect(pickAssetForPlatform([makeAsset('CEREBRO.DMG')], 'darwin', 'arm64')?.name).toBe(
      'CEREBRO.DMG',
    );
    expect(pickAssetForPlatform([makeAsset('Cerebro.AppImage')], 'linux', 'x64')?.name).toBe(
      'Cerebro.AppImage',
    );
    expect(pickAssetForPlatform([makeAsset('Cerebro.APPIMAGE')], 'linux', 'x64')?.name).toBe(
      'Cerebro.APPIMAGE',
    );
  });

  it('returns null when no asset matches the platform', () => {
    const onlyLinux = [makeAsset('Cerebro-1.0.0.AppImage')];
    expect(pickAssetForPlatform(onlyLinux, 'darwin', 'arm64')).toBeNull();
    expect(pickAssetForPlatform(onlyLinux, 'win32', 'x64')).toBeNull();
  });

  it('returns null for unsupported platforms (freebsd, sunos, etc.)', () => {
    expect(pickAssetForPlatform(allAssets, 'freebsd' as NodeJS.Platform, 'x64')).toBeNull();
    expect(pickAssetForPlatform(allAssets, 'sunos' as NodeJS.Platform, 'x64')).toBeNull();
  });

  it('returns null when the assets array is empty', () => {
    expect(pickAssetForPlatform([], 'darwin', 'arm64')).toBeNull();
  });

  it('preserves the asset metadata (url, size, contentType) on a match', () => {
    const assets = [makeAsset('Cerebro-1.2.3.dmg', 555_000_000)];
    const asset = pickAssetForPlatform(assets, 'darwin', 'arm64');
    expect(asset).toEqual({
      name: 'Cerebro-1.2.3.dmg',
      url: 'https://github.com/AgenticFirst/Cerebro/releases/download/v9/Cerebro-1.2.3.dmg',
      size: 555_000_000,
      contentType: 'application/octet-stream',
    });
  });
});

// ── pickAssetForPlatform: arch-aware ────────────────────────────

describe('pickAssetForPlatform — architecture awareness', () => {
  it('picks the arm64 DMG for an Apple Silicon user', () => {
    const assets = [makeAsset('Cerebro-1.0.0-x64.dmg'), makeAsset('Cerebro-1.0.0-arm64.dmg')];
    const asset = pickAssetForPlatform(assets, 'darwin', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0-arm64.dmg');
  });

  it('picks the x64 DMG for an Intel Mac user', () => {
    const assets = [makeAsset('Cerebro-1.0.0-arm64.dmg'), makeAsset('Cerebro-1.0.0-x64.dmg')];
    const asset = pickAssetForPlatform(assets, 'darwin', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0-x64.dmg');
  });

  it('treats x86_64 / amd64 / x64 as aliases for x64', () => {
    const assets = [
      makeAsset('Cerebro-1.0.0-arm64.dmg'),
      makeAsset('cerebro-1.0.0.x86_64.rpm'),
      makeAsset('cerebro_1.0.0_amd64.deb'),
    ];
    expect(pickAssetForPlatform(assets, 'linux', 'x64', 'unknown')?.name).toBe(
      'cerebro_1.0.0_amd64.deb',
    );
  });

  it('treats aarch64 as an alias for arm64', () => {
    const assets = [
      makeAsset('Cerebro-1.0.0-x64.AppImage'),
      makeAsset('Cerebro-1.0.0-aarch64.AppImage'),
    ];
    const asset = pickAssetForPlatform(assets, 'linux', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0-aarch64.AppImage');
  });

  it('falls back to an arch-agnostic asset when no exact arch match exists', () => {
    const assets = [makeAsset('Cerebro-1.0.0.dmg')];
    expect(pickAssetForPlatform(assets, 'darwin', 'arm64')?.name).toBe('Cerebro-1.0.0.dmg');
    expect(pickAssetForPlatform(assets, 'darwin', 'x64')?.name).toBe('Cerebro-1.0.0.dmg');
  });

  it('still returns *something* (last-resort) if only the wrong arch is published', () => {
    // Only an arm64 DMG exists; an Intel user is better off with that than
    // nothing — the auto-update banner will at least surface, and the user
    // can decide. Rosetta 2 covers the gap on Intel Macs since macOS 11.
    const assets = [makeAsset('Cerebro-1.0.0-arm64.dmg')];
    const asset = pickAssetForPlatform(assets, 'darwin', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0-arm64.dmg');
  });

  it('does not pick an arm64 build for an x64 user when an x64 build exists', () => {
    const assets = [
      makeAsset('Cerebro-1.0.0-arm64.dmg'),
      makeAsset('Cerebro-1.0.0-x64.dmg'),
      makeAsset('Cerebro-1.0.0-aarch64.dmg'),
    ];
    const asset = pickAssetForPlatform(assets, 'darwin', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0-x64.dmg');
  });
});

// ── detectInstallKind ───────────────────────────────────────────

describe('detectInstallKind', () => {
  const noFiles = () => false;

  it('darwin is always mac-app', () => {
    expect(
      detectInstallKind('darwin', {}, '/Applications/Cerebro.app/Contents/MacOS/cerebro', noFiles),
    ).toBe('mac-app');
  });

  it('linux with $APPIMAGE set is appimage regardless of execPath', () => {
    expect(
      detectInstallKind(
        'linux',
        { APPIMAGE: '/home/me/Cerebro.AppImage' },
        '/tmp/.mount_Cerebro/cerebro',
        noFiles,
      ),
    ).toBe('appimage');
  });

  it('linux under /usr with dpkg present is deb', () => {
    const files = (p: string) => p === '/usr/bin/dpkg';
    expect(detectInstallKind('linux', {}, '/usr/lib/cerebro/cerebro', files)).toBe('deb');
  });

  it('linux under /usr with only rpm markers is rpm', () => {
    const files = (p: string) => p === '/usr/bin/rpm' || p === '/etc/fedora-release';
    expect(detectInstallKind('linux', {}, '/usr/lib/cerebro/cerebro', files)).toBe('rpm');
  });

  it('prefers deb over rpm when both tools exist (Debian ships rpm as a utility)', () => {
    const files = (p: string) => p === '/usr/bin/dpkg' || p === '/usr/bin/rpm';
    expect(detectInstallKind('linux', {}, '/usr/lib/cerebro/cerebro', files)).toBe('deb');
  });

  it('linux outside package prefixes is unknown', () => {
    const files = (p: string) => p === '/usr/bin/dpkg';
    expect(detectInstallKind('linux', {}, '/home/me/apps/cerebro/cerebro', files)).toBe('unknown');
  });

  it('win32 is unknown (Squirrel handles Windows separately)', () => {
    expect(detectInstallKind('win32', {}, 'C:\\Users\\me\\cerebro.exe', noFiles)).toBe('unknown');
  });
});

// ── resolveRunningAppBundle ─────────────────────────────────────

describe('resolveRunningAppBundle', () => {
  it('resolves the bundle three levels above the executable', () => {
    expect(resolveRunningAppBundle('/Applications/Cerebro.app/Contents/MacOS/cerebro')).toBe(
      '/Applications/Cerebro.app',
    );
  });

  it('returns null when the executable is not inside a bundle', () => {
    expect(resolveRunningAppBundle('/usr/local/bin/cerebro')).toBeNull();
  });
});

// ── checkNow: dev-mode + happy paths ────────────────────────────

describe('checkNow — dev mode + happy path', () => {
  it('returns null and makes no network call when running unpackaged', async () => {
    mockApp.isPackaged = false;
    const result = await checkNow();
    expect(result).toBeNull();
    expect(mockHttps.get).not.toHaveBeenCalled();
  });

  it('returns UpdateInfo when remote version is newer than local', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      headers: { etag: 'W/"abc123"' },
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    const result = await checkNow();
    expect(result).not.toBeNull();
    expect(result?.version).toBe('0.2.0');
    expect(result?.htmlUrl).toContain('AgenticFirst/Cerebro');
    expect(result?.asset).not.toBeNull();
  });

  it('strips the leading "v" from the GitHub tag before comparing', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.1.1' }),
    });
    const result = await checkNow();
    expect(result?.version).toBe('0.1.1');
  });

  it('handles tags published without a "v" prefix', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: '0.1.1' }),
    });
    const result = await checkNow();
    expect(result?.version).toBe('0.1.1');
  });
});

// ── checkNow: filters that should suppress an update ────────────

describe('checkNow — filters out non-updates', () => {
  it('returns null when remote version equals local', async () => {
    mockApp.version = '0.2.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    expect(await checkNow()).toBeNull();
  });

  it('returns null when remote version is OLDER than local (downgrade guard)', async () => {
    mockApp.version = '0.5.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    expect(await checkNow()).toBeNull();
  });

  it('returns null when the latest release is a draft', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.2.0', draft: true }),
    });
    expect(await checkNow()).toBeNull();
  });

  it('returns null when the local version is not valid semver', async () => {
    mockApp.version = 'not-a-version';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    expect(await checkNow()).toBeNull();
  });

  it('returns null when the remote tag is not valid semver', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'release-candidate-foo' }),
    });
    expect(await checkNow()).toBeNull();
  });

  it('returns null when no asset matches the current platform', async () => {
    mockApp.version = '0.1.0';
    // Only a Linux .deb published — current platform (darwin in this CI) has no match.
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({
        tag: 'v0.2.0',
        assets: [makeAsset('cerebro_0.2.0_amd64.deb')],
      }),
    });
    // The result depends on test-runner platform; force it to a platform with no match
    // by relying on the absence of a .dmg/.exe/.AppImage. checkNow uses process.platform
    // internally, so on a Mac runner this should be null because there's no .dmg.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(await checkNow()).toBeNull();
    }
  });
});

// ── checkNow: network-layer robustness ──────────────────────────

describe('checkNow — network resilience', () => {
  it('resolves null on connection error (no throw)', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 0,
      error: new Error('ECONNREFUSED'),
    });
    const result = await checkNow();
    expect(result).toBeNull();
  });

  it('resolves null on HTTP 5xx without throwing', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({ statusCode: 503 });
    const result = await checkNow();
    expect(result).toBeNull();
  });

  it('resolves null on 404 (repo private or no releases yet)', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({ statusCode: 404 });
    const result = await checkNow();
    expect(result).toBeNull();
  });

  it('resolves null when JSON is malformed (does not crash the main process)', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: 'this is not json {{{',
    });
    const result = await checkNow();
    expect(result).toBeNull();
  });

  it('sends a User-Agent header (GitHub API requirement)', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease(),
    });
    await checkNow();
    expect(mockHttps.lastRequestHeaders?.['User-Agent']).toMatch(/Cerebro-Updater/);
    expect(mockHttps.lastRequestHeaders?.['Accept']).toBe('application/vnd.github+json');
  });

  it('hits the AgenticFirst/Cerebro releases/latest endpoint', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({ statusCode: 200, body: makeRelease() });
    await checkNow();
    expect(mockHttps.lastRequestUrl).toBe(
      'https://api.github.com/repos/AgenticFirst/Cerebro/releases/latest',
    );
  });
});

// ── checkNow: ETag caching (rate-limit hygiene) ─────────────────

describe('checkNow — ETag caching', () => {
  it('captures the ETag from the first response and sends If-None-Match on the second', async () => {
    mockApp.version = '0.1.0';
    // First response: 200 with ETag.
    mockHttps.responseQueue.push({
      statusCode: 200,
      headers: { etag: 'W/"first-etag"' },
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    await checkNow();

    // Second response: 304 Not Modified (no body).
    mockHttps.responseQueue.push({ statusCode: 304 });
    await checkNow();

    expect(mockHttps.lastRequestHeaders?.['If-None-Match']).toBe('W/"first-etag"');
  });

  it('reuses the cached release on 304 so semver comparison still runs', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      headers: { etag: 'W/"abc"' },
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    const first = await checkNow();
    expect(first?.version).toBe('0.2.0');

    mockHttps.responseQueue.push({ statusCode: 304 });
    const second = await checkNow();
    expect(second?.version).toBe('0.2.0');
  });

  it('still suppresses the update on 304 if the user has since upgraded', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      headers: { etag: 'W/"abc"' },
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    expect(await checkNow()).not.toBeNull();

    // User installs the update; now app.getVersion() returns 0.2.0.
    mockApp.version = '0.2.0';
    mockHttps.responseQueue.push({ statusCode: 304 });
    expect(await checkNow()).toBeNull();
  });
});

// ── checkNow: concurrent-call mutex ─────────────────────────────

describe('checkNow — concurrency', () => {
  it('coalesces parallel callers onto a single in-flight request', async () => {
    mockApp.version = '0.1.0';
    // Only ONE response queued; if the mutex is broken, the second call
    // would dequeue nothing and reject with "No mock response queued".
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    const [a, b, c] = await Promise.all([checkNow(), checkNow(), checkNow()]);
    expect(a?.version).toBe('0.2.0');
    expect(b?.version).toBe('0.2.0');
    expect(c?.version).toBe('0.2.0');
    // Exactly one HTTP call regardless of how many callers raced in.
    expect(mockHttps.get).toHaveBeenCalledTimes(1);
  });

  it('releases the mutex after a check completes (subsequent calls re-fetch)', async () => {
    mockApp.version = '0.1.0';
    mockHttps.responseQueue.push({
      statusCode: 200,
      body: makeRelease({ tag: 'v0.2.0' }),
    });
    await checkNow();
    expect(mockHttps.get).toHaveBeenCalledTimes(1);

    mockHttps.responseQueue.push({ statusCode: 304 });
    await checkNow();
    expect(mockHttps.get).toHaveBeenCalledTimes(2);
  });
});

// ── applyUpdate — install + restart with verify-and-rollback ────
//
// The previous bug shipped to users: shell.openPath('Cerebro.AppImage') on
// Linux delegated to xdg-open, which MIME-routes rather than executes, so
// the install reliably failed.
//
// The new applyUpdate flow:
//   1. Backup current $APPIMAGE → .bak (so we can roll back).
//   2. Atomically replace $APPIMAGE with the downloaded file.
//   3. Spawn the new binary with --appimage-extract-and-run (no libfuse2
//      dependency, no AppImageLauncher integration prompt).
//   4. Watch the child for LAUNCH_VERIFY_MS (2000). Early exit ⇒ rollback
//      and throw; survival ⇒ schedule app.quit().
//
// These tests use fake timers so we can step through the 2-second wait
// deterministically, and inject either an early-exit child or a
// long-running one to exercise both branches.

describe('applyUpdate', () => {
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;
  const originalAppImage = process.env.APPIMAGE;
  const originalAppDir = process.env.APPDIR;
  const originalOwd = process.env.OWD;
  const originalArgv0 = process.env.ARGV0;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  function setExecPath(p: string): void {
    Object.defineProperty(process, 'execPath', { value: p, configurable: true });
  }

  // Pin `fs.existsSync('/usr/bin/pkexec')` so the deb/rpm apply path is
  // deterministic across dev machines and CI (a real /usr/bin/pkexec on a
  // Linux host must not flip the reveal-fallback tests). All other paths
  // fall through to the real implementation — the updater's log rotation
  // also calls existsSync.
  let existsSyncSpy: { mockRestore(): void } | null = null;
  function setPkexecPresent(present: boolean): void {
    const realExistsSync = realFs.existsSync.bind(realFs);
    existsSyncSpy?.mockRestore();
    existsSyncSpy = vi
      .spyOn(realFs, 'existsSync')
      .mockImplementation((p) => (p === '/usr/bin/pkexec' ? present : realExistsSync(p)));
  }

  function makeUpdateAsset(name: string): UpdateAsset {
    return {
      name,
      url: `https://github.com/AgenticFirst/Cerebro/releases/download/v0.2.0/${name}`,
      size: 12345,
      contentType: 'application/octet-stream',
    };
  }

  const realFsPromises = {
    chmod: fsPromisesRef.promises.chmod,
    rename: fsPromisesRef.promises.rename,
    copyFile: fsPromisesRef.promises.copyFile,
    unlink: fsPromisesRef.promises.unlink,
    access: fsPromisesRef.promises.access,
    rm: fsPromisesRef.promises.rm,
    readdir: fsPromisesRef.promises.readdir,
  };

  // Per-test handle to the most recent mock child returned by spawn(), so
  // tests can drive its 'exit' / 'error' events without re-introspecting the
  // mock call args.
  let currentChild: MockChild | null = null;

  function childHandleFor(child: MockChild) {
    return {
      pid: child.pid,
      stderr: child.stderr,
      stdout: child.stdout,
      unref: child.unref,
      kill: child.kill,
      removeAllListeners: child.removeAllListeners,
      once: child.once,
      on: child.on,
    } as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }

  /**
   * Script a sequence of spawned children. Each spec drives the child
   * spawned at that position:
   *   - stayAlive: child never exits (launch-verify success once the 2s
   *     window elapses).
   *   - otherwise: on the next microtask it emits stderr (if any), then
   *     'exit' (for launchAndVerify) and 'close' (for runCommand) with the
   *     given code.
   * Extra spawns past the end of the script reuse the last spec.
   */
  function scriptSpawns(
    ...specs: Array<{ code?: number; stderr?: string; stayAlive?: boolean }>
  ): void {
    let i = 0;
    mockSpawn.mockImplementation(() => {
      const spec = specs[Math.min(i, specs.length - 1)];
      i++;
      const child = makeMockChild();
      currentChild = child;
      if (!spec.stayAlive) {
        queueMicrotask(() => {
          if (spec.stderr) child.stderr.emit('data', Buffer.from(spec.stderr));
          child.emitter.emit('exit', spec.code ?? 0, null);
          child.emitter.emit('close', spec.code ?? 0);
        });
      }
      return childHandleFor(child);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      currentChild = makeMockChild();
      return childHandleFor(currentChild);
    });
    mockAppQuit.mockClear();
    mockAppRelaunch.mockClear();
    mockShell.openPath.mockReset().mockResolvedValue('');
    mockShell.showItemInFolder.mockReset();
    mockFsPromises.chmod.mockReset().mockResolvedValue(undefined);
    mockFsPromises.rename.mockReset().mockResolvedValue(undefined);
    mockFsPromises.copyFile.mockReset().mockResolvedValue(undefined);
    mockFsPromises.unlink.mockReset().mockResolvedValue(undefined);
    mockFsPromises.access.mockReset().mockResolvedValue(undefined);
    mockFsPromises.rm.mockReset().mockResolvedValue(undefined);
    mockFsPromises.readdir.mockReset().mockResolvedValue([]);
    fsPromisesRef.promises.chmod =
      mockFsPromises.chmod as unknown as typeof fsPromisesRef.promises.chmod;
    fsPromisesRef.promises.rename =
      mockFsPromises.rename as unknown as typeof fsPromisesRef.promises.rename;
    fsPromisesRef.promises.copyFile =
      mockFsPromises.copyFile as unknown as typeof fsPromisesRef.promises.copyFile;
    fsPromisesRef.promises.unlink =
      mockFsPromises.unlink as unknown as typeof fsPromisesRef.promises.unlink;
    fsPromisesRef.promises.access =
      mockFsPromises.access as unknown as typeof fsPromisesRef.promises.access;
    fsPromisesRef.promises.rm = mockFsPromises.rm as unknown as typeof fsPromisesRef.promises.rm;
    fsPromisesRef.promises.readdir =
      mockFsPromises.readdir as unknown as typeof fsPromisesRef.promises.readdir;
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true });
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('APPIMAGE', originalAppImage);
    restore('APPDIR', originalAppDir);
    restore('OWD', originalOwd);
    restore('ARGV0', originalArgv0);
    fsPromisesRef.promises.chmod = realFsPromises.chmod;
    fsPromisesRef.promises.rename = realFsPromises.rename;
    fsPromisesRef.promises.copyFile = realFsPromises.copyFile;
    fsPromisesRef.promises.unlink = realFsPromises.unlink;
    fsPromisesRef.promises.access = realFsPromises.access;
    fsPromisesRef.promises.rm = realFsPromises.rm;
    fsPromisesRef.promises.readdir = realFsPromises.readdir;
    existsSyncSpy?.mockRestore();
    existsSyncSpy = null;
    currentChild = null;
  });

  /** Run applyUpdate, simulate a child that stays alive past the 2s verify
   *  window, return the resolved promise. */
  async function applyAndKeepChildAlive(asset: UpdateAsset): Promise<void> {
    const promise = applyUpdate(asset);
    // Let microtasks settle so spawn fires and child is created.
    await vi.advanceTimersByTimeAsync(0);
    // Step past the 2s verify timeout — child never emits exit, so
    // launchAndVerify resolves "success".
    await vi.advanceTimersByTimeAsync(2_001);
    // Then past the 300ms quit-debounce so app.quit() fires.
    await vi.advanceTimersByTimeAsync(310);
    return promise;
  }

  /** Run applyUpdate, simulate the child exiting with the given code/stderr
   *  before the verify window. The returned promise will reject. */
  async function applyAndExitChildEarly(
    asset: UpdateAsset,
    code: number,
    stderr = '',
  ): Promise<unknown> {
    const promise = applyUpdate(asset).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    if (!currentChild) throw new Error('spawn was not called');
    if (stderr) currentChild.stderr.emit('data', Buffer.from(stderr));
    currentChild.emitter.emit('exit', code, null);
    await vi.advanceTimersByTimeAsync(0);
    return promise;
  }

  it('Linux AppImage with $APPIMAGE: backs up, replaces, verifies, and quits', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/home/me/Applications/Cerebro.AppImage';
    process.env.APPDIR = '/tmp/.mount_Cerebro';
    process.env.OWD = '/home/me';
    process.env.ARGV0 = './Cerebro.AppImage';

    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');
    await applyAndKeepChildAlive(asset);

    // mockApp.getPath returns /tmp/${kind}; updates dir is /tmp/userData/updates/.
    const expectedDownloadPath = '/tmp/userData/updates/Cerebro-0.2.0-x64.AppImage';

    // Stage-1: backup created before in-place rename.
    expect(mockFsPromises.copyFile).toHaveBeenCalledWith(
      '/home/me/Applications/Cerebro.AppImage',
      '/home/me/Applications/Cerebro.AppImage.bak',
    );
    // Stage-2: downloaded file atomically renamed over $APPIMAGE.
    expect(mockFsPromises.rename).toHaveBeenCalledWith(
      expectedDownloadPath,
      '/home/me/Applications/Cerebro.AppImage',
    );
    expect(mockFsPromises.chmod).toHaveBeenCalledWith(
      '/home/me/Applications/Cerebro.AppImage',
      0o755,
    );

    // Stage-3: plain spawn (no --appimage-extract-and-run — FUSE is proven
    // working since the current process runs from an AppImage) + sanitized env.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe('/home/me/Applications/Cerebro.AppImage');
    expect(args).toEqual([]);
    expect(opts).toMatchObject({ detached: true });
    const childEnv = (opts as { env: NodeJS.ProcessEnv }).env;
    expect(childEnv.APPIMAGE).toBeUndefined();
    expect(childEnv.APPDIR).toBeUndefined();
    expect(childEnv.OWD).toBeUndefined();
    expect(childEnv.ARGV0).toBeUndefined();

    // Stage-4: backup cleaned up, app.quit() called after verify succeeds.
    expect(mockFsPromises.unlink).toHaveBeenCalledWith(
      '/home/me/Applications/Cerebro.AppImage.bak',
    );
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
    expect(mockShell.openPath).not.toHaveBeenCalled();
  });

  it('Linux AppImage early-exit (non-FUSE crash): rolls back, surfaces stderr, does NOT quit or retry', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/home/me/Applications/Cerebro.AppImage';
    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');

    const err = (await applyAndExitChildEarly(
      asset,
      139,
      'Segmentation fault (core dumped)\n',
    )) as Error;

    // A plain crash is NOT retried with --appimage-extract-and-run — it
    // would just crash again.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Rollback happened: .bak renamed back over $APPIMAGE.
    expect(mockFsPromises.rename).toHaveBeenCalledWith(
      '/home/me/Applications/Cerebro.AppImage.bak',
      '/home/me/Applications/Cerebro.AppImage',
    );
    // app.quit() must NOT fire on failure — old install is still working.
    expect(mockAppQuit).not.toHaveBeenCalled();
    // The user-facing copy was rewritten in v0.1.3 to be reassuring first
    // ("Your current install is unchanged and still running normally") and
    // demote the technical detail into a parenthetical. The underlying
    // contract is the same: the message tells the user it didn't start AND
    // includes the original child stderr for support.
    expect(err.message).toMatch(/new version couldn.t start/i);
    expect(err.message).toMatch(/current install is unchanged/);
    expect(err.message).toMatch(/Segmentation fault/);
  });

  it('Linux AppImage FUSE-looking failure: retries once with --appimage-extract-and-run and quits when it survives', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/home/me/Applications/Cerebro.AppImage';
    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');
    scriptSpawns(
      { code: 127, stderr: 'AppImages require FUSE to run.\nPlease install libfuse2.\n' },
      { stayAlive: true },
    );

    const promise = applyUpdate(asset);
    await vi.advanceTimersByTimeAsync(0); // first spawn fails, retry fires
    await vi.advanceTimersByTimeAsync(2_001); // second child survives verify
    await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0][1] as string[]).toEqual([]);
    expect(mockSpawn.mock.calls[1][1] as string[]).toEqual(['--appimage-extract-and-run']);
    await vi.advanceTimersByTimeAsync(310);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
  });

  it('Linux AppImage FUSE failure on both attempts: rolls back and throws', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/home/me/Applications/Cerebro.AppImage';
    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');
    scriptSpawns(
      { code: 127, stderr: 'fuse: failed to mount\n' },
      { code: 1, stderr: 'extraction failed\n' },
    );

    const promise = applyUpdate(asset).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const err = (await promise) as Error;

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockFsPromises.rename).toHaveBeenCalledWith(
      '/home/me/Applications/Cerebro.AppImage.bak',
      '/home/me/Applications/Cerebro.AppImage',
    );
    expect(mockAppQuit).not.toHaveBeenCalled();
    expect(err.message).toMatch(/current install is unchanged/);
  });

  it('Linux AppImage without $APPIMAGE: launches from updates dir, no backup attempted', async () => {
    setPlatform('linux');
    delete process.env.APPIMAGE;
    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');
    await applyAndKeepChildAlive(asset);

    const expectedPath = '/tmp/userData/updates/Cerebro-0.2.0-x64.AppImage';
    expect(mockFsPromises.copyFile).not.toHaveBeenCalled();
    expect(mockFsPromises.rename).not.toHaveBeenCalled();
    expect(mockSpawn.mock.calls[0][0]).toBe(expectedPath);
    expect(mockSpawn.mock.calls[0][1] as string[]).toEqual([]);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
  });

  it('Linux AppImage with EXDEV (cross-mount): falls back to copy+unlink, launches from $APPIMAGE', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/home/me/Applications/Cerebro.AppImage';
    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');
    const exdev = Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    mockFsPromises.rename.mockRejectedValueOnce(exdev);
    await applyAndKeepChildAlive(asset);

    const expectedDownload = '/tmp/userData/updates/Cerebro-0.2.0-x64.AppImage';
    expect(mockFsPromises.copyFile).toHaveBeenCalledWith(
      expectedDownload,
      '/home/me/Applications/Cerebro.AppImage',
    );
    expect(mockFsPromises.unlink).toHaveBeenCalledWith(expectedDownload);
    expect(mockSpawn.mock.calls[0][0]).toBe('/home/me/Applications/Cerebro.AppImage');
  });

  it('Linux AppImage with EACCES on $APPIMAGE: launches from updates dir, deletes useless backup', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/opt/Cerebro/Cerebro.AppImage';
    const asset = makeUpdateAsset('Cerebro-0.2.0-x64.AppImage');
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockFsPromises.rename.mockRejectedValueOnce(eacces);
    await applyAndKeepChildAlive(asset);

    const expectedDownload = '/tmp/userData/updates/Cerebro-0.2.0-x64.AppImage';
    expect(mockFsPromises.copyFile).toHaveBeenCalledWith(
      '/opt/Cerebro/Cerebro.AppImage',
      '/opt/Cerebro/Cerebro.AppImage.bak',
    );
    expect(mockFsPromises.unlink).toHaveBeenCalledWith('/opt/Cerebro/Cerebro.AppImage.bak');
    expect(mockSpawn.mock.calls[0][0]).toBe(expectedDownload);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
  });

  it('throws helpful error when download artifact is missing on disk', async () => {
    setPlatform('linux');
    process.env.APPIMAGE = '/home/me/Cerebro.AppImage';
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFsPromises.access.mockRejectedValueOnce(enoent);

    await expect(applyUpdate(makeUpdateAsset('Cerebro-0.2.0-x64.AppImage'))).rejects.toThrow(
      /Downloaded update is missing.*re-download/,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockAppQuit).not.toHaveBeenCalled();
  });

  it('Linux .deb without pkexec: reveals in file manager, does not spawn, does not quit', async () => {
    setPlatform('linux');
    setPkexecPresent(false);
    const asset = makeUpdateAsset('cerebro_0.2.0_amd64.deb');
    const outcome = await applyUpdate(asset);

    expect(mockShell.showItemInFolder).toHaveBeenCalledWith(
      '/tmp/userData/updates/cerebro_0.2.0_amd64.deb',
    );
    expect(mockShell.openPath).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockAppQuit).not.toHaveBeenCalled();
    expect(outcome).toEqual({ mode: 'manual', reason: 'pkexec-missing' });
  });

  it('Linux .rpm without pkexec: reveals in file manager', async () => {
    setPlatform('linux');
    setPkexecPresent(false);
    const asset = makeUpdateAsset('cerebro-0.2.0-1.x86_64.rpm');
    const outcome = await applyUpdate(asset);

    expect(mockShell.showItemInFolder).toHaveBeenCalledWith(
      '/tmp/userData/updates/cerebro-0.2.0-1.x86_64.rpm',
    );
    expect(mockShell.openPath).not.toHaveBeenCalled();
    expect(outcome).toEqual({ mode: 'manual', reason: 'pkexec-missing' });
  });

  it('Linux .deb with pkexec: installs via pkexec dpkg -i, launch-verifies the upgraded binary, quits', async () => {
    setPlatform('linux');
    setPkexecPresent(true);
    setExecPath('/usr/lib/cerebro/cerebro');
    const asset = makeUpdateAsset('cerebro_0.2.0_amd64.deb');
    // Spawn #1: pkexec succeeds. Spawn #2: upgraded binary stays alive.
    scriptSpawns({ code: 0 }, { stayAlive: true });

    const promise = applyUpdate(asset);
    await vi.advanceTimersByTimeAsync(0); // pkexec exits 0 → launch-verify spawns
    await vi.advanceTimersByTimeAsync(2_001); // verify window elapses
    const outcome = await promise;

    expect(mockSpawn.mock.calls[0][0]).toBe('/usr/bin/pkexec');
    expect(mockSpawn.mock.calls[0][1] as string[]).toEqual([
      'dpkg',
      '-i',
      '/tmp/userData/updates/cerebro_0.2.0_amd64.deb',
    ]);
    expect(mockSpawn.mock.calls[1][0]).toBe('/usr/lib/cerebro/cerebro');
    expect(mockSpawn.mock.calls[1][1] as string[]).toEqual([]);
    expect(mockFsPromises.unlink).toHaveBeenCalledWith(
      '/tmp/userData/updates/cerebro_0.2.0_amd64.deb',
    );
    expect(outcome).toEqual({ mode: 'restarting' });
    await vi.advanceTimersByTimeAsync(310);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
    expect(mockShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('Linux .rpm with pkexec: installs via pkexec rpm -U', async () => {
    setPlatform('linux');
    setPkexecPresent(true);
    setExecPath('/usr/lib/cerebro/cerebro');
    const asset = makeUpdateAsset('cerebro-0.2.0-1.x86_64.rpm');
    scriptSpawns({ code: 0 }, { stayAlive: true });

    const promise = applyUpdate(asset);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_001);
    await promise;

    expect(mockSpawn.mock.calls[0][1] as string[]).toEqual([
      'rpm',
      '-U',
      '/tmp/userData/updates/cerebro-0.2.0-1.x86_64.rpm',
    ]);
  });

  it('Linux .deb pkexec dismissed (exit 126): falls back to reveal, no error, no quit', async () => {
    setPlatform('linux');
    setPkexecPresent(true);
    const asset = makeUpdateAsset('cerebro_0.2.0_amd64.deb');
    scriptSpawns({ code: 126 });

    const promise = applyUpdate(asset);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await promise;

    expect(outcome).toEqual({ mode: 'manual', reason: 'auth-dismissed' });
    expect(mockShell.showItemInFolder).toHaveBeenCalledWith(
      '/tmp/userData/updates/cerebro_0.2.0_amd64.deb',
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1); // no launch-verify spawn
    expect(mockAppQuit).not.toHaveBeenCalled();
  });

  it('Linux .deb dpkg failure: rejects with the stderr tail, keeps the file for retry', async () => {
    setPlatform('linux');
    setPkexecPresent(true);
    const asset = makeUpdateAsset('cerebro_0.2.0_amd64.deb');
    scriptSpawns({
      code: 2,
      stderr: 'dpkg: error: dpkg frontend lock was locked by another process\n',
    });

    const promise = applyUpdate(asset).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    const err = (await promise) as UpdaterError;

    expect(err).toBeInstanceOf(UpdaterError);
    expect(err.kind).toBe('apply');
    expect(err.message).toMatch(/dpkg frontend lock/);
    expect(mockFsPromises.unlink).not.toHaveBeenCalled();
    expect(mockAppQuit).not.toHaveBeenCalled();
  });

  it('Linux .deb installed but new binary fails verify: throws, does not quit (no rollback possible)', async () => {
    setPlatform('linux');
    setPkexecPresent(true);
    setExecPath('/usr/lib/cerebro/cerebro');
    const asset = makeUpdateAsset('cerebro_0.2.0_amd64.deb');
    scriptSpawns({ code: 0 }, { code: 1, stderr: 'boom\n' });

    const promise = applyUpdate(asset).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const err = (await promise) as UpdaterError;

    expect(err).toBeInstanceOf(UpdaterError);
    expect(err.message).toMatch(/already installed/i);
    expect(mockAppQuit).not.toHaveBeenCalled();
  });

  const macExecPath = '/Applications/Cerebro.app/Contents/MacOS/cerebro';

  it('macOS .zip: extracts with ditto, swaps the bundle keeping a .bak, relaunches and quits', async () => {
    setPlatform('darwin');
    setExecPath(macExecPath);
    const asset = makeUpdateAsset('Cerebro-darwin-arm64-0.2.0.zip');
    // Spawn #1 ditto extract, #2 xattr dequarantine, #3 codesign verify new.
    scriptSpawns({ code: 0 });
    mockFsPromises.readdir.mockResolvedValue(['Cerebro.app']);

    const promise = applyUpdate(asset);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const outcome = await promise;

    const zipPath = '/tmp/userData/updates/Cerebro-darwin-arm64-0.2.0.zip';
    const extractDir = '/tmp/userData/updates/extract';
    expect(mockSpawn.mock.calls[0][0]).toBe('/usr/bin/ditto');
    expect(mockSpawn.mock.calls[0][1] as string[]).toEqual(['-x', '-k', zipPath, extractDir]);
    // Swap: current → .bak, new → current.
    expect(mockFsPromises.rename).toHaveBeenCalledWith(
      '/Applications/Cerebro.app',
      '/Applications/Cerebro.app.bak',
    );
    expect(mockFsPromises.rename).toHaveBeenCalledWith(
      `${extractDir}/Cerebro.app`,
      '/Applications/Cerebro.app',
    );
    // The .bak is the recovery path — it must NOT be deleted on success.
    // (One rm of the .bak path is expected: the pre-swap clear of a stale
    // backup from a previous crashed apply. There must be no second one.)
    const bakRms = mockFsPromises.rm.mock.calls.filter(
      (c) => c[0] === '/Applications/Cerebro.app.bak',
    );
    expect(bakRms).toHaveLength(1);
    // Downloaded zip cleaned up; relaunch scheduled before quit.
    expect(mockFsPromises.unlink).toHaveBeenCalledWith(zipPath);
    expect(mockAppRelaunch).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ mode: 'restarting' });
    await vi.advanceTimersByTimeAsync(310);
    expect(mockAppQuit).toHaveBeenCalledTimes(1);
  });

  it('macOS .zip swap failure: restores the .bak, throws apply error, no relaunch/quit', async () => {
    setPlatform('darwin');
    setExecPath(macExecPath);
    const asset = makeUpdateAsset('Cerebro-darwin-arm64-0.2.0.zip');
    scriptSpawns({ code: 0 });
    mockFsPromises.readdir.mockResolvedValue(['Cerebro.app']);
    // First rename (current → .bak) succeeds; second (new → current) fails.
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    mockFsPromises.rename.mockResolvedValueOnce(undefined).mockRejectedValueOnce(eperm);

    const promise = applyUpdate(asset).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    const err = (await promise) as UpdaterError;

    expect(err).toBeInstanceOf(UpdaterError);
    expect(err.kind).toBe('apply');
    expect(err.message).toMatch(/current install is unchanged/);
    // Rollback: .bak renamed back into place.
    expect(mockFsPromises.rename).toHaveBeenCalledWith(
      '/Applications/Cerebro.app.bak',
      '/Applications/Cerebro.app',
    );
    expect(mockAppRelaunch).not.toHaveBeenCalled();
    expect(mockAppQuit).not.toHaveBeenCalled();
  });

  it('macOS .zip with no .app in the archive: verify error, extract dir cleaned', async () => {
    setPlatform('darwin');
    setExecPath(macExecPath);
    const asset = makeUpdateAsset('Cerebro-darwin-arm64-0.2.0.zip');
    scriptSpawns({ code: 0 });
    mockFsPromises.readdir.mockResolvedValue(['README.txt']);

    const promise = applyUpdate(asset).catch((err) => err);
    await vi.advanceTimersByTimeAsync(0);
    const err = (await promise) as UpdaterError;

    expect(err).toBeInstanceOf(UpdaterError);
    expect(err.kind).toBe('verify');
    expect(err.message).toMatch(/did not contain an app bundle/);
    expect(mockAppRelaunch).not.toHaveBeenCalled();
  });

  it('macOS .zip outside an .app bundle (dev run): reveals the zip, manual outcome', async () => {
    setPlatform('darwin');
    setExecPath('/usr/local/bin/cerebro');
    const asset = makeUpdateAsset('Cerebro-darwin-arm64-0.2.0.zip');

    const outcome = await applyUpdate(asset);

    expect(outcome).toEqual({ mode: 'manual', reason: 'no-bundle' });
    expect(mockShell.showItemInFolder).toHaveBeenCalledWith(
      '/tmp/userData/updates/Cerebro-darwin-arm64-0.2.0.zip',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('macOS .zip from a translocated bundle: reveals the zip, manual outcome', async () => {
    setPlatform('darwin');
    setExecPath(
      '/private/var/folders/ab/AppTranslocation/1234/d/Cerebro.app/Contents/MacOS/cerebro',
    );
    const asset = makeUpdateAsset('Cerebro-darwin-arm64-0.2.0.zip');

    const outcome = await applyUpdate(asset);

    expect(outcome).toEqual({ mode: 'manual', reason: 'no-bundle' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('macOS .dmg: opens via shell.openPath, no spawn, no quit, manual outcome', async () => {
    setPlatform('darwin');
    const asset = makeUpdateAsset('Cerebro-0.2.0-arm64.dmg');
    const outcome = await applyUpdate(asset);

    expect(mockShell.openPath).toHaveBeenCalledWith(
      '/tmp/userData/updates/Cerebro-0.2.0-arm64.dmg',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockAppQuit).not.toHaveBeenCalled();
    expect(outcome).toEqual({ mode: 'manual', reason: 'installer-opened' });
  });

  it('Windows Setup.exe: opens via shell.openPath', async () => {
    setPlatform('win32');
    const asset = makeUpdateAsset('Cerebro-0.2.0 Setup.exe');
    await applyUpdate(asset);

    // Setup.exe has spaces — the sanitized filename replaces them with _.
    expect(mockShell.openPath).toHaveBeenCalledWith(
      '/tmp/userData/updates/Cerebro-0.2.0_Setup.exe',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('macOS shell.openPath failure surfaces as "Failed to open installer"', async () => {
    setPlatform('darwin');
    mockShell.openPath.mockResolvedValueOnce('hdiutil: attach failed');

    await expect(applyUpdate(makeUpdateAsset('Cerebro.dmg'))).rejects.toThrow(
      /Failed to open installer: hdiutil: attach failed/,
    );
    expect(mockAppQuit).not.toHaveBeenCalled();
  });
});

// ── IPC reply path: UpdaterError + toErrorEvent ─────────────────
//
// These cover the structural fix for the "Error invoking remote method
// 'update:download': reply was never sent" bug. The IPC handler now sends
// every error through `toErrorEvent`, which produces a structured-clone-
// safe { message, kind } pair. As long as that mapping is correct, the
// renderer can never see "reply was never sent" again — the handler doesn't
// throw, period.

describe('toErrorEvent', () => {
  it('extracts kind + message from an UpdaterError', () => {
    const ev = toErrorEvent(new UpdaterError('network', 'connection refused'));
    expect(ev).toEqual({ message: 'connection refused', kind: 'network' });
  });

  it('maps plain Error to kind: unknown', () => {
    const ev = toErrorEvent(new Error('something bad'));
    expect(ev).toEqual({ message: 'something bad', kind: 'unknown' });
  });

  it('handles non-Error throws (strings, objects) without crashing', () => {
    expect(toErrorEvent('boom')).toEqual({ message: 'boom', kind: 'unknown' });
    expect(toErrorEvent({ weird: true })).toEqual({
      message: '[object Object]',
      kind: 'unknown',
    });
  });

  it('survives errors whose stack carries circular references (structured-clone hostility)', () => {
    // Reproduces the shape that produced "reply was never sent" — an Error
    // with a self-referential property that structured-clone refuses. Our
    // mapping only reads .message, so this can't trip the IPC layer up.
    const err = new Error('with cycle') as Error & { cycle?: unknown };
    err.cycle = err;
    const ev = toErrorEvent(err);
    expect(ev).toEqual({ message: 'with cycle', kind: 'unknown' });
  });
});

describe('UpdaterError', () => {
  it('carries the kind on the instance', () => {
    const err = new UpdaterError('verify', 'hash mismatch');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('verify');
    expect(err.message).toBe('hash mismatch');
    expect(err.name).toBe('UpdaterError');
  });
});

// ── Admin opt-out ───────────────────────────────────────────────

describe('autoUpdatesDisabled', () => {
  const ORIGINAL = process.env.CEREBRO_DISABLE_AUTO_UPDATES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CEREBRO_DISABLE_AUTO_UPDATES;
    else process.env.CEREBRO_DISABLE_AUTO_UPDATES = ORIGINAL;
  });

  it('returns false when the env var is not set', () => {
    delete process.env.CEREBRO_DISABLE_AUTO_UPDATES;
    expect(autoUpdatesDisabled()).toBe(false);
  });

  it('returns false for the conventional "off" values', () => {
    process.env.CEREBRO_DISABLE_AUTO_UPDATES = '0';
    expect(autoUpdatesDisabled()).toBe(false);
    process.env.CEREBRO_DISABLE_AUTO_UPDATES = 'false';
    expect(autoUpdatesDisabled()).toBe(false);
    process.env.CEREBRO_DISABLE_AUTO_UPDATES = '';
    expect(autoUpdatesDisabled()).toBe(false);
  });

  it('returns true for any truthy admin-friendly value', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      process.env.CEREBRO_DISABLE_AUTO_UPDATES = v;
      expect(autoUpdatesDisabled()).toBe(true);
    }
  });
});

// ── Integrity verification (real fs against tmp files) ──────────
//
// These run against a fresh tmp dir so we exercise the *real* fs.stat /
// fs.createReadStream / fs.open paths. The applyUpdate suite above mocks
// `fs.promises`; this suite is scoped separately so those mocks don't
// bleed in. The verify helper is exported on purpose for this coverage —
// the integrity layer is the load-bearing part of the "this cannot fail"
// guarantee, so the unit test surface needs to match.

describe('verifyDownloadedAsset', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-verify-'));
    __setCachedReleaseForTests(null);
  });
  afterEach(() => {
    try {
      realFs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
    __setCachedReleaseForTests(null);
  });

  function writeFile(name: string, contents: Buffer): string {
    const p = path.join(tmpDir, name);
    realFs.writeFileSync(p, contents);
    return p;
  }

  function makeAppImageHeader(body: Buffer): Buffer {
    // Bytes 0..3 = ELF magic, byte 8..9 = 'AI', byte 10 = type version (2).
    const header = Buffer.alloc(16);
    header[0] = 0x7f;
    header[1] = 0x45;
    header[2] = 0x4c;
    header[3] = 0x46;
    header[8] = 0x41;
    header[9] = 0x49;
    header[10] = 0x02;
    return Buffer.concat([header, body]);
  }

  it('rejects a size mismatch (truncated download)', async () => {
    const filePath = writeFile('Cerebro-0.2.0.dmg', Buffer.from('short'));
    const asset: UpdateAsset = {
      name: 'Cerebro-0.2.0.dmg',
      url: 'https://example.com/a.dmg',
      size: 999_999, // expected size much larger than actual file
      contentType: 'application/octet-stream',
    };
    await expect(verifyDownloadedAsset(filePath, asset)).rejects.toThrow(/wrong size/i);
    await expect(verifyDownloadedAsset(filePath, asset)).rejects.toMatchObject({
      kind: 'verify',
    });
  });

  it('accepts a hash match parsed from release.body', async () => {
    const body = Buffer.from('hello world');
    const filePath = writeFile('Cerebro-0.2.0.dmg', body);
    const expected = crypto.createHash('sha256').update(body).digest('hex');
    const asset: UpdateAsset = {
      name: 'Cerebro-0.2.0.dmg',
      url: 'https://example.com/a.dmg',
      size: body.length,
      contentType: 'application/octet-stream',
    };
    __setCachedReleaseForTests({
      tag_name: 'v0.2.0',
      name: 'v0.2.0',
      body: `### SHA-256\n${expected}  Cerebro-0.2.0.dmg\n`,
      html_url: 'https://example.com/r',
      prerelease: false,
      draft: false,
      assets: [],
    });
    await expect(verifyDownloadedAsset(filePath, asset)).resolves.toBeUndefined();
  });

  it('rejects on hash mismatch', async () => {
    const filePath = writeFile('Cerebro-0.2.0.dmg', Buffer.from('actual contents'));
    const wrongHash = 'a'.repeat(64);
    const asset: UpdateAsset = {
      name: 'Cerebro-0.2.0.dmg',
      url: 'https://example.com/a.dmg',
      size: 'actual contents'.length,
      contentType: 'application/octet-stream',
    };
    __setCachedReleaseForTests({
      tag_name: 'v0.2.0',
      name: 'v0.2.0',
      body: `### Hashes\n${wrongHash}  Cerebro-0.2.0.dmg`,
      html_url: 'https://example.com/r',
      prerelease: false,
      draft: false,
      assets: [],
    });
    await expect(verifyDownloadedAsset(filePath, asset)).rejects.toMatchObject({
      kind: 'verify',
    });
  });

  it('falls through to AppImage magic-bytes when no hash is published', async () => {
    const body = makeAppImageHeader(Buffer.alloc(64));
    const filePath = writeFile('Cerebro-0.2.0.AppImage', body);
    const asset: UpdateAsset = {
      name: 'Cerebro-0.2.0.AppImage',
      url: 'https://example.com/a.AppImage',
      size: body.length,
      contentType: 'application/octet-stream',
    };
    // No release set, so no SHA-256 is found and we rely on magic bytes.
    if (process.platform === 'linux') {
      await expect(verifyDownloadedAsset(filePath, asset)).resolves.toBeUndefined();
    } else {
      // On macOS / Windows the AppImage magic-bytes branch is skipped — only
      // size is verified. That's the documented behavior.
      await expect(verifyDownloadedAsset(filePath, asset)).resolves.toBeUndefined();
    }
  });

  it('accepts a .zip with PK magic bytes when no hash is published', async () => {
    const body = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64)]);
    const filePath = writeFile('Cerebro-darwin-arm64-0.2.0.zip', body);
    const asset: UpdateAsset = {
      name: 'Cerebro-darwin-arm64-0.2.0.zip',
      url: 'https://example.com/a.zip',
      size: body.length,
      contentType: 'application/zip',
    };
    await expect(verifyDownloadedAsset(filePath, asset)).resolves.toBeUndefined();
  });

  it('rejects a .zip without PK magic bytes (HTML error page served instead of archive)', async () => {
    const html = Buffer.from('<!doctype html><html><head><title>Not Found');
    const filePath = writeFile('Cerebro-darwin-arm64-0.2.0.zip', html);
    const asset: UpdateAsset = {
      name: 'Cerebro-darwin-arm64-0.2.0.zip',
      url: 'https://example.com/a.zip',
      size: html.length,
      contentType: 'application/zip',
    };
    await expect(verifyDownloadedAsset(filePath, asset)).rejects.toMatchObject({
      kind: 'verify',
    });
  });

  it('rejects an AppImage whose ELF magic is missing (HTML error page served instead of binary)', async () => {
    // Original Cerebro v0.1.x bug: a 404 redirect to GitHub's branded error
    // page could result in HTML landing in `<asset>.AppImage`. Size *might*
    // match by coincidence; magic bytes catch it.
    if (process.platform !== 'linux') return; // branch is Linux-only
    const html = Buffer.from('<!doctype html><html><head><title>Not Found');
    const filePath = writeFile('Cerebro-0.2.0.AppImage', html);
    const asset: UpdateAsset = {
      name: 'Cerebro-0.2.0.AppImage',
      url: 'https://example.com/a.AppImage',
      size: html.length,
      contentType: 'application/octet-stream',
    };
    await expect(verifyDownloadedAsset(filePath, asset)).rejects.toMatchObject({
      kind: 'verify',
    });
  });
});
