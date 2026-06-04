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

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'cerebro_ui_theme';
const SETTING_KEY = 'ui_theme';

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(theme: Theme): ResolvedTheme {
  return theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
}

function applyClass(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle('light', resolved === 'light');
  root.classList.toggle('dark', resolved === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialise from localStorage (written pre-paint in renderer.tsx) so state
  // matches whatever class is already on <html>. Falls back to 'system'.
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
    } catch {
      /* private mode */
    }
    return 'system';
  });
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolve(theme));

  // Hydrate from backend /settings — localStorage may be stale on first run of
  // a new install if the user synced settings from elsewhere.
  useEffect(() => {
    let cancelled = false;
    loadSetting<Theme>(SETTING_KEY).then((v) => {
      if (cancelled) return;
      if (v === 'light' || v === 'dark' || v === 'system') {
        setThemeState((prev) => (prev === v ? prev : v));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep resolvedTheme + <html> class in sync with theme and OS preference.
  useEffect(() => {
    const update = () => {
      const r = resolve(theme);
      setResolvedTheme(r);
      applyClass(r);
    };
    update();
    if (theme !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode */
    }
    saveSetting(SETTING_KEY, next);
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
