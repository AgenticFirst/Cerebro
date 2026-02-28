import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type {
  LocalModel,
  EngineStatus,
  HardwareInfo,
  DownloadProgress,
  ModelCatalogResponse,
} from '../types/models';
import type { DiskSpace } from '../types/ipc';

interface ModelState {
  catalog: LocalModel[];
  engineStatus: EngineStatus;
  activeDownloads: Map<string, DownloadProgress>;
  diskSpace: DiskSpace | null;
  hardware: HardwareInfo | null;
  recommendedModelId: string | null;
  isLoading: boolean;
  error: string | null;
}

interface ModelActions {
  refreshCatalog: () => Promise<void>;
  downloadModel: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  deleteModel: (modelId: string) => Promise<void>;
  loadModel: (modelId: string) => Promise<void>;
  unloadModel: () => Promise<void>;
  refreshDiskSpace: () => Promise<void>;
}

type ModelContextValue = ModelState &
  ModelActions & {
    downloadedModels: LocalModel[];
    activeModel: LocalModel | undefined;
  };

const ModelContext = createContext<ModelContextValue | null>(null);

export function ModelProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<LocalModel[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus>({
    state: 'idle',
    loaded_model_id: null,
    error: null,
  });
  const [activeDownloads, setActiveDownloads] = useState<Map<string, DownloadProgress>>(new Map());
  const [diskSpace, setDiskSpace] = useState<DiskSpace | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [recommendedModelId, setRecommendedModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshCatalog = useCallback(async () => {
    try {
      const res = await window.cerebro.invoke<ModelCatalogResponse>({
        method: 'GET',
        path: '/models/catalog',
      });
      if (res.ok && mountedRef.current) {
        setCatalog(res.data.models);
        setRecommendedModelId(res.data.recommended_model_id);
      }
    } catch (e) {
      console.error('Failed to fetch catalog:', e);
    }
  }, []);

  const refreshEngineStatus = useCallback(async () => {
    try {
      const res = await window.cerebro.invoke<EngineStatus>({
        method: 'GET',
        path: '/models/status',
      });
      if (res.ok && mountedRef.current) {
        setEngineStatus(res.data);
      }
    } catch (e) {
      console.error('Failed to fetch engine status:', e);
    }
  }, []);

  const refreshHardware = useCallback(async () => {
    try {
      const res = await window.cerebro.invoke<HardwareInfo>({
        method: 'GET',
        path: '/models/hardware',
      });
      if (res.ok && mountedRef.current) {
        setHardware(res.data);
      }
    } catch (e) {
      console.error('Failed to fetch hardware:', e);
    }
  }, []);

  const refreshDiskSpace = useCallback(async () => {
    try {
      const ds = await window.cerebro.models.getDiskSpace();
      if (mountedRef.current) {
        setDiskSpace(ds);
      }
    } catch (e) {
      console.error('Failed to fetch disk space:', e);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Wait for backend to be healthy
      const maxRetries = 15;
      for (let i = 0; i < maxRetries; i++) {
        try {
          const status = await window.cerebro.getStatus();
          if (status === 'healthy') break;
        } catch {
          /* not ready */
        }
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (cancelled) return;

      await Promise.all([refreshCatalog(), refreshEngineStatus(), refreshHardware(), refreshDiskSpace()]);
      if (!cancelled) setIsLoading(false);
    }

    init().catch((e) => {
      console.error('Model context init failed:', e);
      if (!cancelled) {
        setError('Failed to load model information');
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [refreshCatalog, refreshEngineStatus, refreshHardware, refreshDiskSpace]);

  const downloadModel = useCallback(
    async (modelId: string) => {
      const res = await window.cerebro.invoke<{ ok: boolean; detail?: string }>({
        method: 'POST',
        path: `/models/${modelId}/download`,
      });

      if (!res.ok) {
        const data = res.data as { detail?: string };
        throw new Error(data.detail ?? 'Failed to start download');
      }

      // Set initial download progress
      setActiveDownloads((prev) => {
        const next = new Map(prev);
        next.set(modelId, {
          status: 'downloading',
          downloaded_bytes: 0,
          total_bytes: 0,
          speed_bps: 0,
          eta_seconds: 0,
        });
        return next;
      });

      // Open SSE stream for progress
      const streamId = await window.cerebro.startStream({
        method: 'GET',
        path: `/models/${modelId}/download/progress`,
      });

      window.cerebro.onStream(streamId, (event) => {
        if (!mountedRef.current) return;

        if (event.event === 'data') {
          try {
            const data: DownloadProgress = JSON.parse(event.data);
            setActiveDownloads((prev) => {
              const next = new Map(prev);
              next.set(modelId, data);
              return next;
            });

            if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'error') {
              // Remove from active downloads after a brief delay so UI can show final state
              setTimeout(() => {
                if (mountedRef.current) {
                  setActiveDownloads((prev) => {
                    const next = new Map(prev);
                    next.delete(modelId);
                    return next;
                  });
                  // Refresh catalog to get updated model status
                  refreshCatalog();
                  refreshDiskSpace();
                }
              }, 500);
            }
          } catch {
            // ignore parse errors
          }
        } else if (event.event === 'end' || event.event === 'error') {
          setActiveDownloads((prev) => {
            const next = new Map(prev);
            next.delete(modelId);
            return next;
          });
          refreshCatalog();
        }
      });
    },
    [refreshCatalog, refreshDiskSpace],
  );

  const cancelDownload = useCallback(async (modelId: string) => {
    await window.cerebro.invoke({
      method: 'POST',
      path: `/models/${modelId}/download/cancel`,
    });
  }, []);

  const deleteModel = useCallback(
    async (modelId: string) => {
      const res = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/models/${modelId}`,
      });
      if (res.ok) {
        await refreshCatalog();
        await refreshDiskSpace();
      }
    },
    [refreshCatalog, refreshDiskSpace],
  );

  const loadModel = useCallback(
    async (modelId: string) => {
      setEngineStatus((prev) => ({ ...prev, state: 'loading', loaded_model_id: modelId }));
      try {
        const res = await window.cerebro.invoke({
          method: 'POST',
          path: `/models/${modelId}/load`,
          timeout: 120_000,
        });
        if (res.ok) {
          setEngineStatus({ state: 'ready', loaded_model_id: modelId, error: null });
        } else {
          const data = res.data as { detail?: string };
          setEngineStatus({
            state: 'error',
            loaded_model_id: null,
            error: data.detail ?? 'Failed to load model',
          });
        }
      } catch (e) {
        setEngineStatus({
          state: 'error',
          loaded_model_id: null,
          error: e instanceof Error ? e.message : 'Failed to load model',
        });
      }
    },
    [],
  );

  const unloadModel = useCallback(async () => {
    await window.cerebro.invoke({
      method: 'POST',
      path: '/models/unload',
    });
    setEngineStatus({ state: 'idle', loaded_model_id: null, error: null });
  }, []);

  const downloadedModels = catalog.filter((m) => m.status === 'downloaded');
  const activeModel = catalog.find((m) => m.id === engineStatus.loaded_model_id);

  return (
    <ModelContext.Provider
      value={{
        catalog,
        engineStatus,
        activeDownloads,
        diskSpace,
        hardware,
        recommendedModelId,
        isLoading,
        error,
        downloadedModels,
        activeModel,
        refreshCatalog,
        downloadModel,
        cancelDownload,
        deleteModel,
        loadModel,
        unloadModel,
        refreshDiskSpace,
      }}
    >
      {children}
    </ModelContext.Provider>
  );
}

export function useModels(): ModelContextValue {
  const ctx = useContext(ModelContext);
  if (!ctx) throw new Error('useModels must be used within ModelProvider');
  return ctx;
}
