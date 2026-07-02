/**
 * WhatsAppBridge — owns a Baileys (WhatsApp Web) socket, maintains per-phone
 * conversations in Cerebro's backend, matches inbound messages to routine
 * triggers, and exposes an outbound send method for the engine's
 * send_whatsapp_message action.
 *
 * Security posture:
 *  - Allowlist gate (normalized phone numbers) before any I/O
 *  - Per-number sliding-window rate limiter on outbound sends
 *  - Session creds stored under userData/whatsapp-session/ (user-only by OS perms)
 *  - Read receipts disabled
 *  - Inbound media goes through MediaIngestService: voice notes are
 *    transcribed locally (shared STT path), documents/images are staged and
 *    parsed — raw bytes never reach the model
 *
 * NB: Baileys is loaded with dynamic `import()` so a missing package or a
 * slow native rebuild never blocks Electron's boot. start() is a no-op in
 * that case; the bridge simply reports state='error' with an explanatory
 * message until the operator resolves the install.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WebContents } from 'electron';
import QRCode from 'qrcode';
import type { ExecutionEngine } from '../engine/engine';
import type { WhatsAppChannel } from '../engine/actions/whatsapp-channel';
import { IPC_CHANNELS } from '../types/ipc';
import {
  backendGetSetting,
  backendJsonRequest,
  backendPutSetting,
} from '../shared/backend-settings';
import { SlidingWindowLimiter } from '../shared/channel-helpers';
import {
  inboundPhone,
  isAllowed,
  normalizePhone,
  parseWhatsAppTriggerRoutine,
  toUserJid,
  toDisplayPhone,
  matchWhatsAppRoutineTriggers,
} from './helpers';
import {
  WHATSAPP_SETTING_KEYS,
  type BackendRoutineRecord,
  type WhatsAppSettings,
  type WhatsAppStatusResponse,
  type WhatsAppTriggerPayload,
  type WhatsAppTriggerRoutine,
} from './types';
import crypto from 'node:crypto';
import { MediaIngestService } from '../files/media-ingest';
import { IntegrationStaging } from '../files/staging';
import { SttLoader, STT_LOADING_NOTICE } from '../files/stt-loader';

// ── Tunables ────────────────────────────────────────────────────

const OUTBOUND_RATE_PER_HOUR = 30;
const ROUTINE_CACHE_TTL_MS = 30_000;
const HISTORY_MESSAGES_IN_PAYLOAD = 20;
// Liveness watchdog tunables. 20s per-probe sits well under Baileys' default
// 60s query timeout (avoids false positives on a slow round-trip), while 3
// consecutive misses recovers a dead socket in ~2-3 min without flapping on a
// single transient blip.
const WATCHDOG_INTERVAL_MS = 45_000; // probe a healthy socket every 45s
const WATCHDOG_PROBE_TIMEOUT_MS = 20_000; // a probe that hangs >20s counts as a failure
const WATCHDOG_MAX_FAILURES = 3; // forced reconnect after this many in a row
// First probe lands just past the ~30s init-queries timeout window, so a socket
// that wedges right after connect is caught in the first minute. Once a probe
// fails we re-probe on a tight cadence instead of the slow steady-state one, so
// the 3 failures accrue in well under a minute rather than ~2-3 min.
const WATCHDOG_FIRST_PROBE_MS = 35_000;
const WATCHDOG_RECHECK_MS = 3_000;

// ── Helpers ─────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  console.log('[WhatsApp]', ...args);
}

function logError(...args: unknown[]): void {
  console.error('[WhatsApp]', ...args);
}

// ── Bridge ──────────────────────────────────────────────────────

interface BridgeDeps {
  backendPort: number;
  dataDir: string;
  executionEngine: ExecutionEngine;
}

interface ConversationInfo {
  conversationId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** In-memory cache keyed by normalized phone. Avoids fetching `/conversations/{id}/messages`
 *  on every inbound message — we already know what we've persisted. */
