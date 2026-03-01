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
  CloudProvider,
  SelectedModel,
  ConnectionStatus,
  ProviderConnectionState,
} from '../types/providers';

// No models enabled by default — user must add an API key first
const DEFAULT_ENABLED_MODELS: string[] = [];

export interface CustomModel {
  provider: CloudProvider;
  id: string;
  name: string;
}

interface ProviderState {
  selectedModel: SelectedModel | null;
  enabledModels: Set<string>;
  connectionStatus: Record<string, ProviderConnectionState>;
  customModels: CustomModel[];
}

interface ProviderActions {
  selectModel: (model: SelectedModel | null) => void;
  toggleModel: (modelId: string, enabled: boolean) => void;
  addCustomModel: (provider: CloudProvider, modelId: string) => void;
  removeCustomModel: (modelId: string) => void;
  verifyConnection: (provider: CloudProvider) => Promise<void>;
  refreshConnectionStatus: () => Promise<void>;
  setProviderStatus: (provider: string, state: ProviderConnectionState) => void;
}

type ProviderContextValue = ProviderState & ProviderActions;

const ProviderContext = createContext<ProviderContextValue | null>(null);

// ── Settings API helpers ────────────────────────────────────────

async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const res = await window.cerebro.invoke<{ value: string }>({
      method: 'GET',
      path: `/settings/${key}`,
    });
    if (res.ok) {
      return JSON.parse(res.data.value) as T;
    }
  } catch {
    // Setting doesn't exist or parse error
  }
  return null;
}

function saveSetting(key: string, value: unknown): void {
  window.cerebro
    .invoke({
      method: 'PUT',
      path: `/settings/${key}`,
      body: { value: JSON.stringify(value) },
    })
    .catch(console.error);
}

