/**
 * Engine registry — the single place that knows which inference engines
 * exist and which one a given run should use.
 *
 * Engines register at startup (`registerEngine`). Callers resolve the active
 * engine for a run via `resolveActiveEngine(conversationId)`, which applies
 * the precedence:
 *
 *   per-conversation override (settings: `conversation_engine:<id>`)
 *     → global default        (settings: `selected_engine`)
 *       → DEFAULT_ENGINE       ('claude-code')
 *
 * The registry doesn't own a backend port, so the main process injects a
 * settings reader once at startup via `setEngineSettingsReader` (mirrors the
 * `setClaudeCodeCwd` pattern). Renderer-side selection lives in EngineContext.
 */

import type { EngineId, InferenceEngine } from './types';

export const DEFAULT_ENGINE: EngineId = 'claude-code';

const engines = new Map<EngineId, InferenceEngine>();

/** Reads a settings value by key. Injected at startup with a port closure. */
export type EngineSettingsReader = (key: string) => Promise<string | null>;

let settingsReader: EngineSettingsReader | null = null;

export function setEngineSettingsReader(reader: EngineSettingsReader): void {
  settingsReader = reader;
}

export function registerEngine(engine: InferenceEngine): void {
  engines.set(engine.id, engine);
}

export function getEngine(id: EngineId): InferenceEngine {
  const engine = engines.get(id);
  if (!engine) {
    throw new Error(`Inference engine '${id}' is not registered`);
  }
  return engine;
}

export function tryGetEngine(id: EngineId): InferenceEngine | null {
  return engines.get(id) ?? null;
}

export function listEngines(): InferenceEngine[] {
  return [...engines.values()];
}

export function isEngineId(value: unknown): value is EngineId {
  return value === 'claude-code' || value === 'codex';
}

/**
 * Resolve the engine for a run. Falls back gracefully: an unregistered or
 * unparseable stored value resolves to whichever engine is available, then to
 * DEFAULT_ENGINE. Never throws — a missing reader just yields the default.
 */
export async function resolveActiveEngine(conversationId?: string): Promise<InferenceEngine> {
  const id = await resolveActiveEngineId(conversationId);
  return getEngine(id);
}

export async function resolveActiveEngineId(conversationId?: string): Promise<EngineId> {
  if (settingsReader) {
    try {
      if (conversationId) {
        const perConv = await settingsReader(`conversation_engine:${conversationId}`);
        if (isEngineId(perConv) && engines.has(perConv)) return perConv;
      }
      const global = await settingsReader('selected_engine');
      if (isEngineId(global) && engines.has(global)) return global;
    } catch {
      // settings backend unavailable — fall through to the default
    }
  }
  return engines.has(DEFAULT_ENGINE) ? DEFAULT_ENGINE : (firstRegistered() ?? DEFAULT_ENGINE);
}

function firstRegistered(): EngineId | null {
  const first = engines.keys().next();
  return first.done ? null : first.value;
}
