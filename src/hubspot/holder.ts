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
import {
  backendGetSettingStrict,
  backendPutSetting,
  SettingsUnavailableError,
} from '../shared/backend-settings';
import { callHubSpotApi } from './api';
import { listTicketProperties, type ListTicketPropertiesResult } from './properties';

export const HUBSPOT_SETTING_KEYS = {
  accessToken: 'hubspot_access_token',
  portalId: 'hubspot_portal_id',
  defaultPipeline: 'hubspot_default_pipeline',
  defaultStage: 'hubspot_default_stage',
  followUpProperty: 'hubspot_followup_property',
  dueDateProperty: 'hubspot_duedate_property',
  enabled: 'hubspot_enabled',
} as const;

const PIPELINES_CACHE_TTL_MS = 5 * 60 * 1_000;

// init() runs once at app startup; if the backend hiccups at that exact
// moment the holder used to stay token-less (→ "HubSpot disconnected" in chat
// and UI) for the whole session. Retry with doubling backoff instead.
const INIT_RETRY_MIN_MS = 5_000;
const INIT_RETRY_MAX_MS = 5 * 60_000;

interface HolderDeps {
  backendPort: number;
}

export class HubSpotHolder implements HubSpotChannel {
  private accessToken: string | null = null;
  private portalId: string | null = null;
  private defaultPipeline: string | null = null;
  private defaultStage: string | null = null;
  private followUpProperty: string | null = null;
  private dueDateProperty: string | null = null;
  private pipelinesCache: { pipelines: HubSpotPipelineSummary[]; at: number } | null = null;

  /** True once a settings load completed without the backend being unreachable. */
  private loadedOk = false;
  private initRetryTimer: NodeJS.Timeout | null = null;
  private initRetryDelayMs = INIT_RETRY_MIN_MS;
  /** Stored token envelope exists but could not be decrypted (keychain changed). */
  private credentialsUnreadable = false;

  constructor(private deps: HolderDeps) {}

  getAccessToken(): string | null {
    return this.accessToken;
  }
  getPortalId(): string | null {
    return this.portalId;
  }
  getDefaultPipeline(): string | null {
    return this.defaultPipeline;
  }
  getDefaultStage(): string | null {
    return this.defaultStage;
  }
  getFollowUpProperty(): string | null {
    return this.followUpProperty;
  }
  getDueDateProperty(): string | null {
    return this.dueDateProperty;
  }
  isConnected(): boolean {
    return Boolean(this.accessToken && this.defaultPipeline && this.defaultStage);
  }

