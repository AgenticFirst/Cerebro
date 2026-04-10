import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import type { ClaudeCodeInfo } from '../types/providers';

interface ProviderState {
  claudeCodeInfo: ClaudeCodeInfo;
}

interface ProviderActions {
  refreshClaudeCodeStatus: () => Promise<void>;
}

type ProviderContextValue = ProviderState & ProviderActions;

const ProviderContext = createContext<ProviderContextValue | null>(null);

export function ProviderProvider({ children }: { children: ReactNode }) {
  const [claudeCodeInfo, setClaudeCodeInfo] = useState<ClaudeCodeInfo>({ status: 'unknown' });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshClaudeCodeStatus = useCallback(async () => {
    try {
      const info = await window.cerebro.claudeCode.detect();
      if (mountedRef.current) {
        setClaudeCodeInfo(info);
      }
    } catch {
      if (mountedRef.current) {
        setClaudeCodeInfo({ status: 'error', error: 'Detection failed' });
      }
    }
  }, []);

  // Detect Claude Code on startup (after backend is healthy so we don't race the spawn)
  useEffect(() => {
    let cancelled = false;

    async function init() {
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

      try {
        const info = await window.cerebro.claudeCode.getStatus();
        if (!cancelled) setClaudeCodeInfo(info);
      } catch {
        if (!cancelled) setClaudeCodeInfo({ status: 'error', error: 'Detection failed' });
      }
    }

    init().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ProviderContext.Provider
      value={{
        claudeCodeInfo,
        refreshClaudeCodeStatus,
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
