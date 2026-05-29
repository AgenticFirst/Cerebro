import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  UpdateInfo,
  UpdateDownloadProgress,
  UpdateDownloadedEvent,
  UpdateErrorEvent,
  UpdateErrorKind,
} from '../types/ipc';

// State machine:
//   idle → available → downloading → ready → applying → (quit) | error
//                                       ↑                          │
//                                       └──────── retry ───────────┘
//
// `ready` means: artifact is downloaded + verified intact on disk; we're
// waiting for the user to click "Restart now". Apply doesn't fire on its
// own — that's the whole reason this fix is safe. `applying` is the brief
// window where main is replacing the binary + verifying the new launch.
// On success the process quits; on failure we surface `error` with the
// underlying reason and the user can hit "Restart now" again.
type UpdateStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'applying'
  | 'error';

interface UpdateContextValue {
  status: UpdateStatus;
  info: UpdateInfo | null;
  progress: UpdateDownloadProgress | null;
  downloadedPath: string | null;
  errorMessage: string | null;
  /** Categorised failure kind so the banner picks the right reassuring
   *  copy + secondary action. `null` when there's no error to show. */
  errorKind: UpdateErrorKind | null;
  /** Seconds remaining before the next Retry click is allowed to fire.
   *  Zero means "go ahead now". Counts down in real time while > 0. The
   *  user can still click Retry — we just defer the actual IPC until the
   *  countdown reaches zero. Surfaced in the banner as "Retry in 12s…". */
  retryCooldownSeconds: number;
  isDismissed: boolean;
  startDownload: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismiss: () => void;
  openReleasePage: () => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

/**
 * Exponential backoff schedule applied after consecutive failed downloads.
 * The user can always click Retry — the cooldown only governs how long we
 * wait before *actually* hitting GitHub. Capping the schedule prevents a
 * locked-down environment from holding the renderer hostage for hours.
 *
 * Index = consecutiveFailures.
 *   0 failures: 0s (no error yet).
 *   1 failure : 0s — first retry is always instant; transient blips
 *               shouldn't cost the user a wait. THIS IS THE COMMON CASE.
 *   2 failures: 5s — now we're seeing a real problem, slow down.
 *   3 failures: 15s
 *   4 failures: 60s
 *   5+ failures: 300s (5 min cap)
 */
const RETRY_BACKOFF_SECONDS = [0, 0, 5, 15, 60, 300];

function backoffFor(failures: number): number {
  if (failures <= 0) return 0;
  const idx = Math.min(failures, RETRY_BACKOFF_SECONDS.length - 1);
  return RETRY_BACKOFF_SECONDS[idx];
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<UpdateErrorKind | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [retryCooldownSeconds, setRetryCooldownSeconds] = useState(0);
  // Pending retry click that's waiting for the cooldown to expire. Re-fires
  // the appropriate action (download/apply) the moment cooldown hits zero.
  const pendingRetryRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const offAvailable = window.cerebro.updater.onAvailable((next) => {
      setInfo(next);
      setStatus('available');
      setIsDismissed(false);
      setErrorMessage(null);
      setErrorKind(null);
      setProgress(null);
      setDownloadedPath(null);
      setConsecutiveFailures(0);
      setCooldownUntil(null);
      // Tell main the renderer is alive and showing the banner so the 5s
      // native-dialog fallback doesn't fire on top of it.
      void window.cerebro.updater.notified();
    });
    const offProgress = window.cerebro.updater.onProgress((p) => {
      setProgress(p);
    });
    const offDownloaded = window.cerebro.updater.onDownloaded((evt: UpdateDownloadedEvent) => {
      setDownloadedPath(evt.path);
      // `ready`, not `applying` — install does NOT happen automatically.
      // The user explicitly clicks "Restart now" in the banner to trigger it.
      setStatus('ready');
      // Successful download resets the backoff so the next genuine failure
      // starts the schedule fresh.
      setConsecutiveFailures(0);
      setCooldownUntil(null);
    });
    const offError = window.cerebro.updater.onError((event: UpdateErrorEvent) => {
      setErrorMessage(event.message);
      setErrorKind(event.kind);
      setStatus('error');
      setConsecutiveFailures((n) => {
        const next = n + 1;
        const wait = backoffFor(next);
        setCooldownUntil(wait > 0 ? Date.now() + wait * 1000 : null);
        return next;
      });
    });
    return () => {
      offAvailable();
      offProgress();
      offDownloaded();
      offError();
    };
  }, []);

  // Initial check in case the main process emitted UPDATE_AVAILABLE before
  // this provider mounted (e.g. very fast first check).
  useEffect(() => {
    let cancelled = false;
    window.cerebro.updater.checkNow().then((found) => {
      if (cancelled) return;
      if (found) {
        setInfo(found);
        setStatus((prev) => (prev === 'idle' ? 'available' : prev));
      }
    }).catch(() => {
      // Ignore — main process logs the error.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Countdown ticker. Active only while there's an outstanding cooldown.
  // Updates `retryCooldownSeconds` once per second so the banner can render
  // "Retry in Ns…". When the deadline lands, we fire any queued retry click.
  useEffect(() => {
    if (!cooldownUntil) {
      setRetryCooldownSeconds(0);
      // Cooldown ended (either naturally or because we cleared it on
      // success): release any pending retry that the user pre-clicked.
      const queued = pendingRetryRef.current;
      pendingRetryRef.current = null;
      if (queued) void queued();
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setRetryCooldownSeconds(remaining);
      if (remaining === 0) {
        setCooldownUntil(null);
      }
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [cooldownUntil]);

  /**
   * Schedule (or run immediately) an action that's subject to backoff. The
   * user's click is honoured — we just defer the IPC if we're still inside
   * the cooldown window. While deferred, the next cooldown-end tick fires
   * the queued action.
   */
  const runWithBackoff = useCallback(
    async (run: () => Promise<void>) => {
      if (!cooldownUntil || Date.now() >= cooldownUntil) {
        await run();
        return;
      }
      pendingRetryRef.current = run;
    },
    [cooldownUntil],
  );

  const performDownload = useCallback(async () => {
    if (!info) return;
    setStatus('downloading');
    setProgress({ transferred: 0, total: info.asset.size, percent: 0 });
    setErrorMessage(null);
    setErrorKind(null);
    try {
      await window.cerebro.updater.download(info.asset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      // onError(event) already set errorKind via the IPC event; this catch
      // only fires when the IPC itself bombed (extremely rare with the new
      // discriminated-result handler). Default to 'unknown' so the banner
      // still has a category to render with.
      setErrorKind((prev) => prev ?? 'unknown');
      setStatus('error');
    }
  }, [info]);

  const performApply = useCallback(async () => {
    if (!info) return;
    setStatus('applying');
    setErrorMessage(null);
    setErrorKind(null);
    try {
      // On success the main process app.quit()s shortly after this resolves,
      // so the renderer is torn down before we ever see the resolve.
      // On failure (e.g. new version exits early) main rolls back to the
      // previous install and rejects with a human-readable reason.
      await window.cerebro.updater.apply(info.asset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setErrorKind((prev) => prev ?? 'unknown');
      setStatus('error');
    }
  }, [info]);

  const startDownload = useCallback(async () => {
    await runWithBackoff(performDownload);
  }, [runWithBackoff, performDownload]);

  const applyUpdate = useCallback(async () => {
    // Apply isn't network-bound — no need to backoff. Run immediately so
    // the user can re-attempt as fast as they want (the rollback path is
    // safe to repeat).
    await performApply();
  }, [performApply]);

  const dismiss = useCallback(() => {
    setIsDismissed(true);
    void window.cerebro.updater.dismiss();
  }, []);

  const openReleasePage = useCallback(() => {
    if (info?.htmlUrl) {
      void window.cerebro.updater.openReleasePage(info.htmlUrl);
    }
  }, [info]);

  const value: UpdateContextValue = useMemo(
    () => ({
      status,
      info,
      progress,
      downloadedPath,
      errorMessage,
      errorKind,
      retryCooldownSeconds,
      isDismissed,
      startDownload,
      applyUpdate,
      dismiss,
      openReleasePage,
    }),
    [
      status,
      info,
      progress,
      downloadedPath,
      errorMessage,
      errorKind,
      retryCooldownSeconds,
      isDismissed,
      startDownload,
      applyUpdate,
      dismiss,
      openReleasePage,
    ],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error('useUpdate must be used within UpdateProvider');
  return ctx;
}
