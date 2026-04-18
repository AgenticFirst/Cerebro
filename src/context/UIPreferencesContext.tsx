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

const STORAGE_KEY_SHOW_TOOL_CALLS = 'cerebro_show_tool_calls';
const SETTING_KEY_SHOW_TOOL_CALLS = 'show_tool_calls';

interface UIPreferencesValue {
  showToolCalls: boolean;
  setShowToolCalls: (v: boolean) => void;
}

const UIPreferencesContext = createContext<UIPreferencesValue | null>(null);

export function UIPreferencesProvider({ children }: { children: ReactNode }) {
  const [showToolCalls, setShowToolCallsState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SHOW_TOOL_CALLS);
      if (saved === 'true') return true;
      if (saved === 'false') return false;
    } catch { /* private mode */ }
    return false;
  });

  useEffect(() => {
    let cancelled = false;
    loadSetting<boolean>(SETTING_KEY_SHOW_TOOL_CALLS).then((v) => {
      if (cancelled) return;
      if (typeof v === 'boolean') {
        setShowToolCallsState((prev) => (prev === v ? prev : v));
      }
    });
    return () => { cancelled = true; };
  }, []);

  const setShowToolCalls = useCallback((next: boolean) => {
    setShowToolCallsState(next);
    try { localStorage.setItem(STORAGE_KEY_SHOW_TOOL_CALLS, String(next)); } catch { /* private mode */ }
    saveSetting(SETTING_KEY_SHOW_TOOL_CALLS, next);
  }, []);

  const value = useMemo(() => ({ showToolCalls, setShowToolCalls }), [showToolCalls, setShowToolCalls]);

  return <UIPreferencesContext.Provider value={value}>{children}</UIPreferencesContext.Provider>;
}

export function useUIPreferences(): UIPreferencesValue {
  const ctx = useContext(UIPreferencesContext);
  if (!ctx) throw new Error('useUIPreferences must be used within UIPreferencesProvider');
  return ctx;
}
