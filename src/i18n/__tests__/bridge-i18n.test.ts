import { describe, it, expect } from 'vitest';

import { bridgeT, normalizeBridgeLang } from '../bridge-i18n';

describe('bridge-i18n', () => {
  it('normalizes locale tags to a supported bridge language', () => {
    expect(normalizeBridgeLang('es')).toBe('es');
    expect(normalizeBridgeLang('es-ES')).toBe('es');
    expect(normalizeBridgeLang('EN-us')).toBe('en');
    expect(normalizeBridgeLang('fr')).toBe('en'); // unsupported → English
    expect(normalizeBridgeLang(undefined)).toBe('en');
    expect(normalizeBridgeLang(null)).toBe('en');
  });

  it('resolves a known key in each language', () => {
    expect(bridgeT('en', 'slackBridge.transcribeFailed')).toMatch(/transcribe/i);
    expect(bridgeT('es', 'slackBridge.transcribeFailed')).toMatch(/transcribir/i);
  });

  it('interpolates {{vars}}', () => {
    expect(bridgeT('en', 'slackBridge.filesReceived', { names: 'a.pdf, b.png' })).toBe(
      '📎 Got a.pdf, b.png.',
    );
    expect(bridgeT('es', 'slackBridge.fileTooLarge', { name: 'big.zip' })).toBe(
      '📎 "big.zip" es demasiado grande para procesarlo (máx. 20 MB).',
    );
  });

  it('falls back to the raw key when the string is missing entirely', () => {
    expect(bridgeT('es', 'slackBridge.__does_not_exist__')).toBe('slackBridge.__does_not_exist__');
  });
});
