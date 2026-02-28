import { useState, useCallback, useRef, useEffect } from 'react';
import type { DownloadProgress } from '../types/models';

interface UseModelDownloadResult {
  progress: DownloadProgress | null;
  isActive: boolean;
  start: (modelId: string) => Promise<void>;
  cancel: (modelId: string) => Promise<void>;
}

export function useModelDownload(onComplete?: () => void): UseModelDownloadResult {
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [isActive, setIsActive] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, []);

  const start = useCallback(
    async (modelId: string) => {
      // Start download
      const res = await window.cerebro.invoke({
        method: 'POST',
        path: `/models/${modelId}/download`,
      });

      if (!res.ok) {
        const data = res.data as { detail?: string };
        throw new Error(data.detail ?? 'Failed to start download');
      }

      setIsActive(true);
      setProgress({
        status: 'downloading',
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0,
        eta_seconds: 0,
      });

      // Open SSE stream for progress
      const streamId = await window.cerebro.startStream({
        method: 'GET',
        path: `/models/${modelId}/download/progress`,
      });

      const unsub = window.cerebro.onStream(streamId, (event) => {
        if (!mountedRef.current) return;

        if (event.event === 'data') {
          try {
            const data: DownloadProgress = JSON.parse(event.data);
            setProgress(data);

            if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'error') {
              setIsActive(false);
              if (data.status === 'completed') {
                onComplete?.();
              }
            }
          } catch {
            // ignore parse errors
          }
        } else if (event.event === 'end') {
          setIsActive(false);
        } else if (event.event === 'error') {
          setIsActive(false);
          setProgress((prev) =>
            prev ? { ...prev, status: 'error', error: event.data } : null,
          );
        }
      });

      unsubRef.current = unsub;
    },
    [onComplete],
  );

  const cancel = useCallback(async (modelId: string) => {
    await window.cerebro.invoke({
      method: 'POST',
      path: `/models/${modelId}/download/cancel`,
    });
  }, []);

  return { progress, isActive, start, cancel };
}
