import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { loadSetting, saveSetting } from '../lib/settings';
import type { EngineId } from '../engines/types';

/**
 * Which inference engine drives chat. A single app-wide default
 * (`selected_engine`) plus per-conversation overrides
 * (`conversation_engine:<id>`), both persisted in the settings table and
 * mirrored to localStorage for an optimistic first paint. Mirrors the
 * QualityContext persistence pattern.
 */

const ENGINE_IDS: readonly EngineId[] = ['claude-code', 'codex'];
const DEFAULT_ENGINE: EngineId = 'claude-code';

const DEFAULT_STORAGE_KEY = 'cerebro_selected_engine';
const DEFAULT_SETTING_KEY = 'selected_engine';
const conversationSettingKey = (convId: string) => `conversation_engine:${convId}`;

function isEngineId(v: unknown): v is EngineId {
  return typeof v === 'string' && (ENGINE_IDS as readonly string[]).includes(v);
}

interface EngineContextValue {
  /** App-wide default engine. */
  defaultEngine: EngineId;
  setDefaultEngine: (engine: EngineId) => void;
  /** Resolve the engine for a conversation (override → default). */
  engineForConversation: (conversationId: string | null | undefined) => EngineId;
  /** Set (or clear, when equal to default) a per-conversation override. */
  setConversationEngine: (conversationId: string, engine: EngineId) => void;
}

const EngineContext = createContext<EngineContextValue | null>(null);

export function EngineProvider({ children }: { children: ReactNode }) {
  const [defaultEngine, setDefaultEngineState] = useState<EngineId>(() => {
    try {
      const saved = localStorage.getItem(DEFAULT_STORAGE_KEY);
      if (isEngineId(saved)) return saved;
    } catch {
      /* private mode */
    }
    return DEFAULT_ENGINE;
  });

  const [overrides, setOverrides] = useState<Record<string, EngineId>>({});

  // Hydrate the default from the backend once on mount.
  useEffect(() => {
    let cancelled = false;
    loadSetting<EngineId>(DEFAULT_SETTING_KEY)
      .then((v) => {
        if (!cancelled && isEngineId(v)) {
          setDefaultEngineState(v);
          try {
            localStorage.setItem(DEFAULT_STORAGE_KEY, v);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const setDefaultEngine = useCallback((engine: EngineId) => {
    setDefaultEngineState(engine);
    try {
      localStorage.setItem(DEFAULT_STORAGE_KEY, engine);
    } catch {
      /* ignore */
    }
    void saveSetting(DEFAULT_SETTING_KEY, engine);
  }, []);

  const engineForConversation = useCallback(
    (conversationId: string | null | undefined): EngineId => {
      if (conversationId && overrides[conversationId]) return overrides[conversationId];
      return defaultEngine;
    },
    [overrides, defaultEngine],
  );

  const setConversationEngine = useCallback((conversationId: string, engine: EngineId) => {
    setOverrides((prev) => ({ ...prev, [conversationId]: engine }));
    void saveSetting(conversationSettingKey(conversationId), engine);
  }, []);

  return (
    <EngineContext.Provider
      value={{ defaultEngine, setDefaultEngine, engineForConversation, setConversationEngine }}
    >
      {children}
    </EngineContext.Provider>
  );
}

export function useEngine(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngine must be used within EngineProvider');
  return ctx;
}
