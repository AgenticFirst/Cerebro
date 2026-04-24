/**
 * HubSpotHolder — small main-process object that owns the HubSpot Private
 * App access token and default pipeline/stage ids.
 *
 * Not a full "bridge" like Telegram/WhatsApp — HubSpot is outbound-only for
 * the MVP templates, so there's no persistent socket. Just a token getter
 * (implements HubSpotChannel) plus verify / list-pipelines helpers backing
 * the Integrations UI.
 */

import type { HubSpotChannel } from '../engine/actions/hubspot-channel';
import type {
  HubSpotPipelineSummary,
  HubSpotStatusResponse,
  HubSpotVerifyResult,
} from '../types/ipc';
import {
  encryptForStorage,
  decryptFromStorage,
  backend as secureTokenBackend,
} from '../secure-token';
import { backendGetSetting, backendPutSetting } from '../shared/backend-settings';
import { callHubSpotApi } from './api';

export const HUBSPOT_SETTING_KEYS = {
  accessToken: 'hubspot_access_token',
  portalId: 'hubspot_portal_id',
  defaultPipeline: 'hubspot_default_pipeline',
  defaultStage: 'hubspot_default_stage',
  enabled: 'hubspot_enabled',
} as const;

const PIPELINES_CACHE_TTL_MS = 5 * 60 * 1_000;

interface HolderDeps {
  backendPort: number;
}

export class HubSpotHolder implements HubSpotChannel {
  private accessToken: string | null = null;
  private portalId: string | null = null;
  private defaultPipeline: string | null = null;
  private defaultStage: string | null = null;
  private pipelinesCache: { pipelines: HubSpotPipelineSummary[]; at: number } | null = null;

  constructor(private deps: HolderDeps) {}

  getAccessToken(): string | null { return this.accessToken; }
  getPortalId(): string | null { return this.portalId; }
  getDefaultPipeline(): string | null { return this.defaultPipeline; }
  getDefaultStage(): string | null { return this.defaultStage; }

  /** Load from backend settings on startup. */
  async init(): Promise<void> {
    const [encToken, portal, pipeline, stage] = await Promise.all([
      backendGetSetting<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.accessToken),
      backendGetSetting<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.portalId),
      backendGetSetting<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultPipeline),
      backendGetSetting<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultStage),
    ]);
    if (typeof encToken === 'string' && encToken) {
      this.accessToken = decryptFromStorage(encToken);
    }
    this.portalId = typeof portal === 'string' ? portal : null;
    this.defaultPipeline = typeof pipeline === 'string' ? pipeline : null;
    this.defaultStage = typeof stage === 'string' ? stage : null;
  }

  /** Verify a token by calling the HubSpot account-info endpoint. Returns the
   *  portal id on success so the UI can display it. */
  async verify(token: string): Promise<HubSpotVerifyResult> {
    if (!token || !token.trim()) return { ok: false, error: 'Empty token' };
    const res = await callHubSpotApi<{ portalId?: number | string }>(token.trim(), '/account-info/v3/details');
    if (!res.ok) return { ok: false, error: res.error ?? 'Verification failed' };
    const portal = res.data?.portalId !== undefined && res.data?.portalId !== null
      ? String(res.data.portalId)
      : null;
    return { ok: true, portalId: portal };
  }

  /** List pipelines + stages for the "tickets" object type. Cached for 5 min. */
  async listPipelines(): Promise<{ ok: boolean; pipelines?: HubSpotPipelineSummary[]; error?: string }> {
    if (!this.accessToken) return { ok: false, error: 'No access token configured' };
    const cached = this.pipelinesCache;
    if (cached && Date.now() - cached.at < PIPELINES_CACHE_TTL_MS) {
      return { ok: true, pipelines: cached.pipelines };
    }
    const res = await callHubSpotApi<{
      results?: Array<{
        id: string;
        label: string;
        stages?: Array<{ id: string; label: string; displayOrder?: number }>;
      }>;
    }>(this.accessToken, '/crm/v3/pipelines/tickets');
    if (!res.ok) return { ok: false, error: res.error ?? 'Failed' };
    const pipelines: HubSpotPipelineSummary[] = (res.data?.results ?? []).map((p) => ({
      id: p.id,
      label: p.label,
      stages: (p.stages ?? []).map((s) => ({
        id: s.id,
        label: s.label,
        displayOrder: typeof s.displayOrder === 'number' ? s.displayOrder : 0,
      })).sort((a, b) => a.displayOrder - b.displayOrder),
    }));
    this.pipelinesCache = { pipelines, at: Date.now() };
    return { ok: true, pipelines };
  }

  async setToken(token: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'Empty token' };
    // Verify first so we don't persist a bad token.
    const verify = await this.verify(trimmed);
    if (!verify.ok) return { ok: false, error: verify.error ?? 'Verification failed' };
    this.accessToken = trimmed;
    this.portalId = verify.portalId ?? null;
    const enc = encryptForStorage(trimmed);
    await Promise.all([
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.accessToken, enc),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.portalId, this.portalId ?? ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.enabled, true),
    ]);
    return { ok: true };
  }

  async clearToken(): Promise<void> {
    this.accessToken = null;
    this.portalId = null;
    this.defaultPipeline = null;
    this.defaultStage = null;
    this.pipelinesCache = null;
    await Promise.all([
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.accessToken, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.portalId, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultPipeline, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultStage, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.enabled, false),
    ]);
  }

  async setDefaults(defaults: { pipeline: string | null; stage: string | null }): Promise<void> {
    this.defaultPipeline = defaults.pipeline ?? null;
    this.defaultStage = defaults.stage ?? null;
    await Promise.all([
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultPipeline, this.defaultPipeline ?? ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultStage, this.defaultStage ?? ''),
    ]);
  }

  status(): HubSpotStatusResponse {
    return {
      hasToken: Boolean(this.accessToken),
      portalId: this.portalId,
      defaultPipeline: this.defaultPipeline,
      defaultStage: this.defaultStage,
      tokenBackend: secureTokenBackend(),
    };
  }
}
