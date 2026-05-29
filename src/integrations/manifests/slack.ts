import type { IntegrationManifest } from '../../types/integrations';

export const slackManifest: IntegrationManifest = {
  id: 'slack',
  nameKey: 'integrations.slack.name',
  descriptionKey: 'integrations.slack.description',
  iconKey: 'slack',
  authMode: 'token',
  fields: [
    {
      key: 'botToken',
      labelKey: 'integrations.slack.fields.botToken',
      type: 'password',
      hintKey: 'integrations.slack.hints.botToken',
    },
    {
      key: 'appToken',
      labelKey: 'integrations.slack.fields.appToken',
      type: 'password',
      hintKey: 'integrations.slack.hints.appToken',
    },
  ],
  setupStepKeys: [
    'integrations.slack.steps.copyManifest',
    'integrations.slack.steps.createApp',
    'integrations.slack.steps.installWorkspace',
    'integrations.slack.steps.copyBotToken',
    'integrations.slack.steps.generateAppToken',
    'integrations.slack.steps.pasteHere',
  ],
  docsUrl: 'https://docs.slack.dev/apis/events-api/using-socket-mode/',
  customModalId: 'slack',
  ipc: {
    verify: async (fields) => {
      const r = await window.cerebro.slack.verify(fields.botToken, fields.appToken);
      return {
        ok: r.ok,
        data: r.ok ? { teamName: r.teamName ?? '', teamId: r.teamId ?? '', botUserId: r.botUserId ?? '' } : undefined,
        error: r.error,
      };
    },
    status: async () => {
      const r = await window.cerebro.slack.status();
      return {
        connected: r.running && r.hasBotToken && r.hasAppToken,
        details: r.teamName ? { teamName: r.teamName, botUserId: r.botUserId ?? '' } : undefined,
      };
    },
    saveCredentials: async (fields) => window.cerebro.slack.setTokens({
      botToken: fields.botToken,
      appToken: fields.appToken,
    }),
    clear: async () => window.cerebro.slack.clearTokens(),
  },
};
