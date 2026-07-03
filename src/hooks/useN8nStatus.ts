/**
 * Shared n8n status subscription used by the Flows screen, the Integrations
 * section, and the connect modal — one polling/push pattern instead of three.
 *
 * Status arrives via push (N8N_STATUS_CHANGED) with an initial fetch on mount;
 * install log lines are buffered here (capped) so any subscriber can render
 * the streaming npm output.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { N8nStatusResponse } from '../types/ipc';

const MAX_LOG_LINES = 200;

export interface UseN8nStatusResult {
  status: N8nStatusResponse | null;
  installLog: string[];
  installing: boolean;
  /** Kicks off install → start; resolves when the chain finishes or fails. */
  installAndStart: () => Promise<{ ok: boolean; error?: string }>;
  cancelInstall: () => void;
  start: () => Promise<{ ok: boolean; error?: string }>;
  stop: () => Promise<void>;
}

export function useN8nStatus(): UseN8nStatusResult {
  const [status, setStatus] = useState<N8nStatusResponse | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void window.cerebro.n8n.status().then((s) => {
      if (mounted.current) setStatus(s);
    });
    const offStatus = window.cerebro.n8n.onStatusChanged((s) => {
      if (mounted.current) setStatus(s);
    });
    const offLog = window.cerebro.n8n.onInstallLog((line) => {
      if (mounted.current) {
        setInstallLog((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), line]);
      }
    });
    return () => {
      mounted.current = false;
      offStatus();
      offLog();
    };
  }, []);

  const installAndStart = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setInstalling(true);
    setInstallLog([]);
    try {
      const res = await window.cerebro.n8n.install();
      if (!res.ok) return res;
      return await window.cerebro.n8n.start();
    } finally {
      if (mounted.current) setInstalling(false);
    }
  }, []);

  const cancelInstall = useCallback(() => {
    void window.cerebro.n8n.cancelInstall();
  }, []);

  const start = useCallback(() => window.cerebro.n8n.start(), []);

  const stop = useCallback(async () => {
    await window.cerebro.n8n.stop();
  }, []);

  return { status, installLog, installing, installAndStart, cancelInstall, start, stop };
}
