import type { IntegrationManifest } from '../../types/integrations';

/**
 * n8n is the first `managed` integration: Cerebro npm-installs a local n8n
 * instance and provisions the owner account + API key itself, so there are
 * no credential fields and no verify step. The setup steps describe what
 * Cerebro does, not a third-party console walkthrough.
 */
export const n8nManifest: IntegrationManifest = {
  id: 'n8n',
  nameKey: 'integrations.n8n.name',
  descriptionKey: 'integrations.n8n.description',
  iconKey: 'n8n',
  authMode: 'managed',
  fields: [],
  setupStepKeys: [
    'integrations.n8n.steps.install',
    'integrations.n8n.steps.provision',
    'integrations.n8n.steps.ready',
  ],
  docsUrl: 'https://docs.n8n.io/',
  customModalId: 'n8n',
  ipc: {
    status: async () => {
      const r = await window.cerebro.n8n.status();
      return {
        connected: r.phase === 'running' && r.hasApiKey,
        details: { phase: r.phase, version: r.version ?? undefined },
      };
    },
  },
};
