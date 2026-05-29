import type { IntegrationManifest } from '../../types/integrations';

export const ghlManifest: IntegrationManifest = {
  id: 'ghl',
  nameKey: 'integrations.ghl.name',
  descriptionKey: 'integrations.ghl.description',
  iconKey: 'ghl',
  authMode: 'api_key',
  fields: [
    {
      key: 'apiKey',
      labelKey: 'integrations.ghl.fields.apiKey',
      type: 'password',
      hintKey: 'integrations.ghl.hints.apiKey',
    },
    {
      key: 'locationId',
      labelKey: 'integrations.ghl.fields.locationId',
      type: 'text',
      hintKey: 'integrations.ghl.hints.locationId',
    },
  ],
  setupStepKeys: [
    'integrations.ghl.steps.openSettings',
    'integrations.ghl.steps.createPrivateApp',
    'integrations.ghl.steps.copyApiKey',
    'integrations.ghl.steps.copyLocationId',
    'integrations.ghl.steps.pasteHere',
  ],
  docsUrl: 'https://highlevel.stoplight.io/docs/integrations/',
  ipc: {
    verify: async (fields) => {
      const r = await window.cerebro.ghl.verify(fields.apiKey, fields.locationId);
      return {
        ok: r.ok,
        data: r.locationId ? { locationId: r.locationId } : undefined,
        error: r.error,
      };
    },
    status: async () => {
      const r = await window.cerebro.ghl.status();
      return {
        connected: r.hasApiKey && Boolean(r.locationId),
        details: r.locationId ? { locationId: r.locationId } : undefined,
      };
    },
    saveCredentials: async (fields) =>
      window.cerebro.ghl.setCredentials(fields.apiKey, fields.locationId),
    clear: async () => window.cerebro.ghl.clearCredentials(),
  },
};
