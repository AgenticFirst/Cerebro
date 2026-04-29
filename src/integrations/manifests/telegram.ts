import type { IntegrationManifest } from '../../types/integrations';

export const telegramManifest: IntegrationManifest = {
  id: 'telegram',
  nameKey: 'integrations.telegram.name',
  descriptionKey: 'integrations.telegram.description',
  iconKey: 'telegram',
  authMode: 'token',
  fields: [
    {
      key: 'botToken',
      labelKey: 'integrations.telegram.fields.botToken',
      type: 'password',
      hintKey: 'integrations.telegram.hints.botToken',
    },
  ],
  setupStepKeys: [
    'integrations.telegram.steps.openBotFather',
    'integrations.telegram.steps.runNewbot',
    'integrations.telegram.steps.copyToken',
    'integrations.telegram.steps.pasteHere',
  ],
  docsUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  customModalId: 'telegram',
  ipc: {
    verify: async (fields) => {
      const r = await window.cerebro.telegram.verify(fields.botToken);
      return {
        ok: r.ok,
        data: r.username ? { username: r.username, botId: r.botId } : undefined,
        error: r.error,
      };
    },
    status: async () => {
      const r = await window.cerebro.telegram.status();
      return {
        connected: r.hasToken && r.running,
        details: r.botUsername ? { username: r.botUsername } : undefined,
      };
    },
    saveCredentials: async (fields) => window.cerebro.telegram.setToken(fields.botToken),
    clear: async () => window.cerebro.telegram.clearToken(),
  },
};
