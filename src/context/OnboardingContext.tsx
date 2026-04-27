/**
 * OnboardingContext — drives the first-run guided tour.
 *
 * Persistence: the `tour_completed` setting (versioned) is stored via the
 * existing `loadSetting`/`saveSetting` helpers. On boot, if the setting is
 * absent, the tour auto-opens after a short paint-settle delay. From Settings
 * → Appearance the user can call `start()` to replay the tour at any time.
 *
 * Screen orchestration: each step can declare `screen` and `settingsSection`,
 * which the controller applies before the spotlight renders. SettingsScreen
 * reads `forcedSettingsSection` to override its own internal section state
 * for the duration of the Memory step.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { loadSetting, saveSetting } from '../lib/settings';
import { TOUR_STEPS, type TourStep } from '../components/onboarding/tour-steps';

const TOUR_VERSION = 1;
const AUTO_OPEN_DELAY_MS = 800;

export type TourLanguage = 'en' | 'es';

interface PersistedTourState {
  version: number;
  completedAt: number;
  language: TourLanguage;
  /** True if the user explicitly skipped instead of finishing. */
  skipped?: boolean;
}

interface OnboardingContextValue {
  /** True while the tour overlay is mounted. */
  isOpen: boolean;
  /** Index into TOUR_STEPS; only meaningful while `isOpen`. */
  stepIndex: number;
  /** The current step record. */
  step: TourStep;
  /** Whether to land directly in spotlight stage 1 (used on replay). */
  hasCompletedBefore: boolean;
  /** When set, SettingsScreen overrides its activeSection accordingly. */
  forcedSettingsSection: 'memory' | null;
  /** ID of the sidebar nav item that should be lifted above the tour dim
   *  layer for the current spotlight step. Sidebar reads this and applies
   *  an elevated z-index to the matching NavButton — guarantees the nav
   *  item is visible regardless of whether the SVG cutout punches through. */
  spotlightedNavId: string | null;
  /** Language picked during welcome (drives copy in this session). */
  language: TourLanguage;
  /** Open the tour from step 0. Used by the Settings → Appearance button. */
  start: () => void;
  /** Advance one step. */
  next: () => void;
  /** Go back one step (no-op on welcome). */
  prev: () => void;
  /** Pick language during welcome step and advance. */
  setLanguageAndAdvance: (lang: TourLanguage) => void;
  /** Close + persist as completed (skipped flag = true if mid-tour). */
  finish: (opts?: { skipped?: boolean }) => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/* ── Provider ──────────────────────────────────────────────────── */

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();

  const [isOpen, setIsOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [hasCompletedBefore, setHasCompletedBefore] = useState(false);
  const [language, setLanguage] = useState<TourLanguage>(
    () => (i18n.language as TourLanguage) ?? 'en',
  );

  // Track auto-open scheduling so we don't fire after unmount.
  const autoOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-open on first launch if not yet seen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = await loadSetting<PersistedTourState>('tour_completed');
      if (cancelled) return;
      if (persisted && persisted.version === TOUR_VERSION) {
        setHasCompletedBefore(true);
        return;
      }
      // Defer slightly so providers settle and the chat empty-state paints.
      autoOpenTimer.current = setTimeout(() => {
        if (!cancelled) setIsOpen(true);
      }, AUTO_OPEN_DELAY_MS);
    })();
    return () => {
      cancelled = true;
      if (autoOpenTimer.current) clearTimeout(autoOpenTimer.current);
    };
  }, []);

  // Keep `language` in sync if the user switches it elsewhere mid-session.
  useEffect(() => {
    setLanguage(i18n.language as TourLanguage);
  }, [i18n.language]);

  const start = useCallback(() => {
    setStepIndex(0);
    setIsOpen(true);
  }, []);

  const next = useCallback(() => {
    setStepIndex((idx) => Math.min(idx + 1, TOUR_STEPS.length - 1));
  }, []);

  const prev = useCallback(() => {
    setStepIndex((idx) => Math.max(idx - 1, 0));
  }, []);

  const setLanguageAndAdvance = useCallback((lang: TourLanguage) => {
    void i18n.changeLanguage(lang);
    setLanguage(lang);
    saveSetting('ui_language', lang);
    try {
      localStorage.setItem('cerebro_ui_language', lang);
    } catch {
      /* private browsing — ok */
    }
    setStepIndex(1);
  }, [i18n]);

  const finish = useCallback(
    (opts?: { skipped?: boolean }) => {
      const payload: PersistedTourState = {
        version: TOUR_VERSION,
        completedAt: Date.now(),
        language: (i18n.language as TourLanguage) ?? 'en',
        skipped: opts?.skipped ?? false,
      };
      saveSetting('tour_completed', payload);
      setHasCompletedBefore(true);
      setIsOpen(false);
      setStepIndex(0);
    },
    [i18n.language],
  );

  const step = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0];

  const forcedSettingsSection = useMemo<'memory' | null>(() => {
    if (!isOpen) return null;
    return step?.settingsSection ?? null;
  }, [isOpen, step]);

  const spotlightedNavId = useMemo<string | null>(() => {
    if (!isOpen || step?.kind !== 'spotlight' || !step.screen) return null;
    return step.screen;
  }, [isOpen, step]);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      isOpen,
      stepIndex,
      step,
      hasCompletedBefore,
      forcedSettingsSection,
      spotlightedNavId,
      language,
      start,
      next,
      prev,
      setLanguageAndAdvance,
      finish,
    }),
    [
      isOpen,
      stepIndex,
      step,
      hasCompletedBefore,
      forcedSettingsSection,
      spotlightedNavId,
      language,
      start,
      next,
      prev,
      setLanguageAndAdvance,
      finish,
    ],
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return ctx;
}
