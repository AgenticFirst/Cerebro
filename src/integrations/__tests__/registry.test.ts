import { describe, it, expect } from 'vitest';
import { INTEGRATION_REGISTRY, listIntegrations } from '../registry';
import { KNOWN_INTEGRATION_IDS, isKnownIntegrationId } from '../ids';

describe('integration registry', () => {
  it('has a manifest for every known id', () => {
    for (const id of KNOWN_INTEGRATION_IDS) {
      expect(INTEGRATION_REGISTRY[id], `missing manifest for ${id}`).toBeDefined();
      expect(INTEGRATION_REGISTRY[id].id).toBe(id);
    }
  });

  it('only registers ids that are also known to the main process', () => {
    for (const manifest of listIntegrations()) {
      expect(isKnownIntegrationId(manifest.id), `${manifest.id} missing from KNOWN_INTEGRATION_IDS`).toBe(true);
    }
  });

  it('declares fields when the auth mode requires them', () => {
    for (const manifest of listIntegrations()) {
      if (manifest.authMode === 'token' || manifest.authMode === 'api_key') {
        expect(
          manifest.fields.length,
          `${manifest.id}: ${manifest.authMode} auth needs at least one field`,
        ).toBeGreaterThan(0);
      }
      if (manifest.authMode === 'qr_pairing') {
        expect(manifest.fields.length, `${manifest.id}: qr_pairing should have no fields`).toBe(0);
      }
    }
  });

  it('exposes a status check on every manifest (used by the card to render terminal state)', () => {
    for (const manifest of listIntegrations()) {
      expect(typeof manifest.ipc.status, `${manifest.id}: ipc.status missing`).toBe('function');
    }
  });

  it('declares verify + saveCredentials whenever credentials are entered manually', () => {
    for (const manifest of listIntegrations()) {
      if (manifest.authMode === 'qr_pairing') continue;
      expect(typeof manifest.ipc.verify, `${manifest.id}: ipc.verify missing`).toBe('function');
      expect(
        typeof manifest.ipc.saveCredentials,
        `${manifest.id}: ipc.saveCredentials missing`,
      ).toBe('function');
    }
  });

  it('uses customModalId values that match the IntegrationSetupCard switch', () => {
    const allowed = new Set(['telegram', 'hubspot', 'whatsapp']);
    for (const manifest of listIntegrations()) {
      if (manifest.customModalId) {
        expect(allowed.has(manifest.customModalId), `${manifest.id}: unknown customModalId`).toBe(true);
      }
    }
  });

  it('has at least one setup step key per manifest', () => {
    for (const manifest of listIntegrations()) {
      expect(
        manifest.setupStepKeys.length,
        `${manifest.id}: setupStepKeys is empty — chat agent needs prose`,
      ).toBeGreaterThan(0);
    }
  });
});
