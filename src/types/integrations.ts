/**
 * Integration manifest types — the central, typed shape that lets the
 * Cerebro chat agent and the Settings UI drive any connected service
 * (Telegram, HubSpot, WhatsApp, …) generically.
 *
 * Each integration registers a manifest in src/integrations/registry.ts.
 * Manifests reference existing IPC bridges via typed function references
 * so the GenericConnectModal can drive any future integration without
 * touching the card itself.
 */

export type AuthMode = 'token' | 'api_key' | 'qr_pairing' | 'oauth';

export interface IntegrationFieldSchema {
  /** Object key used in {@link IntegrationManifest.verify} payloads (e.g. 'botToken'). */
  key: string;
  /** i18n key for the field's label (e.g. 'integrations.telegram.fields.botToken'). */
  labelKey: string;
  /** 'password' masks input; 'text' shows it. */
  type: 'password' | 'text';
  /** i18n key for placeholder/hint text. Optional. */
  hintKey?: string;
  optional?: boolean;
}

export interface IntegrationVerifyResult {
  ok: boolean;
  /** Free-form data the modal can show (e.g. `{ username: '@my_bot' }`). */
  data?: Record<string, unknown>;
  /** Human-readable error if `ok === false`. */
  error?: string;
}

export interface IntegrationStatus {
  connected: boolean;
  /** Free-form details to show in the card ("Connected as @my_bot"). */
  details?: Record<string, unknown>;
}

/**
 * Function references the card uses to drive setup. Implemented by each
 * manifest as thin wrappers over the existing per-provider IPC bridges
 * (window.cerebro.telegram, etc.) — keeping this layer generic means a
 * new integration only needs a manifest + a thin wrapper function.
 */
export interface IntegrationIPC {
  /**
   * Validates the supplied credential fields against the live service.
   * Required for `token` / `api_key` / `oauth`. Omitted for `qr_pairing`
   * (where the modal owns the live pairing handshake).
   */
  verify?: (fields: Record<string, string>) => Promise<IntegrationVerifyResult>;
  /**
   * Reads the current connection status from the backend / OS keychain.
   * Always required so the card can render the right state on open.
   */
  status: () => Promise<IntegrationStatus>;
  /**
   * Persists the credentials (delegates to the existing per-provider
   * setToken / save / enable IPC). Required for `token` / `api_key`,
   * unused for `qr_pairing` (modal handles persistence itself).
   */
  saveCredentials?: (fields: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
  /** Optional: clear the stored credentials. */
  clear?: () => Promise<{ ok: boolean; error?: string }>;
}

/**
 * `customModalId` lets a manifest delegate to one of the existing polished
 * connect modals (TelegramConnectModal, HubSpotConnectModal, …). When
 * absent, the IntegrationSetupCard falls back to GenericConnectModal,
 * which renders fields directly from the manifest. New integrations get
 * the generic modal for free.
 */
export type CustomModalId = 'telegram' | 'hubspot' | 'whatsapp';

export interface IntegrationManifest {
  /** Stable identifier used in chat-action params and message metadata. */
  id: string;
  /** i18n key for the integration's display name. */
  nameKey: string;
  /** i18n key for the one-line description shown on the card. */
  descriptionKey: string;
  /** Logo identifier — resolved by the card to the right SVG/icon. */
  iconKey: string;
  authMode: AuthMode;
  /** Empty for `qr_pairing`. */
  fields: IntegrationFieldSchema[];
  /**
   * i18n keys for the prose setup steps (e.g. BotFather walkthrough).
   * The chat skill loads these into context so it can answer follow-up
   * questions without hallucinating. The GenericConnectModal renders
   * them as a checklist when no `customModalId` is set.
   */
  setupStepKeys: string[];
  /** External docs link (rendered as "Learn more →"). */
  docsUrl?: string;
  ipc: IntegrationIPC;
  /** When set, the card opens this existing modal instead of the generic one. */
  customModalId?: CustomModalId;
}
