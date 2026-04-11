/**
 * Renderer-side mirror of the sandbox config. Every mutation round-trips to
 * the backend, then pushes the fresh config into the main-process cache so
 * the next `claude` spawn sees it without restart.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';
import type { LinkMode, LinkedProject, SandboxConfig } from '../sandbox/types';

interface SandboxContextValue {
  config: SandboxConfig | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  dismissBanner: () => Promise<void>;
  pickAndLinkProject: (mode?: LinkMode) => Promise<LinkedProject | null>;
  setLinkMode: (linkId: string, mode: LinkMode) => Promise<void>;
  removeLink: (linkId: string) => Promise<void>;
  revealWorkspace: () => Promise<void>;
  fetchProfile: () => Promise<string>;
  /** Last backend error (e.g. a rejected link path). Cleared on next action. */
  lastError: string | null;
  clearError: () => void;
}

const SandboxContext = createContext<SandboxContextValue | null>(null);

function extractBackendError(res: BackendResponse<unknown>): string {
  const data = res.data as { detail?: string; error?: string } | undefined;
  return data?.detail ?? data?.error ?? `Backend error ${res.status}`;
}

export function SandboxProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SandboxConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res: BackendResponse<SandboxConfig> = await window.cerebro.invoke({
        method: 'GET',
        path: '/sandbox/config',
      });
      if (res.ok) {
        setConfig(res.data);
        window.cerebro.sandbox.setCache(res.data).catch(() => undefined);
      }
    } catch {
      /* backend not ready yet — try again on next action */
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyResponse = useCallback((res: BackendResponse<SandboxConfig>) => {
    if (res.ok) {
      setConfig(res.data);
      setLastError(null);
      window.cerebro.sandbox.setCache(res.data).catch(() => undefined);
    } else {
      setLastError(extractBackendError(res));
    }
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const res: BackendResponse<SandboxConfig> = await window.cerebro.invoke({
        method: 'PATCH',
        path: '/sandbox/config',
        body: { enabled },
      });
      applyResponse(res);
    },
    [applyResponse],
  );

  const dismissBanner = useCallback(async () => {
    const res: BackendResponse<SandboxConfig> = await window.cerebro.invoke({
      method: 'PATCH',
      path: '/sandbox/config',
      body: { banner_dismissed: true },
    });
    applyResponse(res);
  }, [applyResponse]);

  const pickAndLinkProject = useCallback(
    async (mode: LinkMode = 'read'): Promise<LinkedProject | null> => {
      setLastError(null);
      const chosen = await window.cerebro.sandbox.pickDirectory();
      if (!chosen) return null;

      const res: BackendResponse<SandboxConfig> = await window.cerebro.invoke({
        method: 'POST',
        path: '/sandbox/links',
        body: { path: chosen, mode },
      });
      applyResponse(res);

      if (!res.ok || !res.data) return null;
      const linked = res.data.linked_projects ?? [];
      return linked[linked.length - 1] ?? null;
    },
    [applyResponse],
  );

  const setLinkMode = useCallback(
    async (linkId: string, mode: LinkMode) => {
      const res: BackendResponse<SandboxConfig> = await window.cerebro.invoke({
        method: 'PATCH',
        path: `/sandbox/links/${encodeURIComponent(linkId)}`,
        body: { mode },
      });
      applyResponse(res);
    },
    [applyResponse],
  );

  const removeLink = useCallback(
    async (linkId: string) => {
      const res: BackendResponse<SandboxConfig> = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/sandbox/links/${encodeURIComponent(linkId)}`,
      });
      applyResponse(res);
    },
    [applyResponse],
  );

  const revealWorkspace = useCallback(async () => {
    if (!config) return;
    await window.cerebro.sandbox.revealWorkspace(config.workspace_path);
  }, [config]);

  const fetchProfile = useCallback(async () => {
    try {
      return await window.cerebro.sandbox.getProfile();
    } catch {
      return '';
    }
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  const value = useMemo<SandboxContextValue>(
    () => ({
      config,
      isLoading,
      lastError,
      refresh,
      setEnabled,
      dismissBanner,
      pickAndLinkProject,
      setLinkMode,
      removeLink,
      revealWorkspace,
      fetchProfile,
      clearError,
    }),
    [
      config,
      isLoading,
      lastError,
      refresh,
      setEnabled,
      dismissBanner,
      pickAndLinkProject,
      setLinkMode,
      removeLink,
      revealWorkspace,
      fetchProfile,
      clearError,
    ],
  );

  return <SandboxContext.Provider value={value}>{children}</SandboxContext.Provider>;
}

export function useSandbox(): SandboxContextValue {
  const ctx = useContext(SandboxContext);
  if (!ctx) throw new Error('useSandbox must be used within SandboxProvider');
  return ctx;
}
