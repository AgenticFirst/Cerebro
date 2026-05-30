import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerEngine,
  tryGetEngine,
  getEngine,
  resolveActiveEngineId,
  setEngineSettingsReader,
  DEFAULT_ENGINE,
} from '../registry';
import type { InferenceEngine, EngineId } from '../types';

function fakeEngine(id: EngineId): InferenceEngine {
  return {
    id,
    displayName: id,
    detect: async () => ({ status: 'available' }),
    getCachedInfo: () => ({ status: 'available' }),
    probeAuth: async () => ({ ok: true }),
    createRunner: () => {
      throw new Error('not used in registry tests');
    },
    singleShot: async () => '',
    resolveModel: () => ({}),
    compilePrompt: (a) => a.userTurn,
  };
}

describe('engine registry', () => {
  beforeEach(() => {
    registerEngine(fakeEngine('claude-code'));
    registerEngine(fakeEngine('codex'));
    setEngineSettingsReader(async () => null);
  });

  it('defaults to claude-code when no setting is present', async () => {
    setEngineSettingsReader(async () => null);
    expect(await resolveActiveEngineId()).toBe(DEFAULT_ENGINE);
  });

  it('honors the global selected_engine setting', async () => {
    setEngineSettingsReader(async (key) => (key === 'selected_engine' ? 'codex' : null));
    expect(await resolveActiveEngineId()).toBe('codex');
  });

  it('per-conversation override beats the global default', async () => {
    setEngineSettingsReader(async (key) => {
      if (key === 'conversation_engine:c1') return 'codex';
      if (key === 'selected_engine') return 'claude-code';
      return null;
    });
    expect(await resolveActiveEngineId('c1')).toBe('codex');
    expect(await resolveActiveEngineId('c2')).toBe('claude-code');
  });

  it('ignores an unparseable / unregistered stored value', async () => {
    setEngineSettingsReader(async () => 'not-an-engine');
    expect(await resolveActiveEngineId()).toBe(DEFAULT_ENGINE);
  });

  it('never throws when the settings reader rejects', async () => {
    setEngineSettingsReader(async () => {
      throw new Error('backend down');
    });
    expect(await resolveActiveEngineId('c1')).toBe(DEFAULT_ENGINE);
  });

  it('tryGetEngine returns null for unknown ids; getEngine throws', () => {
    expect(tryGetEngine('codex')).not.toBeNull();
    expect(() => getEngine('claude-code')).not.toThrow();
  });
});
