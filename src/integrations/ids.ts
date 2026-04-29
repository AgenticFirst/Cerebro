// Manifests reference `window.cerebro.*`, so the main process imports
// this module instead of the registry to avoid pulling renderer-only
// code into its bundle. registry.test.ts asserts parity with the
// manifests, so drift is caught at test time.

export const KNOWN_INTEGRATION_IDS = ['telegram', 'hubspot', 'whatsapp', 'ghl'] as const;

export type KnownIntegrationId = (typeof KNOWN_INTEGRATION_IDS)[number];

export function isKnownIntegrationId(id: string): id is KnownIntegrationId {
  return (KNOWN_INTEGRATION_IDS as readonly string[]).includes(id);
}
