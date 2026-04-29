/**
 * GHLHolder — tiny main-process object that owns the GoHighLevel API key
 * and location id. Mirrors HubSpotHolder in shape so the Settings UI and
 * IntegrationSetupCard can drive setup the same way.
 *
 * Persistence note: GHL credentials are also accessible to the Python
 * backend (the Sales Intel Analyst push lives there). To keep a single
 * source of truth, the holder writes through the same `/integrations/ghl/*`
 * endpoints that backend feature already uses, instead of duplicating the
 * setting keys via `backendPutSetting`.
 */

import {
  encryptForStorage,
  decryptFromStorage,
  backend as secureTokenBackend,
} from '../secure-token';
import { backendGetSetting, backendJsonRequest, backendPutSetting } from '../shared/backend-settings';
import { GHL_SETTING_KEYS } from './types';
import { callGHLApi } from './api';
import type { GHLStatusResponse, GHLVerifyResult } from '../types/ipc';

interface HolderDeps {
  backendPort: number;
}

export class GHLHolder {
  private apiKey: string | null = null;
  private locationId: string | null = null;

  constructor(private deps: HolderDeps) {}

  getApiKey(): string | null { return this.apiKey; }
  getLocationId(): string | null { return this.locationId; }
  isConnected(): boolean {
    return Boolean(this.apiKey && this.locationId);
  }

  /** Load existing credentials from backend settings on startup. */
  async init(): Promise<void> {
    const [encKey, locId] = await Promise.all([
      backendGetSetting<string>(this.deps.backendPort, GHL_SETTING_KEYS.apiKey),
      backendGetSetting<string>(this.deps.backendPort, GHL_SETTING_KEYS.locationId),
    ]);
    if (typeof encKey === 'string' && encKey) {
      this.apiKey = decryptFromStorage(encKey);
    }
    this.locationId = typeof locId === 'string' ? locId : null;
  }

  /** Validate a credential pair against the live GHL API by hitting
   *  `/contacts/search` with the supplied locationId — same probe the
   *  backend's `/integrations/ghl/test` uses. */
  async verify(apiKey: string, locationId: string): Promise<GHLVerifyResult> {
    const trimmedKey = apiKey?.trim?.() ?? '';
    const trimmedLoc = locationId?.trim?.() ?? '';
    if (!trimmedKey) return { ok: false, error: 'Empty API key' };
    if (!trimmedLoc) return { ok: false, error: 'Empty location id' };
    const res = await callGHLApi<{ contacts?: unknown[] }>(
      trimmedKey,
      '/contacts/search',
      { query: { locationId: trimmedLoc, query: 'cerebro-verify-probe' } },
    );
    if (!res.ok) return { ok: false, error: res.error ?? 'Verification failed' };
    return { ok: true, locationId: trimmedLoc };
  }

  async setCredentials(
    apiKey: string,
    locationId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const trimmedKey = apiKey?.trim?.() ?? '';
    const trimmedLoc = locationId?.trim?.() ?? '';
    if (!trimmedKey) return { ok: false, error: 'Empty API key' };
    if (!trimmedLoc) return { ok: false, error: 'Empty location id' };
    const verify = await this.verify(trimmedKey, trimmedLoc);
    if (!verify.ok) return { ok: false, error: verify.error ?? 'Verification failed' };

    this.apiKey = trimmedKey;
    this.locationId = trimmedLoc;

    // Encrypt the API key for the local mirror; the backend keeps a
    // plaintext copy in its settings table because the Python push
    // can't decrypt safeStorage envelopes. Acceptable since the
    // settings table is sqlite local to the OS user.
    const enc = encryptForStorage(trimmedKey);
    await Promise.all([
      backendPutSetting(this.deps.backendPort, GHL_SETTING_KEYS.apiKey, enc),
      this.pushBackendConfig(trimmedKey, trimmedLoc),
    ]);
    return { ok: true };
  }

  async clearCredentials(): Promise<void> {
    this.apiKey = null;
    this.locationId = null;
    await Promise.all([
      backendPutSetting(this.deps.backendPort, GHL_SETTING_KEYS.apiKey, ''),
      backendPutSetting(this.deps.backendPort, GHL_SETTING_KEYS.locationId, ''),
      this.pushBackendConfig('', ''),
    ]);
  }

  status(): GHLStatusResponse {
    return {
      hasApiKey: Boolean(this.apiKey),
      locationId: this.locationId,
      tokenBackend: secureTokenBackend(),
    };
  }

  /** Mirror credentials into the backend's `/integrations/ghl/config`
   *  endpoint so the Python-side push (Sales Intel Analyst) sees them
   *  without us re-implementing `_upsert_setting` here. */
  private async pushBackendConfig(apiKey: string, locationId: string): Promise<void> {
    await backendJsonRequest(this.deps.backendPort, 'PUT', '/integrations/ghl/config', {
      api_key: apiKey,
      location_id: locationId,
    });
  }
}