interface ConversationCacheEntry {
  conversationId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export class WhatsAppBridge implements WhatsAppChannel {
  private deps: BridgeDeps;
  private webContents: WebContents | null = null;
  private sessionDir: string;

  // Baileys socket + auth — kept as `any` to avoid pulling baileys's entire
  // type tree through the engine during builds where the package is missing.
  private sock: any = null;
  private saveCreds: (() => Promise<void>) | null = null;

  private settings: WhatsAppSettings = {
    allowlist: [],
    enabled: false,
    phoneUsernames: {},
    phoneConversations: {},
  };

  private state: WhatsAppStatusResponse = {
    state: 'off',
    phoneNumber: null,
    pushName: null,
    qr: null,
    lastError: null,
    lastConnectedAt: null,
    credsBackend: 'plaintext-fallback',
    hasCreds: false,
  };

  private outboundLimiter = new SlidingWindowLimiter(OUTBOUND_RATE_PER_HOUR, 60 * 60 * 1_000);
  private routineCache: { routines: WhatsAppTriggerRoutine[]; at: number } = {
    routines: [],
    at: 0,
  };
  private conversationCache = new Map<string, ConversationCacheEntry>();

  /** True when start()/stop() is in flight — guards against reentrancy. */
  private transitioning = false;
  /** True when the operator explicitly asked for pairing mode; stays on until
   *  either pairing completes or cancelPairing() is called. */
  private pairingRequested = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Liveness watchdog: detects a connected-but-dead socket and forces a
   *  reconnect. See WATCHDOG_* constants and startWatchdog(). */
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogActive = false;
  private watchdogFailures = 0;
  private watchdogProbing = false;

  private mediaIngest: MediaIngestService;
  private staging: IntegrationStaging;
  // Lazily-cached Baileys helper for downloading inbound media bytes.
  private downloadMedia: ((msg: any) => Promise<Buffer>) | null = null;
  /** Voice STT lazy-load, shared across bridges (coalesces concurrent loads). */
  private readonly sttLoader = new SttLoader(() => this.deps.backendPort);

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.sessionDir = path.join(deps.dataDir, 'whatsapp-session');
    this.mediaIngest = new MediaIngestService({
      getBackendPort: () => this.deps.backendPort,
      transcriptDir: path.join(this.deps.dataDir, 'files', '_transcripts'),
    });
    this.staging = new IntegrationStaging(this.deps.dataDir);
  }

  setWebContents(wc: WebContents): void {
    this.webContents = wc;
  }

  status(): WhatsAppStatusResponse {
    return { ...this.state };
  }

