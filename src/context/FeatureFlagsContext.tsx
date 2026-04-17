import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadSetting, saveSetting } from '../lib/settings';

export type BetaFeatureKey = never;

export interface BetaFeatureDef {
  key: BetaFeatureKey;
  labelKey: string;
  descriptionKey: string;
}

/** Registry of beta features. Add an entry here + extend BetaFeatureKey to ship a new gated feature. */
export const BETA_FEATURES: BetaFeatureDef[] = [];

type Flags = Record<BetaFeatureKey, boolean>;

const DEFAULT_FLAGS: Flags = {} as Flags;

interface FeatureFlagsContextValue {
  flags: Flags;
  isLoading: boolean;
  setFlag: (key: BetaFeatureKey, enabled: boolean) => void;
}

const FeatureFlagsContext = createContext<FeatureFlagsContextValue | null>(null);

function settingKey(key: BetaFeatureKey): string {
  return `beta:${key}`;
}

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [flags, setFlags] = useState<Flags>(DEFAULT_FLAGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        BETA_FEATURES.map(async (f) => {
          const value = await loadSetting<boolean>(settingKey(f.key));
          return [f.key, value ?? false] as const;
        }),
      );
      if (!cancelled) {
        setFlags((prev) => {
          const next = { ...prev };
          for (const [k, v] of entries) next[k] = v;
          return next;
        });
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setFlag = useCallback((key: BetaFeatureKey, enabled: boolean) => {
    setFlags((prev) => {
      if (prev[key] === enabled) return prev;
      return { ...prev, [key]: enabled };
    });
    saveSetting(settingKey(key), enabled);
  }, []);

  const value = useMemo(
    () => ({ flags, isLoading, setFlag }),
    [flags, isLoading, setFlag],
  );

  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlagsContextValue {
  const ctx = useContext(FeatureFlagsContext);
  if (!ctx) throw new Error('useFeatureFlags must be used within FeatureFlagsProvider');
  return ctx;
}
