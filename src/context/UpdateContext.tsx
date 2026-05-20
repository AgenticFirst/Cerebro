import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type {
  UpdateInfo,
  UpdateDownloadProgress,
  UpdateDownloadedEvent,
} from '../types/ipc';

// State machine:
//   idle → available → downloading → ready → applying → (quit) | error
//                                       ↑                          │
//                                       └──────── retry ───────────┘
//
// `ready` means: artifact is downloaded and verified intact on disk; we're
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
  isDismissed: boolean;
  startDownload: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismiss: () => void;
  openReleasePage: () => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    const offAvailable = window.cerebro.updater.onAvailable((next) => {
      setInfo(next);
      setStatus('available');
      setIsDismissed(false);
      setErrorMessage(null);
      setProgress(null);
      setDownloadedPath(null);
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
    });
    const offError = window.cerebro.updater.onError((msg) => {
      setErrorMessage(msg);
      setStatus('error');
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

  const startDownload = useCallback(async () => {
    if (!info) return;
    setStatus('downloading');
    setProgress({ transferred: 0, total: info.asset.size, percent: 0 });
    setErrorMessage(null);
    try {
      await window.cerebro.updater.download(info.asset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStatus('error');
    }
  }, [info]);

  const applyUpdate = useCallback(async () => {
    if (!info) return;
    setStatus('applying');
    setErrorMessage(null);
    try {
      // On success the main process app.quit()s shortly after this resolves,
      // so the renderer is torn down before we ever see the resolve.
      // On failure (e.g. new version exits early) main rolls back to the
      // previous install and rejects with a human-readable reason.
      await window.cerebro.updater.apply(info.asset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(message);
      setStatus('error');
    }
  }, [info]);

  const dismiss = useCallback(() => {
    setIsDismissed(true);
    void window.cerebro.updater.dismiss();
  }, []);

  const openReleasePage = useCallback(() => {
    if (info?.htmlUrl) {
      void window.cerebro.updater.openReleasePage(info.htmlUrl);
    }
  }, [info]);

  const value: UpdateContextValue = {
    status,
    info,
    progress,
    downloadedPath,
    errorMessage,
    isDismissed,
    startDownload,
    applyUpdate,
    dismiss,
    openReleasePage,
  };

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error('useUpdate must be used within UpdateProvider');
  return ctx;
}