export function ProviderProvider({ children }: { children: ReactNode }) {
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(null);
  const [enabledModels, setEnabledModels] = useState<Set<string>>(
    new Set(DEFAULT_ENABLED_MODELS),
  );
  const [connectionStatus, setConnectionStatus] = useState<
    Record<string, ProviderConnectionState>
  >({
    anthropic: { status: 'not_configured' },
    openai: { status: 'not_configured' },
    google: { status: 'not_configured' },
  });
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch provider key status from backend
  const refreshConnectionStatus = useCallback(async () => {
    try {
      const res = await window.cerebro.invoke<Record<string, { has_key: boolean }>>({
        method: 'GET',
        path: '/cloud/status',
      });
      if (res.ok && mountedRef.current) {
        setConnectionStatus((prev) => {
          const next = { ...prev };
          for (const [provider, info] of Object.entries(res.data)) {
            const current = prev[provider];
            // Only update to key_saved/not_configured if we're not in a richer state
            if (!current || current.status === 'not_configured' || current.status === 'key_saved') {
              next[provider] = {
                status: info.has_key ? 'key_saved' : 'not_configured',
              };
            } else if (!info.has_key) {
              // Key was removed — reset
              next[provider] = { status: 'not_configured' };
            }
          }
          return next;
        });
      }
    } catch {
      // Backend not ready
    }
  }, []);

  // Verify a provider's connection
  const verifyConnection = useCallback(
    async (provider: CloudProvider) => {
      setConnectionStatus((prev) => ({
        ...prev,
        [provider]: { status: 'verifying' as ConnectionStatus },
      }));

      try {
        const res = await window.cerebro.invoke<{
          ok: boolean;
          provider: string;
          error: string | null;
        }>({
          method: 'POST',
          path: '/cloud/verify',
          body: { provider },
        });

        if (!mountedRef.current) return;

        if (res.ok && res.data.ok) {
          setConnectionStatus((prev) => ({
            ...prev,
            [provider]: { status: 'connected' as ConnectionStatus },
          }));
        } else {
          setConnectionStatus((prev) => ({
            ...prev,
            [provider]: {
              status: 'error' as ConnectionStatus,
              error: res.data.error || 'Verification failed',
            },
          }));
        }
      } catch (e) {
        if (!mountedRef.current) return;
        setConnectionStatus((prev) => ({
          ...prev,
          [provider]: {
            status: 'error' as ConnectionStatus,
            error: e instanceof Error ? e.message : 'Verification failed',
          },
        }));
      }
    },
    [],
  );

  // Directly set a provider's connection status (used when key is removed/saved)
  const setProviderStatus = useCallback(
    (provider: string, state: ProviderConnectionState) => {
      setConnectionStatus((prev) => ({ ...prev, [provider]: state }));
      // If status is being reset to not_configured, clear selection for that provider
      if (state.status === 'not_configured') {
        setSelectedModel((prev) => {
          if (prev && prev.source === 'cloud' && prev.provider === provider) {
            window.cerebro
              .invoke({ method: 'DELETE', path: '/settings/selected_model' })
              .catch(console.error);
            return null;
          }
          return prev;
        });
      }
    },
    [],
  );

  // Select model and persist
  const selectModel = useCallback((model: SelectedModel | null) => {
    setSelectedModel(model);
    if (model) {
      saveSetting('selected_model', model);
    } else {
      window.cerebro
        .invoke({ method: 'DELETE', path: '/settings/selected_model' })
        .catch(console.error);
    }
  }, []);

  // Toggle cloud model enabled/disabled and persist
  const toggleModel = useCallback(
    (modelId: string, enabled: boolean) => {
      setEnabledModels((prev) => {
        const next = new Set(prev);
        if (enabled) {
          next.add(modelId);
        } else {
          next.delete(modelId);
        }
        saveSetting('enabled_models', Array.from(next));
        return next;
      });
    },
    [],
  );

  // Add a custom model ID for a provider
  const addCustomModel = useCallback(
    (provider: CloudProvider, modelId: string) => {
      const trimmed = modelId.trim();
      if (!trimmed) return;
      setCustomModels((prev) => {
        if (prev.some((m) => m.id === trimmed)) return prev;
        const next = [...prev, { provider, id: trimmed, name: trimmed }];
        saveSetting('custom_models', next);
        return next;
      });
      // Auto-enable the custom model
      setEnabledModels((prev) => {
        const next = new Set(prev);
        next.add(trimmed);
        saveSetting('enabled_models', Array.from(next));
        return next;
      });
    },
    [],
  );

  // Remove a custom model
  const removeCustomModel = useCallback(
    (modelId: string) => {
      setCustomModels((prev) => {
        const next = prev.filter((m) => m.id !== modelId);
        saveSetting('custom_models', next);
        return next;
      });
      setEnabledModels((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        saveSetting('enabled_models', Array.from(next));
        return next;
      });
      // Clear selection if the removed model was selected
      setSelectedModel((prev) => {
        if (prev && prev.modelId === modelId) {
          window.cerebro
            .invoke({ method: 'DELETE', path: '/settings/selected_model' })
            .catch(console.error);
          return null;
        }
        return prev;
      });
    },
    [],
  );

  // Load persisted settings on startup
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Wait for backend
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

      // Load settings in parallel
      const [savedModel, savedEnabled, savedCustom] = await Promise.all([
        loadSetting<SelectedModel>('selected_model'),
        loadSetting<string[]>('enabled_models'),
        loadSetting<CustomModel[]>('custom_models'),
      ]);

      if (cancelled) return;

      if (savedModel) {
        setSelectedModel(savedModel);
      }
      if (savedEnabled) {
        setEnabledModels(new Set(savedEnabled));
      }
      if (savedCustom) {
        setCustomModels(savedCustom);
      }

      // Load connection status
      await refreshConnectionStatus();
    }

    init().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [refreshConnectionStatus]);

  return (
    <ProviderContext.Provider
      value={{
        selectedModel,
        enabledModels,
        connectionStatus,
        customModels,
        selectModel,
        toggleModel,
        addCustomModel,
        removeCustomModel,
        verifyConnection,
        refreshConnectionStatus,
        setProviderStatus,
      }}
    >
      {children}
    </ProviderContext.Provider>
  );
}

export function useProviders(): ProviderContextValue {
  const ctx = useContext(ProviderContext);
  if (!ctx) throw new Error('useProviders must be used within ProviderProvider');
  return ctx;
}