  /** Load settings from backend, refresh creds-on-disk check, and connect if
   *  the bridge is enabled + has creds. No-op otherwise. */
  async start(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      await this.reloadSettings();
      if (!this.settings.enabled) {
        this.setState({ state: 'off', qr: null });
        return;
      }
      if (!this.hasSessionOnDisk()) {
        this.setState({ state: 'off', qr: null });
        return;
      }
      await this.connect({ pairing: false });
    } finally {
      this.transitioning = false;
    }
  }

  async stop(): Promise<void> {
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pairingRequested = false;
    try {
      this.sock?.ev?.removeAllListeners?.();
      this.sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this.saveCreds = null;
    this.sttLoader.reset();
    this.setState({ state: 'off', qr: null });
  }

  /** Trigger a fresh pairing flow: create (or reuse) the session dir, spin
   *  up a socket, and let the `connection.update` handler surface QR codes
   *  to the UI. */
  async startPairing(): Promise<{ ok: boolean; error?: string }> {
    this.pairingRequested = true;
    try {
      // Flip enabled on so the bridge persists creds when the user scans.
      this.settings.enabled = true;
      await backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled, true);
      await this.connect({ pairing: true });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('startPairing failed:', msg);
      this.setState({ state: 'error', lastError: msg });
      return { ok: false, error: msg };
    }
  }

  async cancelPairing(): Promise<void> {
    if (!this.pairingRequested) return;
    this.pairingRequested = false;
    await this.stop();
  }

  /** Wipe the on-disk session so a new pairing can start fresh. */
  async clearSession(): Promise<{ ok: boolean; error?: string }> {
    await this.stop();
    try {
      await fs.promises.rm(this.sessionDir, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled, false);
    this.settings.enabled = false;
    this.conversationCache.clear();
    this.setState({
      state: 'off',
      phoneNumber: null,
      pushName: null,
      qr: null,
      lastError: null,
      hasCreds: false,
    });
    return { ok: true };
  }

  async setAllowlist(list: string[]): Promise<void> {
    this.settings.allowlist = list;
    await backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.allowlist, list);
  }

  async enable(): Promise<{ ok: boolean; error?: string }> {
    this.settings.enabled = true;
    await backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled, true);
    if (!this.hasSessionOnDisk()) {
      return { ok: false, error: 'No WhatsApp session — pair a device first.' };
    }
    await this.stop();
    try {
      await this.connect({ pairing: false });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async disable(): Promise<void> {
    this.settings.enabled = false;
    await backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled, false);
    await this.stop();
  }

  /** Tear down and re-open the socket without touching the saved session — the
   *  manual recovery lever for a wedged/zombie socket (e.g. a stranded receiver
   *  after an init-queries timeout) when the watchdog hasn't cycled yet. Creds
   *  are already persisted via `creds.update`, so no pairing or data is lost. */
  async reconnect(): Promise<{ ok: boolean; error?: string }> {
    if (!this.settings.enabled) {
      return { ok: false, error: 'WhatsApp bridge is disabled.' };
    }
    if (!this.hasSessionOnDisk()) {
      return { ok: false, error: 'No WhatsApp session — pair a device first.' };
    }
    if (this.pairingRequested) {
      return { ok: false, error: 'Pairing in progress — finish or cancel it first.' };
    }
    if (this.transitioning) {
      return { ok: false, error: 'Bridge is busy — try again in a moment.' };
    }
    this.transitioning = true;
    try {
      await this.stop();
      await this.connect({ pairing: false });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('manual reconnect failed:', msg);
      this.setState({ state: 'error', lastError: msg });
      return { ok: false, error: msg };
    } finally {
      this.transitioning = false;
    }
  }

  /** Force a re-read of settings (used by the UI after a save). */
  async reloadSettings(): Promise<void> {
    const [allowlist, enabled, usernames, conversations] = await Promise.all([
      backendGetSetting<string[]>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.allowlist),
      backendGetSetting<boolean>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled),
      backendGetSetting<Record<string, string>>(
        this.deps.backendPort,
        WHATSAPP_SETTING_KEYS.phoneUsernames,
      ),
      backendGetSetting<Record<string, string>>(
        this.deps.backendPort,
        WHATSAPP_SETTING_KEYS.phoneConversations,
      ),
    ]);
    this.settings.allowlist = Array.isArray(allowlist) ? allowlist : [];
    this.settings.enabled = typeof enabled === 'boolean' ? enabled : false;
    this.settings.phoneUsernames = usernames && typeof usernames === 'object' ? usernames : {};
    this.settings.phoneConversations =
      conversations && typeof conversations === 'object' ? conversations : {};
    this.setState({ hasCreds: this.hasSessionOnDisk() });
  }

  // ── WhatsAppChannel implementation ───────────────────────────

  isAllowlisted(phoneOrJid: string): boolean {
    return isAllowed(phoneOrJid, this.settings.allowlist);
  }

  isConnected(): boolean {
    return this.sock !== null && this.state.state === 'connected';
  }

  async sendActionMessage(
    phoneOrJid: string,
    text: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    if (!this.sock || this.state.state !== 'connected') {
      return { messageId: null, error: 'WhatsApp bridge is not connected.' };
    }
    const digits = normalizePhone(phoneOrJid);
    if (!digits) return { messageId: null, error: 'Invalid phone number.' };
    if (!this.outboundLimiter.allow(digits)) {
      return { messageId: null, error: 'Rate limit exceeded for this number.' };
    }
    const jid = toUserJid(digits);
    try {
      const result = await this.sock.sendMessage(jid, { text });
      const messageId: string | null = result?.key?.id ?? null;
      const convoId = this.settings.phoneConversations[digits];
      if (convoId) {
        this.appendToHistory(digits, 'assistant', text);
        this.persistMessage(convoId, 'assistant', text, digits);
      }
      return { messageId, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('sendMessage failed:', msg);
      return { messageId: null, error: msg };
    }
  }

  // ── Outbound media (chat-action surface) ─────────────────────
  // All seven share the same pre-flight (`outboundGuard`). Baileys sends
  // media synchronously on the WhatsApp Web socket — long-lived uploads can
  // drop on multi-MB sends, so callers should treat send errors as recoverable
  // and let the chat agent retry with permission.

  async sendPhotoActionMessage(
    phoneOrJid: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    return this.sendBaileysMedia(phoneOrJid, filePath, (jid) => ({
      image: { url: filePath },
      caption,
    }));
  }

  async sendDocumentActionMessage(
    phoneOrJid: string,
    filePath: string,
    caption?: string,
    fileName?: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    return this.sendBaileysMedia(phoneOrJid, filePath, () => ({
      document: { url: filePath },
      caption,
      fileName: fileName ?? path.basename(filePath),
    }));
  }

  async sendAudioActionMessage(
    phoneOrJid: string,
    filePath: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    return this.sendBaileysMedia(phoneOrJid, filePath, () => ({
      audio: { url: filePath },
      mimetype: 'audio/mpeg',
    }));
  }

  async sendVideoActionMessage(
    phoneOrJid: string,
    filePath: string,
    caption?: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    return this.sendBaileysMedia(phoneOrJid, filePath, () => ({
      video: { url: filePath },
      caption,
    }));
  }

  async sendVoiceActionMessage(
    phoneOrJid: string,
    filePath: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    return this.sendBaileysMedia(phoneOrJid, filePath, () => ({
      audio: { url: filePath },
      ptt: true,
      mimetype: 'audio/ogg; codecs=opus',
    }));
  }

  async sendStickerActionMessage(
    phoneOrJid: string,
    filePath: string,
  ): Promise<{ messageId: string | null; error: string | null }> {
    return this.sendBaileysMedia(phoneOrJid, filePath, () => ({
      sticker: { url: filePath },
    }));
  }

  async sendLocationActionMessage(
    phoneOrJid: string,
    latitude: number,
    longitude: number,
  ): Promise<{ messageId: string | null; error: string | null }> {
    const guard = this.outboundGuard(phoneOrJid);
    if (guard.error || !guard.jid) return { messageId: null, error: guard.error };
    try {
      const result = await this.sock.sendMessage(guard.jid, {
        location: { degreesLatitude: latitude, degreesLongitude: longitude },
      });
      return { messageId: result?.key?.id ?? null, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { messageId: null, error: msg };
    }
  }

  /** Common pre-flight for outbound: socket connected + allowlist + rate-limit. */
  private outboundGuard(phoneOrJid: string): {
    jid: string | null;
    digits: string | null;
    error: string | null;
  } {
    if (!this.sock || this.state.state !== 'connected') {
      return { jid: null, digits: null, error: 'WhatsApp bridge is not connected.' };
    }
    const digits = normalizePhone(phoneOrJid);
    if (!digits) return { jid: null, digits: null, error: 'Invalid phone number.' };
    if (!this.outboundLimiter.allow(digits)) {
      return { jid: null, digits: null, error: 'Rate limit exceeded for this number.' };
    }
    return { jid: toUserJid(digits), digits, error: null };
  }

  /** Build the Baileys payload via a callback so each media kind can supply
   * its own field (`image`/`document`/etc.), then send + persist. */
  private async sendBaileysMedia(
    phoneOrJid: string,
    filePath: string,
    buildPayload: (jid: string) => Record<string, unknown>,
  ): Promise<{ messageId: string | null; error: string | null }> {
    const guard = this.outboundGuard(phoneOrJid);
    if (guard.error || !guard.jid) return { messageId: null, error: guard.error };
    if (!fs.existsSync(filePath)) {
      return { messageId: null, error: `file not found: ${filePath}` };
    }
    try {
      const payload = buildPayload(guard.jid);
      const result = await this.sock.sendMessage(guard.jid, payload);
      return { messageId: result?.key?.id ?? null, error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('sendMedia failed:', msg);
      return { messageId: null, error: msg };
    }
  }

  // ── Connection management ────────────────────────────────────

  private hasSessionOnDisk(): boolean {
    try {
      return fs.existsSync(path.join(this.sessionDir, 'creds.json'));
    } catch {
      return false;
    }
  }

  private async connect(opts: { pairing: boolean }): Promise<void> {
    // Clean up any prior socket.
    this.stopWatchdog();
    try {
      this.sock?.ev?.removeAllListeners?.();
      this.sock?.end?.(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;

    // Dynamic-import baileys so a missing module doesn't crash main.ts boot.
    let baileys: any;
    try {
      baileys = await import('@whiskeysockets/baileys');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ state: 'error', lastError: `Baileys not installed: ${msg}` });
      throw new Error(`Baileys not installed: ${msg}`);
    }

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      downloadMediaMessage,
    } = baileys;
    this.downloadMedia = downloadMediaMessage as (msg: any) => Promise<Buffer>;

    await fs.promises.mkdir(this.sessionDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    this.saveCreds = saveCreds;

    let version: number[] | undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched?.version;
    } catch {
      /* fall back to Baileys's compiled-in default */
    }

    this.setState({
      state: opts.pairing ? 'pairing' : 'connecting',
      lastError: null,
      qr: null,
    });

    const sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Cerebro only acts on live `notify` messages (see the messages.upsert
      // handler) — it never consumes history backfill or app-state sync.
      // Returning false makes Baileys flush its event buffer immediately on
      // connect instead of entering the Syncing state, whose resyncAppState()
      // can hang on a 60s query timeout and strand the buffer so messages.upsert
      // never fires again (the "connected but silent" zombie socket).
      shouldSyncHistoryMessage: () => false,
      // Fail any internal query fast (default is 60s). shouldSyncHistoryMessage
      // suppresses history sync but not the app-state resyncAppState() queries
      // that produce the ~60s connect-time stall; a shorter timeout makes those
      // surface an error into the `connection: 'close'` reconnect path instead
      // of hanging.
      defaultQueryTimeoutMs: 30_000,
    });
    this.sock = sock;

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        logError('saveCreds failed:', err);
      }
    });

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
          this.setState({ state: 'pairing', qr: dataUrl, lastError: null });
        } catch (err) {
          logError('QR encode failed:', err);
        }
      }
      if (connection === 'open') {
        const me = sock.user;
        const phone = me?.id ? normalizePhone(me.id) : null;
        this.pairingRequested = false;
        this.setState({
          state: 'connected',
          phoneNumber: phone ? toDisplayPhone(phone) : null,
          pushName: typeof me?.name === 'string' ? me.name : null,
          qr: null,
          lastError: null,
          lastConnectedAt: Date.now(),
          hasCreds: true,
        });
        log(`connected as ${me?.id ?? '(unknown)'}`);
        this.startWatchdog();
      }
      if (connection === 'close') {
        this.stopWatchdog();
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason?.loggedOut;
        log('connection closed, statusCode=', statusCode, 'loggedOut=', loggedOut);
        if (loggedOut) {
          // Phone unlinked the device. Wipe creds so the next pairing starts fresh.
          await this.clearSession();
          return;
        }
        // Any other disconnect: attempt reconnect with backoff if we were
        // meant to be up. Don't auto-reconnect during explicit pairing —
        // the user is watching the QR and will retry manually.
        this.setState({ state: 'connecting', qr: null });
        if (this.settings.enabled && !this.pairingRequested) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.connect({ pairing: false }).catch((err) => logError('reconnect failed:', err));
          }, 5_000);
        } else {
          this.setState({ state: 'off' });
        }
      }
    });

    sock.ev.on('messages.upsert', async (evt: any) => {
      if (!evt || evt.type !== 'notify') return;
      const messages: any[] = Array.isArray(evt.messages) ? evt.messages : [];
      for (const msg of messages) {
        try {
          await this.handleIncomingMessage(msg);
        } catch (err) {
          logError('handleIncomingMessage threw:', err);
        }
      }
    });
  }

  // ── Liveness watchdog ────────────────────────────────────────

  /** Begin liveness probing of the live socket. Idempotent: a second call while
   *  already active is a no-op, so reconnects that re-open the connection can't
   *  stack timers. The probe self-reschedules (see probeLiveness) so the cadence
   *  can tighten while a socket looks wedged. */
  private startWatchdog(): void {
    if (this.watchdogActive) return;
    this.watchdogActive = true;
    this.watchdogFailures = 0;
    this.scheduleProbe(WATCHDOG_FIRST_PROBE_MS);
  }

  /** (Re)arm the single watchdog timer. */
  private scheduleProbe(delayMs: number): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      void this.probeLiveness();
    }, delayMs);
    // Don't let the watchdog keep the process alive on its own.
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
  }

  private stopWatchdog(): void {
    this.watchdogActive = false;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogFailures = 0;
    this.watchdogProbing = false;
  }

  /** Actively round-trip a cheap query against the socket. A hang or error past
   *  WATCHDOG_PROBE_TIMEOUT_MS counts as a failure; after WATCHDOG_MAX_FAILURES
   *  consecutive failures we tear the socket down and let the `connection:
   *  'close'` handler schedule the reconnect (single reconnect funnel). */
  private async probeLiveness(): Promise<void> {
    if (this.watchdogProbing) return; // in-flight probe will re-arm the timer
    if (!this.watchdogActive) return;
    if (!this.sock || this.state.state !== 'connected') {
      // Not probeable yet (e.g. mid-reconnect). Stay armed so probing resumes
      // once the socket is back; a real close calls stopWatchdog to clear this.
      this.scheduleProbe(WATCHDOG_INTERVAL_MS);
      return;
    }
    this.watchdogProbing = true;
    const sock = this.sock;
    try {
      // fetchPrivacySettings(true) forces a real server round-trip (the
      // unforced call can return a cached value and mask a dead socket).
      await Promise.race([
        sock.fetchPrivacySettings(true),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('watchdog probe timed out')),
            WATCHDOG_PROBE_TIMEOUT_MS,
          ),
        ),
      ]);
      this.watchdogFailures = 0;
    } catch (err) {
      if (sock !== this.sock) return; // socket was swapped out from under us
      this.watchdogFailures += 1;
      logError(
        `watchdog probe failed (${this.watchdogFailures}/${WATCHDOG_MAX_FAILURES}):`,
        err instanceof Error ? err.message : String(err),
      );
      if (
        this.watchdogFailures >= WATCHDOG_MAX_FAILURES &&
        this.settings.enabled &&
        !this.pairingRequested
      ) {
        log('watchdog: socket unresponsive, forcing reconnect');
        this.stopWatchdog();
        // Ending the socket emits `connection: 'close'`, whose handler clears
        // any prior timer and schedules the 5s reconnect — we don't schedule
        // our own to avoid a double reconnect.
        try {
          sock.end?.(new Error('watchdog: unresponsive socket'));
        } catch {
          /* ignore */
        }
      }
    } finally {
      this.watchdogProbing = false;
      // Re-arm unless a failure already tore the socket down (stopWatchdog
      // clears watchdogActive). Recheck fast while a failure is outstanding so
      // we confirm a wedge in seconds, not minutes.
      if (this.watchdogActive && sock === this.sock) {
        this.scheduleProbe(this.watchdogFailures > 0 ? WATCHDOG_RECHECK_MS : WATCHDOG_INTERVAL_MS);
      }
    }
  }

  // ── Inbound dispatch ─────────────────────────────────────────

  private async handleIncomingMessage(msg: any): Promise<void> {
    // Ignore messages we sent ourselves; ignore group / broadcast messages
    // for the MVP (customer-support flow is 1:1).
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;
    const remoteJid: string | undefined = msg.key?.remoteJid;
    // Accept classic `<pn>@s.whatsapp.net` and newer `<lid>@lid` 1:1 senders;
    // groups / broadcast / newsletter stay out of scope. `inboundPhone` resolves
    // the dialable number — for `@lid` that means reading `senderPn`, since the
    // lid itself is an opaque id rather than a phone.
    const phone = inboundPhone(msg.key);
    if (!phone) {
      // An `@lid` message whose phone we can't resolve would otherwise vanish
      // before any log line — surface it so a real customer isn't invisible.
      if (remoteJid?.endsWith('@lid')) {
        log('ignoring @lid message with no resolvable phone:', remoteJid);
      }
      return;
    }

    const inbound = extractInbound(msg);
    let text = inbound.text;

    // If there's no text AND no media, nothing for us to do.
    if (!text && !inbound.media) return;

    if (!this.isAllowlisted(phone)) {
      log(`ignoring message from non-allowlisted ${phone}`);
      return;
    }

    // Download + ingest media (if present) BEFORE we persist or dispatch.
    // Concatenates the resolved attachment's prompt injection ahead of any
    // caption so the agent sees image/document context first, then the
    // user's typed words.
    if (inbound.media) {
      const ingested = await this.ingestInboundMedia(msg, inbound.media);
      if (ingested) {
        text = text ? `${ingested}\n\n${text}` : ingested;
      } else if (!text) {
        // Media download failed AND no caption — bail rather than start a run
        // with empty content.
        log('media ingest failed and no caption — skipping');
        return;
      }
    }

    if (!text) return;

    const pushName: string | undefined = msg.pushName;
    if (pushName && pushName !== this.settings.phoneUsernames[phone]) {
      // Merge into local cache and write back the whole map. Small race window
      // vs concurrent inbound messages from different numbers; acceptable
      // because pushNames flicker and the last write wins.
      this.settings.phoneUsernames = { ...this.settings.phoneUsernames, [phone]: pushName };
      backendPutSetting(
        this.deps.backendPort,
        WHATSAPP_SETTING_KEYS.phoneUsernames,
        this.settings.phoneUsernames,
      ).catch((err) => logError('phoneUsernames persist failed:', err));
    }

    // Resolve the conversation + matching routines in parallel — neither
    // depends on the other.
    const [convo, routines] = await Promise.all([
      this.ensureConversation(phone),
      this.getTriggerRoutines(),
    ]);
    if (!convo) {
      logError(`could not create conversation for ${phone}`);
      return;
    }

    // Persist inbound message + update in-memory history. Fire-and-forget on
    // the backend write so routine dispatch isn't blocked by it.
    this.appendToHistory(phone, 'user', text);
    this.persistMessage(convo.conversationId, 'user', text, phone);

    const matched = matchWhatsAppRoutineTriggers(routines, phone, text);
    if (matched.length === 0) {
      log(`no routine matched ${phone}: "${text.slice(0, 40)}"`);
      return;
    }

    // Dispatch each matched routine with the trigger payload. We intentionally
    // fire in parallel so slow routines don't block faster ones.
    const payload: WhatsAppTriggerPayload = {
      phone_number: toDisplayPhone(phone),
      // Always the dialable `<pn>@s.whatsapp.net` form — for an `@lid` sender the
      // raw remoteJid is an opaque lid that can't be messaged back.
      wa_jid: toUserJid(phone),
      customer_display_name: pushName ?? this.settings.phoneUsernames[phone] ?? '',
      message_text: text,
      message_id: msg.key?.id ?? '',
      received_at: new Date().toISOString(),
      conversation_id: convo.conversationId,
      conversation_history: convo.history,
    };

    for (const routine of matched) {
      try {
        if (!this.webContents) {
          logError('no webContents attached — cannot start routine run');
          continue;
        }
        await this.deps.executionEngine.startRun(this.webContents, {
          dag: routine.dag,
          routineId: routine.id,
          triggerSource: 'whatsapp_message',
          triggerPayload: payload as unknown as Record<string, unknown>,
        });
        log(`started routine ${routine.name} for ${phone}`);
      } catch (err) {
        logError(`routine ${routine.name} failed to start:`, err);
      }
    }
  }

  // ── Inbound media ────────────────────────────────────────────

  /** Download a Baileys media message to staging, route through MediaIngestService,
   *  return the attachment's prompt injection. Returns null on any failure
   *  (no media downloader, write fail, ingest fail). */
  private async ingestInboundMedia(
    msg: any,
    media: { kind: string; mime: string | null; filename: string | null },
  ): Promise<string | null> {
    if (!this.downloadMedia) {
      logError('Baileys not connected — cannot download inbound media');
      return null;
    }
    let bytes: Buffer;
    try {
      bytes = await this.downloadMedia(msg);
    } catch (err) {
      logError('downloadMediaMessage failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
    if (!bytes || bytes.length === 0) return null;

    const ext = media.filename
      ? path.extname(media.filename).replace(/^\./, '').toLowerCase()
      : extForMime(media.mime ?? '', media.kind);
    const fname = `${crypto.randomUUID()}.${ext || 'bin'}`;
    const dest = this.staging.pathFor('whatsapp', fname);
    try {
      await fs.promises.writeFile(dest, bytes);
    } catch (err) {
      logError('failed to write inbound media:', err instanceof Error ? err.message : String(err));
      return null;
    }
    // TTL cleanup mirrors Telegram (30 min).
    this.staging.scheduleCleanup(dest);

    // Voice notes / audio: make sure the Whisper STT model is loaded before
    // MediaIngestService hits /voice/stt/transcribe-file. The first voice note
    // in a session may need to download the model (~30–60s) — ensureSTTReady
    // sends a one-time notice so the user knows why there's a delay. Mirrors
    // Telegram and Slack. Without this the backend returns 503 and the agent
    // only sees a "transcription unavailable" placeholder.
    if (media.kind === 'voice' || media.kind === 'audio') {
      const jid = msg?.key?.remoteJid as string | undefined;
      const ready = await this.ensureSTTReady(jid);
      if (!ready) {
        if (jid) {
          await this.notifyUser(
            jid,
            '🎙️ Voice transcription is unavailable right now. ' +
              'Try typing your message, or open Settings → Voice to set it up.',
          );
        }
        return null;
      }
    }

    try {
      const resolved = await this.mediaIngest.ingest({
        filePath: dest,
        source: 'whatsapp-inbound',
      });
      return resolved.promptInjection;
    } catch (err) {
      logError('media ingest failed:', err instanceof Error ? err.message : String(err));
      return `[attachment at ${dest}]`;
    }
  }

  /** Send a transient system note straight to the socket — no rate-limit spend,
   *  no history persistence (unlike sendActionMessage). Best-effort. */
  private async notifyUser(jid: string, text: string): Promise<void> {
    if (!this.sock || this.state.state !== 'connected') return;
    try {
      await this.sock.sendMessage(jid, { text });
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Ensure the Whisper STT model is loaded, sending a one-time "loading…" notice
   * to the user on a cold start. Returns true once /voice/stt/transcribe-file is
   * safe to call. See `SttLoader` for the shared load/download/coalesce logic.
   */
  private ensureSTTReady(jid: string | undefined): Promise<boolean> {
    return this.sttLoader.ensureReady(async () => {
      if (jid) await this.notifyUser(jid, STT_LOADING_NOTICE);
    });
  }

  // ── Backend helpers ──────────────────────────────────────────

  private async ensureConversation(phone: string): Promise<ConversationInfo | null> {
    // Fast path: we've already handled a message from this phone in this
    // session — the cache has the conversation id + running history, no
    // backend round-trip needed.
    const memCached = this.conversationCache.get(phone);
    if (memCached) {
      return { conversationId: memCached.conversationId, history: [...memCached.history] };
    }

    // First message from this phone since the bridge started — resolve the
    // conversation id (from settings or fresh create) and hydrate history
    // once.
    const storedId = this.settings.phoneConversations[phone];
    if (storedId) {
      const history = await this.fetchConversationHistory(storedId);
      if (history !== null) {
        this.conversationCache.set(phone, { conversationId: storedId, history: [...history] });
        return { conversationId: storedId, history };
      }
      // Stored id was deleted server-side — fall through to create.
    }

    const createRes = await backendJsonRequest<{ id: string }>(
      this.deps.backendPort,
      'POST',
      '/conversations',
      {
        title: `WhatsApp ${toDisplayPhone(phone)}`,
        source: 'whatsapp',
        external_chat_id: phone,
      },
    );
    if (!createRes.ok || !createRes.data?.id) {
      logError('create conversation failed:', createRes.status);
      return null;
    }
    const conversationId = createRes.data.id;
    this.settings.phoneConversations = {
      ...this.settings.phoneConversations,
      [phone]: conversationId,
    };
    // Fire-and-forget — routine dispatch shouldn't block on this write.
    backendPutSetting(
      this.deps.backendPort,
      WHATSAPP_SETTING_KEYS.phoneConversations,
      this.settings.phoneConversations,
    ).catch((err) => logError('phoneConversations persist failed:', err));
    this.conversationCache.set(phone, { conversationId, history: [] });
    this.emitConversationUpdated(conversationId, 'created');
    return { conversationId, history: [] };
  }

  private appendToHistory(phone: string, role: 'user' | 'assistant', content: string): void {
    const entry = this.conversationCache.get(phone);
    if (!entry) return;
    entry.history.push({ role, content });
    if (entry.history.length > HISTORY_MESSAGES_IN_PAYLOAD * 2) {
      entry.history.splice(0, entry.history.length - HISTORY_MESSAGES_IN_PAYLOAD * 2);
    }
  }

  private async fetchConversationHistory(
    conversationId: string,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }> | null> {
    const res = await backendJsonRequest<{ messages?: Array<{ role: string; content: string }> }>(
      this.deps.backendPort,
      'GET',
      `/conversations/${conversationId}/messages?limit=${HISTORY_MESSAGES_IN_PAYLOAD}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) return [];
    const msgs = res.data?.messages ?? [];
    return msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  }

  /** Fire-and-forget persistence of a single conversation message. */
  private persistMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    phone: string,
  ): void {
    backendJsonRequest(this.deps.backendPort, 'POST', `/conversations/${conversationId}/messages`, {
      role,
      content,
      metadata: { source: 'whatsapp', whatsapp_phone: phone },
    })
      .then((res) => {
        if (res.ok) this.emitConversationUpdated(conversationId, 'message');
        else logError('persistMessage failed:', res.status);
      })
      .catch((err) => logError('persistMessage threw:', err));
  }

  private async getTriggerRoutines(): Promise<WhatsAppTriggerRoutine[]> {
    const now = Date.now();
    if (now - this.routineCache.at < ROUTINE_CACHE_TTL_MS) {
      return this.routineCache.routines;
    }
    const res = await backendJsonRequest<
      { routines?: BackendRoutineRecord[] } | BackendRoutineRecord[]
    >(this.deps.backendPort, 'GET', '/routines');
    const rawList: BackendRoutineRecord[] = Array.isArray(res.data)
      ? (res.data as BackendRoutineRecord[])
      : (res.data?.routines ?? []);
    const parsed: WhatsAppTriggerRoutine[] = [];
    for (const r of rawList) {
      if (!r.is_enabled) continue;
      if (r.trigger_type !== 'whatsapp_message') continue;
      const parsedRoutine = parseWhatsAppTriggerRoutine(r);
      if (parsedRoutine) parsed.push(parsedRoutine);
    }
    this.routineCache = { routines: parsed, at: now };
    return parsed;
  }

  // ── State / event emitters ───────────────────────────────────

  private setState(patch: Partial<WhatsAppStatusResponse>): void {
    this.state = { ...this.state, ...patch };
    this.emitStatusChanged();
  }

  private emitStatusChanged(): void {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    try {
      this.webContents.send(IPC_CHANNELS.WHATSAPP_STATUS_CHANGED, this.state);
    } catch {
      /* ignore */
    }
  }

  private emitConversationUpdated(conversationId: string, kind: 'created' | 'message'): void {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    try {
      this.webContents.send(IPC_CHANNELS.WHATSAPP_CONVERSATION_UPDATED, { conversationId, kind });
    } catch {
      /* ignore */
    }
  }
}

// ── Message-extraction helpers ──────────────────────────────────

interface InboundMedia {
  /** Baileys media kind, drives ext + outbound display. */
  kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
  mime: string | null;
  /** Suggested filename (documents) or null — we'll synthesize one. */
  filename: string | null;
  /** Caption that came with the media (also returned in `text`). */
  caption: string;
}

interface InboundMessage {
  /** Plain text the user typed, OR a media caption. Empty if no text and no caption. */
  text: string;
  /** Single inbound media descriptor — WhatsApp sends one media kind per message. */
  media: InboundMedia | null;
}

function extractMessageText(msg: any): string {
  // Backwards-compat shim retained for any external callers; new code should
  // use extractInbound() to also see media.
  return extractInbound(msg).text;
}

function extForMime(mime: string, fallbackKind: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };
  if (map[mime]) return map[mime];
  // Fall back to a kind-based guess for media WhatsApp doesn't mime-tag well.
  const kindFallback: Record<string, string> = {
    image: 'jpg',
    voice: 'ogg',
    audio: 'mp3',
    video: 'mp4',
    document: 'bin',
    sticker: 'webp',
  };
  return kindFallback[fallbackKind] || 'bin';
}

export function extractInbound(msg: any): InboundMessage {
  const m = msg?.message;
  if (!m) return { text: '', media: null };

  if (typeof m.conversation === 'string' && m.conversation.trim()) {
    return { text: m.conversation, media: null };
  }
  if (typeof m.extendedTextMessage?.text === 'string') {
    return { text: m.extendedTextMessage.text, media: null };
  }
  if (m.imageMessage) {
    const caption = (m.imageMessage.caption ?? '') as string;
    return {
      text: caption,
      media: {
        kind: 'image',
        mime: m.imageMessage.mimetype ?? 'image/jpeg',
        filename: null,
        caption,
      },
    };
  }
  if (m.videoMessage) {
    const caption = (m.videoMessage.caption ?? '') as string;
    return {
      text: caption,
      media: {
        kind: 'video',
        mime: m.videoMessage.mimetype ?? 'video/mp4',
        filename: null,
        caption,
      },
    };
  }
  if (m.documentMessage) {
    const caption = (m.documentMessage.caption ?? '') as string;
    return {
      text: caption,
      media: {
        kind: 'document',
        mime: m.documentMessage.mimetype ?? 'application/octet-stream',
        filename: m.documentMessage.fileName ?? null,
        caption,
      },
    };
  }
  if (m.audioMessage) {
    const isVoice = !!m.audioMessage.ptt;
    return {
      text: '',
      media: {
        kind: isVoice ? 'voice' : 'audio',
        mime: m.audioMessage.mimetype ?? (isVoice ? 'audio/ogg' : 'audio/mpeg'),
        filename: null,
        caption: '',
      },
    };
  }
  if (m.stickerMessage) {
    return {
      text: '',
      media: {
        kind: 'sticker',
        mime: m.stickerMessage.mimetype ?? 'image/webp',
        filename: null,
        caption: '',
      },
    };
  }
  if (typeof m.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return { text: m.buttonsResponseMessage.selectedDisplayText, media: null };
  }
  if (typeof m.listResponseMessage?.title === 'string') {
    return { text: m.listResponseMessage.title, media: null };
  }
  return { text: '', media: null };
}
