/**
 * n8n integration — shared constants and types.
 *
 * Unlike every other integration, n8n is a Cerebro-managed local service:
 * Cerebro npm-installs a pinned n8n version into <userData>/n8n-app, runs it
 * as a child process, and provisions the owner account + API key itself. The
 * user never pastes a credential.
 *
 * The version is pinned hard because provisioning (src/n8n/provisioning.ts)
 * talks to n8n's *internal* /rest endpoints, which are undocumented and can
 * change between releases. Bumping N8N_PINNED_VERSION means re-verifying that
 * file end-to-end against the new version.
 */

export const N8N_PINNED_VERSION = '2.28.5';

/**
 * Forced via npm `overrides` in the install manifest. Standalone npm installs
 * of n8n 2.x hoist zod@4 (wanted by the bundled @ai-sdk/langchain packages) to
 * the tree root, leaving each n8n package with its own nested zod@3 copy.
 * @n8n/api-types then builds a z.discriminatedUnion from n8n-workflow schemas
 * created by a *different* zod instance and n8n crashes on boot with
 * "A discriminator value for key `__type` could not be extracted".
 * Pinning every zod to the version the n8n packages declare gives the whole
 * tree one shared instance (3.25.x also serves the v4 API via `zod/v4`, which
 * is what the @ai-sdk packages import). Verified empirically against 2.28.5.
 */
export const N8N_ZOD_OVERRIDE_VERSION = '3.25.67';

/** n8n@2.28.5 declares engines.node '>=22.22'. */
export const N8N_MIN_NODE_MAJOR = 22;

/**
 * Fixed local port for the managed instance (with linear probing on
 * conflict). Pinned rather than random so the renderer's iframe origin and
 * the onHeadersReceived filter in main.ts stay stable across launches.
 */
export const N8N_DEFAULT_PORT = 55678;

export const N8N_SETTING_KEYS = {
  /** Public API key, encrypted via secure-token. */
  apiKey: 'n8n_api_key',
  /**
   * N8N_ENCRYPTION_KEY for the spawned instance, encrypted via secure-token.
   * Generated once and never rotated — n8n encrypts its own node credentials
   * with it, so losing/rotating it bricks every credential the user saved
   * inside the n8n editor.
   */
  encryptionKey: 'n8n_encryption_key',
  /** Synthetic local owner account (machine-generated, never shown). */
  ownerEmail: 'n8n_owner_email',
  /** Owner password, encrypted via secure-token. Needed to re-mint editor
   *  session cookies after app restarts (the API key only covers /api/v1). */
  ownerPassword: 'n8n_owner_password',
  installedVersion: 'n8n_installed_version',
  enabled: 'n8n_enabled',
} as const;

// Canonical IPC surface types live in `src/types/ipc.ts` (consistent with how
// WhatsApp/Telegram status types are handled). Re-export for colocated imports.
export type { N8nPhase } from '../types/ipc';

export interface N8nRuntimeInfo {
  nodePath: string;
  npmPath: string;
  nodeVersion: string;
}
