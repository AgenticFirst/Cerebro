/**
 * Acceptance tests for the in-app update banner.
 *
 * The banner is the user-facing surface of the auto-updater. It must:
 *   1. Stay invisible when there's nothing to show.
 *   2. Render the right UI for each of the four states (available / downloading /
 *      downloaded / error).
 *   3. Wire its buttons to the right preload calls.
 *   4. Honor the "Later" dismissal so we don't nag the user.
 *
 * The preload bridge (window.cerebro.updater) is mocked so the renderer can be
 * driven through every state without involving the main process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UpdateProvider } from '../../../context/UpdateContext';
import UpdateBanner from '../UpdateBanner';
import type {
  UpdateInfo,
  UpdateDownloadProgress,
  UpdateDownloadedEvent,
} from '../../../types/ipc';

// ── window.cerebro.updater mock ─────────────────────────────────

type Listener<T> = (payload: T) => void;

interface BridgeMock {
  checkNow: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
  notified: ReturnType<typeof vi.fn>;
  openReleasePage: ReturnType<typeof vi.fn>;
  emitAvailable: (info: UpdateInfo) => void;
  emitProgress: (progress: UpdateDownloadProgress) => void;
  emitDownloaded: (evt: UpdateDownloadedEvent) => void;
  emitError: (msg: string) => void;
}

let availableListeners: Array<Listener<UpdateInfo>> = [];
let progressListeners: Array<Listener<UpdateDownloadProgress>> = [];
let downloadedListeners: Array<Listener<UpdateDownloadedEvent>> = [];
let errorListeners: Array<Listener<string>> = [];

function makeBridge(): BridgeMock {
  return {
    checkNow: vi.fn().mockResolvedValue(null),
    download: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    notified: vi.fn().mockResolvedValue(undefined),
    openReleasePage: vi.fn().mockResolvedValue(undefined),
    emitAvailable: (info) => act(() => availableListeners.forEach((cb) => cb(info))),
    emitProgress: (p) => act(() => progressListeners.forEach((cb) => cb(p))),
    emitDownloaded: (e) => act(() => downloadedListeners.forEach((cb) => cb(e))),
    emitError: (msg) => act(() => errorListeners.forEach((cb) => cb(msg))),
  };
}

let bridge: BridgeMock;

beforeEach(() => {
  availableListeners = [];
  progressListeners = [];
  downloadedListeners = [];
  errorListeners = [];
  bridge = makeBridge();
  (window as unknown as { cerebro: unknown }).cerebro = {
    updater: {
      checkNow: bridge.checkNow,
      download: bridge.download,
      dismiss: bridge.dismiss,
      notified: bridge.notified,
      openReleasePage: bridge.openReleasePage,
      onAvailable: (cb: Listener<UpdateInfo>) => {
        availableListeners.push(cb);
        return () => {
          availableListeners = availableListeners.filter((l) => l !== cb);
        };
      },
      onProgress: (cb: Listener<UpdateDownloadProgress>) => {
        progressListeners.push(cb);
        return () => {
          progressListeners = progressListeners.filter((l) => l !== cb);
        };
      },
      onDownloaded: (cb: Listener<UpdateDownloadedEvent>) => {
        downloadedListeners.push(cb);
        return () => {
          downloadedListeners = downloadedListeners.filter((l) => l !== cb);
        };
      },
      onError: (cb: Listener<string>) => {
        errorListeners.push(cb);
        return () => {
          errorListeners = errorListeners.filter((l) => l !== cb);
        };
      },
    },
  };
});

afterEach(() => {
  cleanup();
});

const SAMPLE_INFO: UpdateInfo = {
  version: '0.3.0',
  name: 'v0.3.0',
  notes: 'Adds auto-update support and fixes assorted UI glitches.',
  htmlUrl: 'https://github.com/AgenticFirst/Cerebro/releases/tag/v0.3.0',
  asset: {
    name: 'Cerebro-0.3.0.dmg',
    url: 'https://example.com/Cerebro-0.3.0.dmg',
    size: 250_000_000,
    contentType: 'application/octet-stream',
  },
};

function renderBanner() {
  return render(
    <UpdateProvider>
      <UpdateBanner />
    </UpdateProvider>,
  );
}

// ── State 0: idle ───────────────────────────────────────────────

describe('UpdateBanner — idle', () => {
  it('renders nothing when no update has been announced', () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });
});

// ── State 1: available ──────────────────────────────────────────

describe('UpdateBanner — available', () => {
  it('shows the version + notes + Update now button when an update arrives', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);

    expect(screen.getByText(/Cerebro 0\.3\.0 is available/i)).toBeInTheDocument();
    expect(screen.getByText(/Adds auto-update support/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view release notes/i })).toBeInTheDocument();
  });

  it('calls window.cerebro.updater.download with the right asset on "Update now"', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    expect(bridge.download).toHaveBeenCalledTimes(1);
    expect(bridge.download).toHaveBeenCalledWith(SAMPLE_INFO.asset);
  });

  it('calls openReleasePage with the release URL on "View release notes"', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /view release notes/i }));
    expect(bridge.openReleasePage).toHaveBeenCalledWith(SAMPLE_INFO.htmlUrl);
  });

  it('hides the banner when the user clicks the "X" dismiss button', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    expect(screen.getByText(/is available/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/dismiss update banner/i));
    expect(screen.queryByText(/is available/i)).not.toBeInTheDocument();
    expect(bridge.dismiss).toHaveBeenCalledTimes(1);
  });
});

// ── State 2: downloading ────────────────────────────────────────

describe('UpdateBanner — downloading', () => {
  it('switches to the downloading state with a progress bar', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));

    expect(screen.getByText(/Downloading Cerebro 0\.3\.0/i)).toBeInTheDocument();
  });

  it('renders human-readable byte progress as new chunks arrive', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));

    bridge.emitProgress({
      transferred: 50_000_000,
      total: 250_000_000,
      percent: 20,
    });
    expect(screen.getByText(/47\.7 MB \/ 238\.4 MB \(20%\)/i)).toBeInTheDocument();
  });

  it('hides the dismiss "X" while a download is in flight (no accidental aborts)', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    expect(screen.queryByLabelText(/dismiss update banner/i)).not.toBeInTheDocument();
  });
});

// ── State 3: downloaded ─────────────────────────────────────────

describe('UpdateBanner — downloaded', () => {
  it('shows the "open installer" message after downloaded event fires', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    bridge.emitDownloaded({
      path: '/tmp/Cerebro-0.3.0.dmg',
      asset: SAMPLE_INFO.asset,
    });

    expect(screen.getByText(/Update downloaded/i)).toBeInTheDocument();
    expect(screen.getByText(/Cerebro 0\.3\.0/i)).toBeInTheDocument();
  });
});

// ── State 4: error ──────────────────────────────────────────────

describe('UpdateBanner — error', () => {
  it('shows the error message + retry + open release page actions', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    bridge.emitError('Network unreachable');

    expect(screen.getByText(/Couldn't download the update/i)).toBeInTheDocument();
    expect(screen.getByText(/Network unreachable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open release page/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('retry triggers another download attempt with the same asset', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    bridge.emitError('Network unreachable');
    bridge.download.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(bridge.download).toHaveBeenCalledTimes(1);
    expect(bridge.download).toHaveBeenCalledWith(SAMPLE_INFO.asset);
  });

  it('"open release page" deep-links to the GitHub release', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    fireEvent.click(screen.getByRole('button', { name: /update now/i }));
    bridge.emitError('boom');

    fireEvent.click(screen.getByRole('button', { name: /open release page/i }));
    expect(bridge.openReleasePage).toHaveBeenCalledWith(SAMPLE_INFO.htmlUrl);
  });
});

// ── Initial poll wiring ─────────────────────────────────────────

describe('UpdateBanner — initial poll', () => {
  it('asks the main process for the latest release on mount', () => {
    renderBanner();
    expect(bridge.checkNow).toHaveBeenCalledTimes(1);
  });
});

// ── Native-dialog suppression ───────────────────────────────────

describe('UpdateBanner — native-dialog ack', () => {
  it('calls updater.notified() when an update arrives so the 5s native dialog is suppressed', () => {
    renderBanner();
    expect(bridge.notified).not.toHaveBeenCalled();
    bridge.emitAvailable(SAMPLE_INFO);
    expect(bridge.notified).toHaveBeenCalledTimes(1);
  });

  it('re-acks each time a NEW version arrives (regression: stale ack would let dialog fire)', () => {
    renderBanner();
    bridge.emitAvailable(SAMPLE_INFO);
    expect(bridge.notified).toHaveBeenCalledTimes(1);

    const newer: UpdateInfo = {
      ...SAMPLE_INFO,
      version: '0.4.0',
      asset: { ...SAMPLE_INFO.asset, name: 'Cerebro-0.4.0.dmg' },
    };
    bridge.emitAvailable(newer);
    expect(bridge.notified).toHaveBeenCalledTimes(2);
  });
});
