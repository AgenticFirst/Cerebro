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
import {
  QUALITY_TIERS,
  RESPONSE_MODELS,
  type QualityTier,
  type ResponseModel,
} from '../types/ipc';

const TIER_STORAGE_KEY = 'cerebro_quality_tier';
const TIER_SETTING_KEY = 'quality_tier';
const MODEL_STORAGE_KEY = 'cerebro_response_model';
const MODEL_SETTING_KEY = 'response_model';

interface QualityContextValue {
  tier: QualityTier;
  setTier: (tier: QualityTier) => void;
  model: ResponseModel;
  setModel: (model: ResponseModel) => void;
}

const QualityContext = createContext<QualityContextValue | null>(null);

function isValidTier(v: unknown): v is QualityTier {
  return typeof v === 'string' && (QUALITY_TIERS as readonly string[]).includes(v);
}

function isValidModel(v: unknown): v is ResponseModel {
  return typeof v === 'string' && (RESPONSE_MODELS as readonly string[]).includes(v);
}

export function QualityProvider({ children }: { children: ReactNode }) {
  const [tier, setTierState] = useState<QualityTier>(() => {
    try {
      const saved = localStorage.getItem(TIER_STORAGE_KEY);
      if (isValidTier(saved)) return saved;
    } catch { /* private mode */ }
    return 'medium';
  });

  const [model, setModelState] = useState<ResponseModel>(() => {
    try {
      const saved = localStorage.getItem(MODEL_STORAGE_KEY);
      if (isValidModel(saved)) return saved;
    } catch { /* private mode */ }
    return 'sonnet';
  });

  // Hydrate from backend once on mount; localStorage may be stale.
  useEffect(() => {
    let cancelled = false;
    loadSetting<QualityTier>(TIER_SETTING_KEY).then((v) => {
      if (cancelled) return;
      if (isValidTier(v)) setTierState((prev) => (prev === v ? prev : v));
    });
    loadSetting<ResponseModel>(MODEL_SETTING_KEY).then((v) => {
      if (cancelled) return;
      if (isValidModel(v)) setModelState((prev) => (prev === v ? prev : v));
    });
    return () => { cancelled = true; };
  }, []);

  const setTier = useCallback((next: QualityTier) => {
    setTierState(next);
    try { localStorage.setItem(TIER_STORAGE_KEY, next); } catch { /* private mode */ }
    saveSetting(TIER_SETTING_KEY, next);
  }, []);

  const setModel = useCallback((next: ResponseModel) => {
    setModelState(next);
    try { localStorage.setItem(MODEL_STORAGE_KEY, next); } catch { /* private mode */ }
    saveSetting(MODEL_SETTING_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ tier, setTier, model, setModel }),
    [tier, setTier, model, setModel],
  );

  return <QualityContext.Provider value={value}>{children}</QualityContext.Provider>;
}

export function useQualityTier(): QualityContextValue {
  const ctx = useContext(QualityContext);
  if (!ctx) throw new Error('useQualityTier must be used within QualityProvider');
  return ctx;
}
