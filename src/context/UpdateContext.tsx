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

type UpdateStatus = 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';

interface UpdateContextValue {
  status: UpdateStatus;
  info: UpdateInfo | null;
  progress: UpdateDownloadProgress | null;
  downloadedPath: string | null;
  errorMessage: string | null;
  isDismissed: boolean;
  startDownload: () => Promise<void>;
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
      setStatus('downloaded');
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
