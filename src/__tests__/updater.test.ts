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

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('electron', () => ({
  app: {
    getVersion: () => mockApp.version,
    get isPackaged() {
      return mockApp.isPackaged;
    },
    getPath: mockApp.getPath,
  },
  BrowserWindow: class {},
  dialog: { showMessageBox: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('node:https', () => ({ default: mockHttps, ...mockHttps }));

// ── Import the module under test (after mocks are wired) ────────

import {
  pickAssetForPlatform,
  checkNow,
  __resetUpdaterStateForTests,
  type GithubAsset,
} from '../updater';

// ── Helpers ─────────────────────────────────────────────────────

function makeAsset(name: string, size = 100_000): GithubAsset {
  return {
    name,
    browser_download_url: `https://github.com/AgenticFirst/Cerebro/releases/download/v9/${name}`,
    size,
    content_type: 'application/octet-stream',
  };
}

function makeRelease(opts: {
  tag?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
  body?: string;
} = {}): string {
  return JSON.stringify({
    tag_name: opts.tag ?? 'v0.2.0',
    name: opts.tag ?? 'v0.2.0',
    body: opts.body ?? 'Notes',
    html_url: `https://github.com/AgenticFirst/Cerebro/releases/tag/${opts.tag ?? 'v0.2.0'}`,
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
    assets:
      opts.assets ?? [
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

  it('picks the .dmg on darwin', () => {
    const asset = pickAssetForPlatform(allAssets, 'darwin', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0.dmg');
  });

  it('picks the Setup.exe on win32 (not the bare .exe)', () => {
    const assets = [
      makeAsset('cerebro-helper.exe'),
      makeAsset('Cerebro-1.0.0 Setup.exe'),
    ];
    const asset = pickAssetForPlatform(assets, 'win32', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0 Setup.exe');
  });

  it('falls back to a plain .exe on win32 if no Setup.exe is published', () => {
    const assets = [makeAsset('Cerebro-1.0.0.exe')];
    const asset = pickAssetForPlatform(assets, 'win32', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0.exe');
  });

  it('prefers AppImage over deb/rpm on linux', () => {
    const asset = pickAssetForPlatform(allAssets, 'linux', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0.AppImage');
  });

  it('falls back to .deb when AppImage is missing on linux', () => {
    const assets = [
      makeAsset('cerebro_1.0.0_amd64.deb'),
      makeAsset('cerebro-1.0.0.x86_64.rpm'),
    ];
    const asset = pickAssetForPlatform(assets, 'linux', 'x64');
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
    expect(
      pickAssetForPlatform([makeAsset('Cerebro.AppImage')], 'linux', 'x64')?.name,
    ).toBe('Cerebro.AppImage');
    expect(
      pickAssetForPlatform([makeAsset('Cerebro.APPIMAGE')], 'linux', 'x64')?.name,
    ).toBe('Cerebro.APPIMAGE');
  });

  it('returns null when no asset matches the platform', () => {
    const onlyLinux = [makeAsset('Cerebro-1.0.0.AppImage')];
    expect(pickAssetForPlatform(onlyLinux, 'darwin', 'arm64')).toBeNull();
    expect(pickAssetForPlatform(onlyLinux, 'win32', 'x64')).toBeNull();
  });

  it('returns null for unsupported platforms (freebsd, sunos, etc.)', () => {
    expect(
      pickAssetForPlatform(allAssets, 'freebsd' as NodeJS.Platform, 'x64'),
    ).toBeNull();
    expect(
      pickAssetForPlatform(allAssets, 'sunos' as NodeJS.Platform, 'x64'),
    ).toBeNull();
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
    const assets = [
      makeAsset('Cerebro-1.0.0-x64.dmg'),
      makeAsset('Cerebro-1.0.0-arm64.dmg'),
    ];
    const asset = pickAssetForPlatform(assets, 'darwin', 'arm64');
    expect(asset?.name).toBe('Cerebro-1.0.0-arm64.dmg');
  });

  it('picks the x64 DMG for an Intel Mac user', () => {
    const assets = [
      makeAsset('Cerebro-1.0.0-arm64.dmg'),
      makeAsset('Cerebro-1.0.0-x64.dmg'),
    ];
    const asset = pickAssetForPlatform(assets, 'darwin', 'x64');
    expect(asset?.name).toBe('Cerebro-1.0.0-x64.dmg');
  });

  it('treats x86_64 / amd64 / x64 as aliases for x64', () => {
    const assets = [
      makeAsset('Cerebro-1.0.0-arm64.dmg'),
      makeAsset('cerebro-1.0.0.x86_64.rpm'),
      makeAsset('cerebro_1.0.0_amd64.deb'),
    ];
    expect(pickAssetForPlatform(assets, 'linux', 'x64')?.name).toBe(
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
    expect(pickAssetForPlatform(assets, 'darwin', 'arm64')?.name).toBe(
      'Cerebro-1.0.0.dmg',
    );
    expect(pickAssetForPlatform(assets, 'darwin', 'x64')?.name).toBe(
      'Cerebro-1.0.0.dmg',
    );
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
