/**
 * Integration registry — single source of truth for every connected
 * service Cerebro can drive (Telegram, HubSpot, WhatsApp, future ones).
 *
 * **Before adding a new integration: read `docs/adding-integrations.md`.**
 * Wiring an integration touches ~15 files across the bridge, IPC, UI,
 * engine actions, routine prompt, and chat skills. Skipping any of them
 * silently breaks part of the surface (chat setup works but routines
 * don't generate, etc.). The playbook is the only place tracking the
 * full surface area.
 *
 * Quick version: drop a manifest in `./manifests/<id>.ts`, add the id to
 * `./ids.ts`, register here. The IntegrationSetupCard then renders
 * automatically — but routine actions and chat tool calling need
 * additional wiring described in the playbook.
 */

import type { IntegrationManifest } from '../types/integrations';
import { telegramManifest } from './manifests/telegram';
import { hubspotManifest } from './manifests/hubspot';
import { whatsappManifest } from './manifests/whatsapp';

export const INTEGRATION_REGISTRY: Record<string, IntegrationManifest> = {
  [telegramManifest.id]: telegramManifest,
  [hubspotManifest.id]: hubspotManifest,
  [whatsappManifest.id]: whatsappManifest,
};

export function listIntegrations(): IntegrationManifest[] {
  return Object.values(INTEGRATION_REGISTRY);
}

export function getIntegration(id: string): IntegrationManifest | undefined {
  return INTEGRATION_REGISTRY[id];
}

export function listIntegrationIds(): string[] {
  return Object.keys(INTEGRATION_REGISTRY);
}
