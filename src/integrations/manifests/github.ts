import type { IntegrationManifest } from '../../types/integrations';

export const githubManifest: IntegrationManifest = {
  id: 'github',
  nameKey: 'integrations.github.name',
  descriptionKey: 'integrations.github.description',
  iconKey: 'github',
  authMode: 'token',
  fields: [
    {
      key: 'personalAccessToken',
      labelKey: 'integrations.github.fields.personalAccessToken',
      type: 'password',
      hintKey: 'integrations.github.hints.personalAccessToken',
    },
  ],
  setupStepKeys: [
    'integrations.github.steps.openSettings',
    'integrations.github.steps.createPersonalAccessToken',
    'integrations.github.steps.grantScopes',
    'integrations.github.steps.copyToken',
    'integrations.github.steps.pasteHere',
  ],
  docsUrl: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
  ipc: {
    verify: async (fields) => {
      const r = await window.cerebro.github.verify(fields.personalAccessToken);
      return {
        ok: r.ok,
        data: r.login ? { login: r.login } : undefined,
        error: r.error,
      };
    },
    status: async () => {
      const r = await window.cerebro.github.status();
      return {
        connected: r.hasToken,
        details: r.login ? { login: r.login } : undefined,
      };
    },
    saveCredentials: async (fields) => window.cerebro.github.setToken(fields.personalAccessToken),
    clear: async () => window.cerebro.github.clearToken(),
  },
};