  /** Load from backend settings on startup. Retries with backoff when the
   *  backend is unreachable — a transient hiccup must not read as "no token"
   *  for the rest of the session. */
  async init(): Promise<void> {
    let encToken, portal, pipeline, stage, followUp, dueDate;
    try {
      // Strict getters: 404 means "unset" (null), transport failure throws.
      // All six gate isConnected() directly or indirectly, so all six matter.
      [encToken, portal, pipeline, stage, followUp, dueDate] = await Promise.all([
        backendGetSettingStrict<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.accessToken),
        backendGetSettingStrict<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.portalId),
        backendGetSettingStrict<string>(
          this.deps.backendPort,
          HUBSPOT_SETTING_KEYS.defaultPipeline,
        ),
        backendGetSettingStrict<string>(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultStage),
        backendGetSettingStrict<string>(
          this.deps.backendPort,
          HUBSPOT_SETTING_KEYS.followUpProperty,
        ),
        backendGetSettingStrict<string>(
          this.deps.backendPort,
          HUBSPOT_SETTING_KEYS.dueDateProperty,
        ),
      ]);
    } catch (err) {
      if (err instanceof SettingsUnavailableError) {
        this.scheduleInitRetry(err.message);
        return;
      }
      throw err;
    }
    if (typeof encToken === 'string' && encToken) {
      this.accessToken = decryptFromStorage(encToken);
      this.credentialsUnreadable = !this.accessToken;
    } else {
      this.credentialsUnreadable = false;
    }
    this.portalId = typeof portal === 'string' ? portal : null;
    this.defaultPipeline = typeof pipeline === 'string' ? pipeline : null;
    this.defaultStage = typeof stage === 'string' ? stage : null;
    this.followUpProperty = typeof followUp === 'string' && followUp ? followUp : null;
    this.dueDateProperty = typeof dueDate === 'string' && dueDate ? dueDate : null;
    this.loadedOk = true;
    this.initRetryDelayMs = INIT_RETRY_MIN_MS;
  }

  private scheduleInitRetry(reason: string): void {
    if (this.initRetryTimer || this.loadedOk) return;
    const delay = this.initRetryDelayMs;
    this.initRetryDelayMs = Math.min(this.initRetryDelayMs * 2, INIT_RETRY_MAX_MS);
    console.warn(
      `[HubSpot] settings load failed, retrying in ${Math.round(delay / 1000)}s — ${reason}`,
    );
    this.initRetryTimer = setTimeout(() => {
      this.initRetryTimer = null;
      void this.init().catch((err) => {
        console.error('[HubSpot] settings load retry failed:', err);
      });
    }, delay);
    if (typeof this.initRetryTimer.unref === 'function') this.initRetryTimer.unref();
  }

  /** Verify a token by calling the HubSpot account-info endpoint. Returns the
   *  portal id on success so the UI can display it. */
  async verify(token: string): Promise<HubSpotVerifyResult> {
    if (!token || !token.trim()) return { ok: false, error: 'Empty token' };
    const res = await callHubSpotApi<{ portalId?: number | string }>(
      token.trim(),
      '/account-info/v3/details',
    );
    if (!res.ok) return { ok: false, error: res.error ?? 'Verification failed' };
    const portal =
      res.data?.portalId !== undefined && res.data?.portalId !== null
        ? String(res.data.portalId)
        : null;
    return { ok: true, portalId: portal };
  }

  /** List pipelines + stages for the "tickets" object type. Cached for 5 min. */
  async listPipelines(): Promise<{
    ok: boolean;
    pipelines?: HubSpotPipelineSummary[];
    error?: string;
  }> {
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
      stages: (p.stages ?? [])
        .map((s) => ({
          id: s.id,
          label: s.label,
          displayOrder: typeof s.displayOrder === 'number' ? s.displayOrder : 0,
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder),
    }));
    this.pipelinesCache = { pipelines, at: Date.now() };
    return { ok: true, pipelines };
  }

  /** List the portal's ticket properties so the settings UI can offer the
   *  follow-up-user and due-date pickers. Cached per token in properties.ts. */
  async listTicketProperties(): Promise<ListTicketPropertiesResult> {
    if (!this.accessToken) return { ok: false, error: 'No access token configured' };
    return listTicketProperties(this.accessToken);
  }

  async setToken(token: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'Empty token' };
    // Verify first so we don't persist a bad token.
    const verify = await this.verify(trimmed);
    if (!verify.ok) return { ok: false, error: verify.error ?? 'Verification failed' };
    this.accessToken = trimmed;
    this.portalId = verify.portalId ?? null;
    this.credentialsUnreadable = false;
    this.loadedOk = true;
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
    this.credentialsUnreadable = false;
    this.portalId = null;
    this.defaultPipeline = null;
    this.defaultStage = null;
    this.followUpProperty = null;
    this.dueDateProperty = null;
    this.pipelinesCache = null;
    await Promise.all([
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.accessToken, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.portalId, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultPipeline, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.defaultStage, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.followUpProperty, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.dueDateProperty, ''),
      backendPutSetting(this.deps.backendPort, HUBSPOT_SETTING_KEYS.enabled, false),
    ]);
  }

  async setDefaults(defaults: {
    pipeline: string | null;
    stage: string | null;
    followUpProperty?: string | null;
    dueDateProperty?: string | null;
  }): Promise<void> {
    this.defaultPipeline = defaults.pipeline ?? null;
    this.defaultStage = defaults.stage ?? null;
    const writes: Array<Promise<unknown>> = [
      backendPutSetting(
        this.deps.backendPort,
        HUBSPOT_SETTING_KEYS.defaultPipeline,
        this.defaultPipeline ?? '',
      ),
      backendPutSetting(
        this.deps.backendPort,
        HUBSPOT_SETTING_KEYS.defaultStage,
        this.defaultStage ?? '',
      ),
    ];
    // Only touch the custom-property settings when the caller passes them, so an
    // older client that omits these fields doesn't blank them out.
    if (defaults.followUpProperty !== undefined) {
      this.followUpProperty = defaults.followUpProperty || null;
      writes.push(
        backendPutSetting(
          this.deps.backendPort,
          HUBSPOT_SETTING_KEYS.followUpProperty,
          this.followUpProperty ?? '',
        ),
      );
    }
    if (defaults.dueDateProperty !== undefined) {
      this.dueDateProperty = defaults.dueDateProperty || null;
      writes.push(
        backendPutSetting(
          this.deps.backendPort,
          HUBSPOT_SETTING_KEYS.dueDateProperty,
          this.dueDateProperty ?? '',
        ),
      );
    }
    await Promise.all(writes);
  }

  status(): HubSpotStatusResponse {
    // Safety net: the UI polls status every 10s, so if the startup load never
    // completed (backend was unreachable) and no retry is pending, kick one.
    if (!this.loadedOk && !this.initRetryTimer) {
      void this.init().catch(() => {
        /* scheduleInitRetry already handles transient failures */
      });
    }
    return {
      hasToken: Boolean(this.accessToken),
      credentialsUnreadable: this.credentialsUnreadable,
      portalId: this.portalId,
      defaultPipeline: this.defaultPipeline,
      defaultStage: this.defaultStage,
      followUpProperty: this.followUpProperty,
      dueDateProperty: this.dueDateProperty,
      tokenBackend: secureTokenBackend(),
    };
  }
}
