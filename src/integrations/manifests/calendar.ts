import type { IntegrationManifest } from '../../types/integrations';

/**
 * Calendar sync (Google Calendar + Microsoft Outlook/365).
 *
 * Cerebro's first OAuth integration. Bring-your-own model: the user registers
 * their own Google Cloud / Azure OAuth app and pastes the Client ID + Secret;
 * the CalendarConnectModal then runs an Authorization-Code + PKCE flow against a
 * loopback redirect. Tokens are encrypted and stored device-local under the
 * `calendar_` settings prefix (never synced) — see secure-token.ts and
 * cloud_sync/config.py.
 *
 * The manifest is intentionally lightweight: the rich multi-account UI lives in
 * CalendarSection (custom modal), so the generic-card ipc wrappers below only
 * back the Connections discovery card + chat connect-integration skill.
 */
export const calendarManifest: IntegrationManifest = {
  id: 'calendar',
  nameKey: 'integrations.calendar.name',
  descriptionKey: 'integrations.calendar.description',
  iconKey: 'calendar',
  authMode: 'oauth',
  fields: [
    {
      key: 'clientId',
      labelKey: 'integrations.calendar.fields.clientId',
      type: 'text',
      hintKey: 'integrations.calendar.hints.clientId',
    },
    {
      key: 'clientSecret',
      labelKey: 'integrations.calendar.fields.clientSecret',
      type: 'password',
      hintKey: 'integrations.calendar.hints.clientSecret',
    },
  ],
  setupStepKeys: [
    'integrations.calendar.steps.chooseProvider',
    'integrations.calendar.steps.createOAuthApp',
    'integrations.calendar.steps.addRedirect',
    'integrations.calendar.steps.pasteCredentials',
    'integrations.calendar.steps.authorize',
  ],
  docsUrl: 'https://developers.google.com/calendar/api/quickstart/js',
  customModalId: 'calendar',
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
      const r = await window.cerebro.calendar.status();
      return {
        connected: r.connected,
        details: r.accounts.length ? { accounts: r.accounts.length } : undefined,
      };
    },
    // Persistence + the OAuth dance are owned by CalendarConnectModal
    // (window.cerebro.calendar.startOAuth). The generic path is not used.
    saveCredentials: async () => ({ ok: true }),
  },
};
