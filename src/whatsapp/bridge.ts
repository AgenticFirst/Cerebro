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

// ── Tunables ────────────────────────────────────────────────────

const OUTBOUND_RATE_PER_HOUR = 30;
const ROUTINE_CACHE_TTL_MS = 30_000;
const HISTORY_MESSAGES_IN_PAYLOAD = 20;

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
  private routineCache: { routines: WhatsAppTriggerRoutine[]; at: number } = { routines: [], at: 0 };
  private conversationCache = new Map<string, ConversationCacheEntry>();

  /** True when start()/stop() is in flight — guards against reentrancy. */
  private transitioning = false;
  /** True when the operator explicitly asked for pairing mode; stays on until
   *  either pairing completes or cancelPairing() is called. */
  private pairingRequested = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.sessionDir = path.join(deps.dataDir, 'whatsapp-session');
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
    const [allowlist, enabled, usernames, conversations] = await Promise.all([
      backendGetSetting<string[]>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.allowlist),
      backendGetSetting<boolean>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.enabled),
      backendGetSetting<Record<string, string>>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.phoneUsernames),
      backendGetSetting<Record<string, string>>(this.deps.backendPort, WHATSAPP_SETTING_KEYS.phoneConversations),
    ]);
    this.settings.allowlist = Array.isArray(allowlist) ? allowlist : [];
    this.settings.enabled = typeof enabled === 'boolean' ? enabled : false;
    this.settings.phoneUsernames = usernames && typeof usernames === 'object' ? usernames : {};
    this.settings.phoneConversations = conversations && typeof conversations === 'object' ? conversations : {};
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

  // ── Connection management ────────────────────────────────────

  private hasSessionOnDisk(): boolean {
    try {
      return fs.existsSync(path.join(this.sessionDir, 'creds.json'));
    } catch { return false; }
  }

  private async connect(opts: { pairing: boolean }): Promise<void> {
    // Clean up any prior socket.
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
    } = baileys;

    await fs.promises.mkdir(this.sessionDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    this.saveCreds = saveCreds;

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
    });
    this.sock = sock;

    sock.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (err) { logError('saveCreds failed:', err); }
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
      }
      if (connection === 'close') {
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

  // ── Inbound dispatch ─────────────────────────────────────────

  private async handleIncomingMessage(msg: any): Promise<void> {
    // Ignore messages we sent ourselves; ignore group / broadcast messages
    // for the MVP (customer-support flow is 1:1).
    if (!msg?.message) return;
    if (msg.key?.fromMe) return;
    const remoteJid: string | undefined = msg.key?.remoteJid;
    if (!remoteJid || !remoteJid.endsWith('@s.whatsapp.net')) return;

    const text = extractMessageText(msg);
    if (!text) return;

    const phone = normalizePhone(remoteJid);
    if (!phone) return;

    if (!this.isAllowlisted(phone)) {
      log(`ignoring message from non-allowlisted ${phone}`);
      return;
    }

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
      title: `WhatsApp ${toDisplayPhone(phone)}`,
      source: 'whatsapp',
      external_chat_id: phone,
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
    const res = await backendRequest<{ routines?: BackendRoutineRecord[] } | BackendRoutineRecord[]>(
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

// ── Message-extraction helper ───────────────────────────────────

function extractMessageText(msg: any): string {
  const m = msg?.message;
  if (!m) return '';
  if (typeof m.conversation === 'string' && m.conversation.trim()) return m.conversation;
  if (typeof m.extendedTextMessage?.text === 'string') return m.extendedTextMessage.text;
  if (typeof m.imageMessage?.caption === 'string') return m.imageMessage.caption;
  if (typeof m.videoMessage?.caption === 'string') return m.videoMessage.caption;
  if (typeof m.documentMessage?.caption === 'string') return m.documentMessage.caption;
  // Buttons / list responses — take the selected row title if present.
  if (typeof m.buttonsResponseMessage?.selectedDisplayText === 'string') {
    return m.buttonsResponseMessage.selectedDisplayText;
  }
  if (typeof m.listResponseMessage?.title === 'string') {
    return m.listResponseMessage.title;
  }
  return '';
}
