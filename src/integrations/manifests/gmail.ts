import type { IntegrationManifest } from '../../types/integrations';

/**
 * Gmail (bring-your-own Google OAuth client, like calendar).
 *
 * The user creates a Google Cloud project, enables the Gmail API, creates a
 * Desktop-app OAuth client, publishes the consent screen to Production
 * (Testing status expires refresh tokens after 7 days), and pastes the Client
 * ID + Secret. GmailConnectModal then runs the Authorization-Code + PKCE flow
 * against a loopback redirect. Tokens are encrypted and stored device-local
 * under the `gmail_` settings prefix (never synced) — see secure-token.ts and
 * cloud_sync/config.py.
 */
export const gmailManifest: IntegrationManifest = {
  id: 'gmail',
  nameKey: 'integrations.gmail.name',
  descriptionKey: 'integrations.gmail.description',
  iconKey: 'gmail',
  authMode: 'oauth',
  fields: [
    {
      key: 'clientId',
      labelKey: 'integrations.gmail.fields.clientId',
      type: 'text',
      hintKey: 'integrations.gmail.hints.clientId',
    },
    {
      key: 'clientSecret',
      labelKey: 'integrations.gmail.fields.clientSecret',
      type: 'password',
      hintKey: 'integrations.gmail.hints.clientSecret',
    },
  ],
  setupStepKeys: [
    'integrations.gmail.steps.createProject',
    'integrations.gmail.steps.enableApi',
    'integrations.gmail.steps.createOAuthClient',
    'integrations.gmail.steps.publishConsent',
    'integrations.gmail.steps.pasteCredentials',
    'integrations.gmail.steps.authorize',
  ],
  docsUrl: 'https://developers.google.com/gmail/api/quickstart/js',
  customModalId: 'gmail',
  ipc: {
    // Real credential validation happens during the OAuth browser flow in the
    // custom modal; here we only sanity-check that both fields are present.
    verify: async (fields) => {
      if (!fields.clientId?.trim() || !fields.clientSecret?.trim()) {
        return { ok: false, error: 'Client ID and Client Secret are required' };
      }
      return { ok: true };
    },
    status: async () => {
      const r = await window.cerebro.gmail.status();
      const email = r.accounts[0]?.email;
      return {
        connected: r.connected,
        details: email ? { email } : undefined,
      };
    },
    // Persistence + the OAuth dance are owned by GmailConnectModal
    // (window.cerebro.gmail.startOAuth). The generic path is not used.
    saveCredentials: async () => ({ ok: true }),
  },
};
