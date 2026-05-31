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
 *  - No media handling in the initial version — text only
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
import type { AgentRuntime, AgentEventSink } from '../agents/runtime';
import type { RendererAgentEvent } from '../agents/types';
import { IPC_CHANNELS } from '../types/ipc';
import {
  backendGetSetting,
  backendJsonRequest,
  backendPutSetting,
} from '../shared/backend-settings';
import { SlidingWindowLimiter } from '../shared/channel-helpers';
import {
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

// ── Tunables ────────────────────────────────────────────────────

const OUTBOUND_RATE_PER_HOUR = 30;
const ROUTINE_CACHE_TTL_MS = 30_000;
const HISTORY_MESSAGES_IN_PAYLOAD = 20;
// Liveness watchdog tunables. 20s per-probe sits well under Baileys' default
// 60s query timeout (avoids false positives on a slow round-trip), while 3
// consecutive misses recovers a dead socket in ~2-3 min without flapping on a
// single transient blip.
const WATCHDOG_INTERVAL_MS = 45_000;        // probe a connected socket every 45s
const WATCHDOG_PROBE_TIMEOUT_MS = 20_000;   // a probe that hangs >20s counts as a failure
const WATCHDOG_MAX_FAILURES = 3;            // ~2-3 min of silence before forced reconnect

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
  agentRuntime: AgentRuntime | null;
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
  private routineCache: { routines: WhatsAppTriggerRoutine[]; at: number } = { routines: [], at: 0 };
  private conversationCache = new Map<string, ConversationCacheEntry>();
  private activeRuns = new Map<string, { runId: string; conversationId: string; startedAt: number }>();
  /** Maps @lid JIDs → @s.whatsapp.net JIDs. Newer WA clients use LIDs instead of phone-based JIDs. */
  private lidToPhone = new Map<string, string>();
  /** The bot's own LID JID (e.g. "212785631903780@lid"), populated at connect time.
   *  Needed to recognise self-chat messages where remoteJid is our own LID. */
  private selfLid: string | null = null;

  /** True when start()/stop() is in flight — guards against reentrancy. */
  private transitioning = false;
  /** True when the operator explicitly asked for pairing mode; stays on until
   *  either pairing completes or cancelPairing() is called. */
  private pairingRequested = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Liveness watchdog: detects a connected-but-dead socket and forces a
   *  reconnect. See WATCHDOG_* constants and startWatchdog(). */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogFailures = 0;
  private watchdogProbing = false;

  private mediaIngest: MediaIngestService;
  private staging: IntegrationStaging;
  // Lazily-cached Baileys helper for downloading inbound media bytes.
  private downloadMedia: ((msg: any) => Promise<Buffer>) | null = null;

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
    } catch { /* ignore */ }
    this.sock = null;
    this.saveCreds = null;
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
    this.setState({ state: 'off', phoneNumber: null, pushName: null, qr: null, lastError: null, hasCreds: false });
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

  /** Force a re-read of settings (used by the UI after a save). */
  async reloadSettings(): Promise<void> {
    const [allowlist, enabled, usernames, conversations, selfLid] = await Promise.all([
      backendGetSetting<string[]>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.allowlist),
      backendGetSetting<boolean>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled),
      backendGetSetting<Record<string, string>>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.phoneUsernames),
      backendGetSetting<Record<string, string>>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.phoneConversations),
      backendGetSetting<string>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.selfLid),
    ]);
    this.settings.allowlist = Array.isArray(allowlist) ? allowlist : [];
    this.settings.enabled = typeof enabled === 'boolean' ? enabled : false;
    this.settings.phoneUsernames = usernames && typeof usernames === 'object' ? usernames : {};
    this.settings.phoneConversations = conversations && typeof conversations === 'object' ? conversations : {};
    // Restore selfLid from previous session so self-chat works immediately on reconnect.
    if (typeof selfLid === 'string' && selfLid.endsWith('@lid') && !this.selfLid) {
      this.selfLid = selfLid;
      log(`selfLid restored from settings: ${this.selfLid}`);
    }
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
  private outboundGuard(phoneOrJid: string): { jid: string | null; digits: string | null; error: string | null } {
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
    } catch { return false; }
  }

  private async connect(opts: { pairing: boolean }): Promise<void> {
    // Clean up any prior socket.
    this.stopWatchdog();
    try { this.sock?.ev?.removeAllListeners?.(); this.sock?.end?.(undefined); } catch { /* ignore */ }
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

    // Seed selfLid from creds before the socket opens — creds.me.lid is often
    // populated even when sock.user.lid is null at connection time.
    if (!this.selfLid && authState.creds?.me?.lid && authState.creds?.me?.id) {
      const lidDigits = normalizePhone(authState.creds.me.lid);
      this.selfLid = `${lidDigits}@lid`;
      const phoneJid = `${normalizePhone(authState.creds.me.id)}@s.whatsapp.net`;
      this.lidToPhone.set(this.selfLid, phoneJid);
      log(`selfLid from creds: ${this.selfLid} → ${phoneJid}`);
      backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.selfLid, this.selfLid)
        .catch(() => {});
    }

    let version: number[] | undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched?.version;
    } catch { /* fall back to Baileys's compiled-in default */ }

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
      // Use the Baileys default timeout (undefined = 60s) instead of 30s.
      // The 30s timeout was causing fetchProps to fail on slower connections,
      // triggering constant reconnects that corrupt the Signal encryption session
      // and cause Bad MAC errors (15-second decrypt retries) on every message.
    });
    this.sock = sock;

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (err) { logError('saveCreds failed:', err); }
    });

    // Build a LID → phone JID map so messages from newer WA clients (which use
    // @lid instead of @s.whatsapp.net) can be matched against the allowlist.
    // Also used to learn selfLid when me.lid is not available at connection time.
    sock.ev.on('contacts.upsert', (contacts: any[]) => {
      const selfPhone = this.sock?.user?.id ? normalizePhone(this.sock.user.id) : null;
      for (const c of contacts) {
        const phoneJid = [c.id, c.lid].find((j: string | undefined) => j?.endsWith('@s.whatsapp.net'));
        const lidJid = [c.id, c.lid].find((j: string | undefined) => j?.endsWith('@lid'));
        if (phoneJid && lidJid) {
          const digits = normalizePhone(lidJid);
          const canonical = `${digits}@lid`;
          // Seed both canonical and raw forms so lookups work regardless of device suffix.
          this.lidToPhone.set(canonical, phoneJid);
          if (lidJid !== canonical) this.lidToPhone.set(lidJid, phoneJid);
          // If this contact is our own account, ensure selfLid is set.
          if (!this.selfLid && selfPhone && normalizePhone(phoneJid) === selfPhone) {
            this.selfLid = canonical;
            log(`selfLid learned from contacts: ${this.selfLid}`);
            // Persist for future sessions.
            backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.selfLid, this.selfLid)
              .catch((err) => logError('selfLid persist failed:', err));
          }
        }
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
        // Capture the bot's own LID so self-chat can be detected immediately,
        // before contacts.upsert has populated the lidToPhone map.
        // Seed both the raw form AND the device-suffix-stripped form into lidToPhone
        // because WhatsApp delivers self-chat remoteJids without the device suffix
        // (e.g. "212785631903780@lid") while sock.user.lid includes it ("212785631903780:2@lid").
        // Capture selfLid from connection (me.lid) and seed lidToPhone immediately.
        // If me.lid is null (common on fresh sessions), fall back to the persisted value.
        if (me?.id) {
          const phoneJid = `${normalizePhone(me.id)}@s.whatsapp.net`;
          if (me?.lid) {
            const lidDigits = normalizePhone(me.lid);
            this.selfLid = `${lidDigits}@lid`;
            const rawLid = me.lid.endsWith('@lid') ? me.lid : `${me.lid}@lid`;
            this.lidToPhone.set(this.selfLid, phoneJid);
            if (rawLid !== this.selfLid) this.lidToPhone.set(rawLid, phoneJid);
            log(`own LID: ${this.selfLid} → ${phoneJid}`);
            backendPutSetting(this.deps.backendPort, WHATSAPP_SETTING_KEYS.selfLid, this.selfLid)
              .catch((err) => logError('selfLid persist failed:', err));
          } else if (this.selfLid) {
            // me.lid not available yet — seed lidToPhone from persisted selfLid.
            this.lidToPhone.set(this.selfLid, phoneJid);
            log(`own LID (from settings): ${this.selfLid} → ${phoneJid}`);
          }
        }
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
        // Baileys connectionReplaced = 440: another WhatsApp Web session took over.
        // Don't loop — tell the user to close the other session and re-scan.
        const replaced = statusCode === 440;
        log('connection closed, statusCode=', statusCode, 'loggedOut=', loggedOut);
        if (loggedOut) {
          // Phone unlinked the device. Wipe creds so the next pairing starts fresh.
          await this.clearSession();
          return;
        }
        if (replaced) {
          if (this.pairingRequested) {
            // Conflict during the setup wizard: the saved creds belong to
            // another active WA Web session. Wipe them and show a fresh QR
            // so the user can complete pairing without needing to manually
            // clear the session first.
            log('conflict/replaced during pairing — wiping stale creds and retrying with fresh QR');
            try {
              await fs.promises.rm(this.sessionDir, { recursive: true, force: true });
            } catch { /* ignore */ }
            this.conversationCache.clear();
            this.setState({ state: 'pairing', hasCreds: false, qr: null, lastError: null });
            // Small delay so the Baileys socket teardown completes before we open a new one.
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
              this.connect({ pairing: true }).catch((err) => logError('fresh pairing failed:', err));
            }, 1_500);
          } else {
            // Not in the pairing wizard: just stop and prompt the user.
            this.setState({
              state: 'error',
              lastError: 'Session replaced — another WhatsApp Web session is active. Close it, then disconnect + re-pair here.',
              qr: null,
            });
          }
          return;
        }
        // Any other disconnect: attempt reconnect with backoff if we were
        // meant to be up. Don't auto-reconnect during explicit pairing —
        // the user is watching the QR and will retry manually.
        this.setState({ state: 'connecting', qr: null });
        if (this.settings.enabled && !this.pairingRequested) {
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          // 408 = fetchProps timeout. Reconnecting in 5s resets the Signal
          // encryption session every minute, causing Bad MAC on every new
          // self-chat message. Wait much longer so the session is stable.
          const delayMs = statusCode === 408 ? 90_000 : 5_000;
          if (statusCode === 408) log('fetchProps timeout — delaying reconnect 90s to preserve Signal session');
          this.reconnectTimer = setTimeout(() => {
            this.connect({ pairing: false }).catch((err) => logError('reconnect failed:', err));
          }, delayMs);
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

  /** Begin periodic liveness probing of the live socket. Idempotent: a second
   *  call while a timer is already running is a no-op, so reconnects that re-open
   *  the connection can't stack timers. */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogFailures = 0;
    this.watchdogTimer = setInterval(() => { void this.probeLiveness(); }, WATCHDOG_INTERVAL_MS);
    // Don't let the watchdog keep the process alive on its own.
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
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
    if (this.watchdogProbing) return; // a prior probe is still in flight
    if (!this.sock || this.state.state !== 'connected') return;
    this.watchdogProbing = true;
    const sock = this.sock;
    try {
      // fetchPrivacySettings(true) forces a real server round-trip (the
      // unforced call can return a cached value and mask a dead socket).
      await Promise.race([
        sock.fetchPrivacySettings(true),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('watchdog probe timed out')), WATCHDOG_PROBE_TIMEOUT_MS),
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
      if (this.watchdogFailures >= WATCHDOG_MAX_FAILURES && this.settings.enabled && !this.pairingRequested) {
        log('watchdog: socket unresponsive, forcing reconnect');
        this.stopWatchdog();
        // Ending the socket emits `connection: 'close'`, whose handler clears
        // any prior timer and schedules the 5s reconnect — we don't schedule
        // our own to avoid a double reconnect.
        try { sock.end?.(new Error('watchdog: unresponsive socket')); } catch { /* ignore */ }
      }
    } finally {
      this.watchdogProbing = false;
    }
  }

  // ── Inbound dispatch ─────────────────────────────────────────

  private async handleIncomingMessage(msg: any): Promise<void> {
    if (!msg?.message) return;
    if (msg.key?.fromMe) {
      const rawRemoteJid: string | undefined = msg.key?.remoteJid;
      if (!rawRemoteJid) return;

      let resolvedForSelfCheck = rawRemoteJid;
      if (rawRemoteJid.endsWith('@lid')) {
        // Digit-normalised comparison is suffix-agnostic ("212785631903780:2@lid"
        // and "212785631903780@lid" both normalise to "212785631903780").
        const ownDigits = normalizePhone(rawRemoteJid);
        const selfDigits = this.selfLid ? normalizePhone(this.selfLid) : null;
        if (selfDigits && ownDigits === selfDigits) {
          resolvedForSelfCheck = `${this.sock?.user?.id ? normalizePhone(this.sock.user.id) : ownDigits}@s.whatsapp.net`;
        } else {
          const exact = this.lidToPhone.get(rawRemoteJid);
          if (exact) {
            resolvedForSelfCheck = exact;
          } else {
            let found: string | undefined;
            for (const [k, v] of this.lidToPhone) {
              if (normalizePhone(k) === ownDigits) { found = v; break; }
            }
            if (found) {
              this.lidToPhone.set(rawRemoteJid, found);
              resolvedForSelfCheck = found;
            } else {
              log(`dropped: fromMe LID ${rawRemoteJid} not in contacts map`);
              return;
            }
          }
        }
      }

      const selfPhone = this.sock?.user?.id ? normalizePhone(this.sock.user.id) : null;
      const remotePhone = normalizePhone(resolvedForSelfCheck);
      if (!selfPhone || !remotePhone || selfPhone !== remotePhone) return;
      // Self-chat: fall through.
    }
    const remoteJid: string | undefined = msg.key?.remoteJid;
    if (!remoteJid) return;

    // Newer WhatsApp clients identify contacts by @lid (Linked Identity Device)
    // rather than @s.whatsapp.net. Resolve to the phone-based JID via the
    // contacts map populated from contacts.upsert, then fall through normally.
    let resolvedJid = remoteJid;
    if (remoteJid.endsWith('@lid')) {
      const phoneJid = this.lidToPhone.get(remoteJid);
      if (!phoneJid) {
        log(`LID ${remoteJid} not yet in contacts map — dropping (re-send to retry)`);
        return;
      }
      resolvedJid = phoneJid;
    } else if (!remoteJid.endsWith('@s.whatsapp.net')) {
      return; // group, broadcast, etc.
    }

    const inbound = extractInbound(msg);
    let text = inbound.text;

    // If there's no text AND no media, nothing for us to do.
    if (!text && !inbound.media) return;

    const phone = normalizePhone(resolvedJid);
    if (!phone) return;

    // Self-chat always bypasses the allowlist — the operator testing their own
    // number should never be blocked by allowlist configuration.
    const selfPhone = this.sock?.user?.id ? normalizePhone(this.sock.user.id) : null;
    const isSelfChat = !!selfPhone && phone === selfPhone;
    if (!isSelfChat && !this.isAllowlisted(phone)) {
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
    if (matched.length > 0) {
      // Dispatch each matched routine with the trigger payload.
      const payload: WhatsAppTriggerPayload = {
        phone_number: toDisplayPhone(phone),
        wa_jid: remoteJid,
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
      return;
    }

    // No routine matched — fall back to the AI agent (conversational mode).
    const runtime = this.deps.agentRuntime;
    if (!runtime) {
      log(`no routine matched ${phone} and no agentRuntime — dropping`);
      return;
    }

    const existing = this.activeRuns.get(phone);
    if (existing) {
      const elapsedSec = Math.round((Date.now() - existing.startedAt) / 1000);
      try {
        await this.sock.sendMessage(toUserJid(phone), {
          text: `Still working on the previous message (${elapsedSec}s). Please wait.`,
        });
      } catch { /* ignore */ }
      return;
    }

    // Show typing indicator immediately so the contact knows the message was received.
    try { await this.sock.sendPresenceUpdate('composing', toUserJid(phone)); } catch { /* ignore */ }

    const isFirstContact = !this.settings.phoneConversations[phone];
    const sink = new WhatsAppStreamSink(
      () => this.sock,  // always returns the current live socket
      phone,
      async (finalText, err) => {
        try {
          // Clear the typing indicator once done.
          await this.sock?.sendPresenceUpdate('paused', toUserJid(phone)).catch(() => {});
          if (!err && finalText) {
            this.appendToHistory(phone, 'assistant', finalText);
            this.persistMessage(convo.conversationId, 'assistant', finalText, phone);
          }
        } finally {
          this.activeRuns.delete(phone);
        }
      },
    );

    try {
      const runId = await runtime.startRun(sink, {
        conversationId: convo.conversationId,
        content: text,
        resume: !isFirstContact,
        recentMessages: convo.history,
        source: { kind: 'whatsapp', phone },
        // WhatsApp replies — fast tier with haiku for speed.
        qualityTier: 'fast',
        model: 'haiku',
        maxTurns: 10,
      });
      sink.runId = runId;
      this.activeRuns.set(phone, {
        runId,
        conversationId: convo.conversationId,
        startedAt: Date.now(),
      });
      log(`started AI run ${runId} for ${phone}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('agentRuntime.startRun failed:', msg);
      try {
        await this.sock.sendMessage(toUserJid(phone), {
          text: 'Sorry, I could not process your message right now. Please try again.',
        });
      } catch { /* ignore */ }
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

    const createRes = await backendJsonRequest<{ id: string }>(this.deps.backendPort, 'POST', '/conversations', {
      id: crypto.randomUUID().replace(/-/g, ''),
      title: `WhatsApp ${toDisplayPhone(phone)}`,
      source: 'cerebro',
      external_chat_id: `whatsapp:${phone}`,
    });
    if (!createRes.ok || !createRes.data?.id) {
      logError('create conversation failed:', createRes.status);
      return null;
    }
    const conversationId = createRes.data.id;
    this.settings.phoneConversations = { ...this.settings.phoneConversations, [phone]: conversationId };
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
      id: crypto.randomUUID().replace(/-/g, ''),
      role,
      content,
      metadata: { source: 'whatsapp', whatsapp_phone: phone },
    }).then((res) => {
      if (res.ok) this.emitConversationUpdated(conversationId, 'message');
      else logError('persistMessage failed:', res.status);
    }).catch((err) => logError('persistMessage threw:', err));
  }

  private async getTriggerRoutines(): Promise<WhatsAppTriggerRoutine[]> {
    const now = Date.now();
    if (now - this.routineCache.at < ROUTINE_CACHE_TTL_MS) {
      return this.routineCache.routines;
    }
    const res = await backendJsonRequest<{ routines?: BackendRoutineRecord[] } | BackendRoutineRecord[]>(
      this.deps.backendPort,
      'GET',
      '/routines',
    );
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
    } catch { /* ignore */ }
  }

  private emitConversationUpdated(conversationId: string, kind: 'created' | 'message'): void {
    if (!this.webContents || this.webContents.isDestroyed()) return;
    try {
      this.webContents.send(IPC_CHANNELS.WHATSAPP_CONVERSATION_UPDATED, { conversationId, kind });
    } catch { /* ignore */ }
  }
}

// ── WhatsApp AI stream sink ──────────────────────────────────────

/**
 * Buffers streamed agent output and sends one WhatsApp message when the run
 * completes. WhatsApp has no "edit message" API (unlike Telegram), so we
 * accumulate all text_delta events and fire a single sendMessage on `done`.
 */
class WhatsAppStreamSink implements AgentEventSink {
  public runId: string | null = null;
  private accumulated = '';
  private destroyed = false;
  /** Returns the CURRENT live socket — evaluated at send time, not at construction. */
  private getSock: () => any;
  private phone: string;
  private onDoneCb: (finalText: string, err?: string) => Promise<void>;

  constructor(
    getSock: () => any,
    phone: string,
    onDone: (finalText: string, err?: string) => Promise<void>,
  ) {
    this.getSock = getSock;
    this.phone = phone;
    this.onDoneCb = onDone;
  }

  send(_channel: string, ...args: unknown[]): void {
    const event = args[0] as RendererAgentEvent;
    if (!event || typeof event !== 'object') return;

    if (event.type === 'run_start' && 'runId' in event) {
      this.runId = event.runId;
      return;
    }
    if (event.type === 'text_delta' && 'delta' in event) {
      this.accumulated += event.delta;
      return;
    }
    if (event.type === 'done' && 'messageContent' in event) {
      const final = event.messageContent || this.accumulated;
      void this.finish(final);
      return;
    }
    if (event.type === 'error' && 'error' in event) {
      void this.finish(null, event.error);
      return;
    }
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  private async finish(text: string | null, err?: string): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const reply = text?.trim() || (err ? 'Sorry, something went wrong. Please try again.' : null);
    console.log(`[WhatsApp] finish() phone=${this.phone} reply="${reply?.substring(0, 100)}" err=${err ?? 'none'}`);
    if (reply) {
      try {
        const sock = this.getSock();
        if (!sock) throw new Error('socket unavailable');
        const jid = toUserJid(this.phone);
        const MAX = 3800;
        if (reply.length <= MAX) {
          await sock.sendMessage(jid, { text: reply });
          console.log(`[WhatsApp] reply sent OK to ${jid}`);
        } else {
          const parts = splitMessage(reply, MAX);
          for (const part of parts) {
            await sock.sendMessage(jid, { text: part });
          }
          console.log(`[WhatsApp] reply sent OK (${parts.length} parts) to ${jid}`);
        }
      } catch (sendErr) {
        console.error('[WhatsApp] sendMessage FAILED:', sendErr instanceof Error ? sendErr.message : String(sendErr));
      }
    }
    await this.onDoneCb(reply ?? '', err).catch(() => { /* ignore */ });
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

/** Split a long string into chunks ≤ maxLen, preferring paragraph/sentence breaks. */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = maxLen;
    // Prefer splitting at a double-newline (paragraph break).
    const para = remaining.lastIndexOf('\n\n', maxLen);
    if (para > maxLen / 2) { cut = para + 2; }
    else {
      // Fall back to sentence end.
      const sent = Math.max(
        remaining.lastIndexOf('. ', maxLen),
        remaining.lastIndexOf('! ', maxLen),
        remaining.lastIndexOf('? ', maxLen),
      );
      if (sent > maxLen / 2) cut = sent + 2;
      else {
        // Last resort: newline or space.
        const nl = remaining.lastIndexOf('\n', maxLen);
        const sp = remaining.lastIndexOf(' ', maxLen);
        cut = nl > maxLen / 2 ? nl + 1 : sp > maxLen / 2 ? sp + 1 : maxLen;
      }
    }
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
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
      media: { kind: 'image', mime: m.imageMessage.mimetype ?? 'image/jpeg', filename: null, caption },
    };
  }
  if (m.videoMessage) {
    const caption = (m.videoMessage.caption ?? '') as string;
    return {
      text: caption,
      media: { kind: 'video', mime: m.videoMessage.mimetype ?? 'video/mp4', filename: null, caption },
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
