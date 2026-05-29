import type { IntegrationManifest } from '../../types/integrations';

export const hubspotManifest: IntegrationManifest = {
  id: 'hubspot',
  nameKey: 'integrations.hubspot.name',
  descriptionKey: 'integrations.hubspot.description',
  iconKey: 'hubspot',
  authMode: 'token',
  fields: [
    {
      key: 'accessToken',
      labelKey: 'integrations.hubspot.fields.accessToken',
      type: 'password',
      hintKey: 'integrations.hubspot.hints.accessToken',
    },
  ],
  setupStepKeys: [
    'integrations.hubspot.steps.openSettings',
    'integrations.hubspot.steps.createPrivateApp',
    'integrations.hubspot.steps.grantScopes',
    'integrations.hubspot.steps.copyToken',
    'integrations.hubspot.steps.pasteHere',
  ],
  docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
  customModalId: 'hubspot',
  ipc: {
    verify: async (fields) => {
      const r = await window.cerebro.hubspot.verify(fields.accessToken);
      return {
        ok: r.ok,
        data: r.portalId ? { portalId: r.portalId } : undefined,
        error: r.error,
      };
    },
    status: async () => {
      const r = await window.cerebro.hubspot.status();
      return {
        connected: r.hasToken,
        details: r.portalId ? { portalId: r.portalId } : undefined,
      };
    },
    saveCredentials: async (fields) => window.cerebro.hubspot.setToken(fields.accessToken),
    clear: async () => window.cerebro.hubspot.clearToken(),
  },
};
