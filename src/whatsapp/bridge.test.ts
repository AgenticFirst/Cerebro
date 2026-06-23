/**
 * Integration tests for WhatsAppBridge driven against a mocked Baileys socket.
 *
 * These exist because the real failure can only be reproduced against the
 * customer's WhatsApp account (an `@lid`-addressed contact + a server-side
 * init-queries timeout). To get production-confidence without that account we
 * mock the socket boundary and assert the *bridge's own behaviour*:
 *
 *   - an `@lid` inbound message reaches routine dispatch (the regression),
 *   - a wedged/zombie socket is detected and force-reconnected,
 *   - the close handler reconnects (and logs out wipe creds), and
 *   - manual reconnect re-opens the socket without losing the session.
 *
 * The pure JID→phone resolution is covered separately in helpers.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocked module boundaries ─────────────────────────────────────
// Shared, hoist-safe registry the baileys mock and the tests both reach.
const h = vi.hoisted(() => {
  function makeFakeSocket() {
    const handlers = new Map<string, (arg: any) => unknown>();
    const sock: any = {
      user: { id: '491700000000:3@s.whatsapp.net', name: 'Cerebro' },
      ev: {
        on: (evt: string, fn: (arg: any) => unknown) => handlers.set(evt, fn),
        removeAllListeners: () => handlers.clear(),
      },
      // Healthy by default; watchdog tests override per-socket.
      fetchPrivacySettings: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({ key: { id: 'out-1' } })),
      end: vi.fn((err?: Error) => {
        // Real Baileys emits a `connection: 'close'` when the socket ends.
        // After removeAllListeners() (what stop()/connect() do first) there is
        // no handler, so end() is a no-op — exactly like production, and it
        // keeps the watchdog's end() (handlers still live) firing a reconnect.
        const close = handlers.get('connection.update');
        if (close)
          void close({ connection: 'close', lastDisconnect: err ? { error: err } : undefined });
      }),
      __handlers: handlers,
      __fire: (evt: string, arg: any) => handlers.get(evt)?.(arg),
    };
    return sock;
  }
  const sockets: any[] = [];
  const makeWASocket = vi.fn(() => {
    const s = makeFakeSocket();
    sockets.push(s);
    return s;
  });
  return { sockets, makeWASocket };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: h.makeWASocket,
  useMultiFileAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(async () => {}),
  })),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] })),
  downloadMediaMessage: vi.fn(async () => Buffer.from('')),
}));

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,x') } }));

const backendJsonRequest = vi.fn(async () => ({ ok: true, status: 200, data: {} }) as any);
vi.mock('../shared/backend-settings', () => ({
  backendGetSetting: vi.fn(async () => undefined),
  backendPutSetting: vi.fn(async () => {}),
  backendJsonRequest: (...args: any[]) => backendJsonRequest(...(args as [])),
}));

// Keep real fs except: pretend a session exists and stub the dir writes/wipes.
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: () => true,
      promises: { ...actual.default.promises, mkdir: async () => {}, rm: async () => {} },
    },
  };
});

import { WhatsAppBridge } from './bridge';

// ── Test fixtures ────────────────────────────────────────────────

const ALLOWED = '573181445541';

/** A routine that triggers on ANY WhatsApp number with no content filter. */
function wildcardRoutineRecord() {
  return {
    id: 'r1',
    name: 'WA Support',
    is_enabled: true,
    trigger_type: 'whatsapp_message',
    dag_json: JSON.stringify({
      steps: [{ id: 's1', type: 'agent', config: {} }],
      trigger: {
        triggerType: 'trigger_whatsapp_message',
        config: { phone_number: '*', filter_type: 'none', filter_value: '' },
      },
    }),
  };
}

/** Default backend routing: create conversation, return the wildcard routine,
 *  accept message persistence. Individual tests can override. */
function defaultBackendRouting() {
  backendJsonRequest.mockImplementation((async (_port: number, method: string, pathStr: string) => {
    if (method === 'POST' && pathStr === '/conversations') {
      return { ok: true, status: 200, data: { id: 'conv-1' } };
    }
    if (method === 'GET' && pathStr === '/routines') {
      return { ok: true, status: 200, data: { routines: [wildcardRoutineRecord()] } };
    }
    return { ok: true, status: 200, data: {} };
  }) as any);
}

interface Harness {
  bridge: WhatsAppBridge;
  startRun: ReturnType<typeof vi.fn>;
  sock: () => any;
}

/** Build a bridge, allowlist ALLOWED, enable it (which connects), and fire the
 *  `connection: 'open'` event so it reaches the `connected` state + watchdog. */
async function connectedBridge(): Promise<Harness> {
  const startRun = vi.fn(async () => {});
  const bridge = new WhatsAppBridge({
    backendPort: 1234,
    dataDir: '/tmp/cerebro-test',
    executionEngine: { startRun } as any,
  });
  bridge.setWebContents({ send: vi.fn(), isDestroyed: () => false } as any);
  await bridge.setAllowlist([ALLOWED]);
  const res = await bridge.enable();
  expect(res.ok).toBe(true);
  // Drive the socket to "connected".
  const sock = () => h.sockets[h.sockets.length - 1];
  await sock().__fire('connection.update', { connection: 'open' });
  return { bridge, startRun, sock };
}

function lidMessage(over: Record<string, any> = {}) {
  const { key: keyOver, ...rest } = over;
  return {
    key: {
      remoteJid: '111222333444555@lid',
      senderPn: `${ALLOWED}@s.whatsapp.net`,
      id: 'm-1',
      fromMe: false,
      ...(keyOver ?? {}),
    },
    message: { conversation: 'Hola, necesito ayuda' },
    pushName: 'Cliente',
    ...rest,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.sockets.length = 0;
  h.makeWASocket.mockClear();
  backendJsonRequest.mockReset();
  defaultBackendRouting();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  // NB: deliberately NOT vi.restoreAllMocks() — it wipes the inline
  // implementations of our hoisted vi.fn mocks (makeWASocket etc.), corrupting
  // every later test. beforeEach clears call history instead.
});

/** A detached connect() (fired from a reconnect timer) awaits a dynamic
 *  import() whose resolution the fake-timer microtask pump doesn't drive. Switch
 *  to REAL timers and pump the event loop until the fresh socket actually
 *  appears (bounded), so the reconnect fully completes inside this test and
 *  nothing spills into the next one. */
async function settleDetachedConnectUntil(socketCount: number): Promise<void> {
  vi.useRealTimers();
  const deadline = Date.now() + 1_000;
  while (h.sockets.length < socketCount && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Capture console.log lines across an action, bypassing vitest's console
 *  interception (which makes vi.spyOn(console) unreliable here). */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

// ── 1. The @lid regression: inbound dispatch end-to-end ──────────

describe('inbound dispatch', () => {
  it('dispatches an @lid message (resolved via senderPn) to the matching routine', async () => {
    const { startRun, sock } = await connectedBridge();

    await sock().__fire('messages.upsert', { type: 'notify', messages: [lidMessage()] });

    expect(startRun).toHaveBeenCalledTimes(1);
    const payload = startRun.mock.calls[0][1].triggerPayload;
    expect(payload.phone_number).toBe(`+${ALLOWED}`);
    // wa_jid must be the dialable PN form, NOT the opaque @lid we received on.
    expect(payload.wa_jid).toBe(`${ALLOWED}@s.whatsapp.net`);
    expect(payload.message_text).toBe('Hola, necesito ayuda');
  });

  it('still dispatches a classic <pn>@s.whatsapp.net message (no regression)', async () => {
    const { startRun, sock } = await connectedBridge();

    await sock().__fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: `${ALLOWED}@s.whatsapp.net`, id: 'm-2', fromMe: false },
          message: { conversation: 'classic path' },
          pushName: 'Cliente',
        },
      ],
    });

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0][1].triggerPayload.message_text).toBe('classic path');
  });

  it('does NOT dispatch an @lid message whose senderPn is not allowlisted', async () => {
    const { startRun, sock } = await connectedBridge();

    const logs = await captureLogs(async () => {
      await sock().__fire('messages.upsert', {
        type: 'notify',
        messages: [lidMessage({ key: { senderPn: '14150000000@s.whatsapp.net' } })],
      });
    });

    expect(startRun).not.toHaveBeenCalled();
    expect(logs).toContain('non-allowlisted');
  });

  it('logs (does not silently drop) an @lid message with no resolvable phone', async () => {
    const { startRun, sock } = await connectedBridge();

    const logs = await captureLogs(async () => {
      await sock().__fire('messages.upsert', {
        type: 'notify',
        messages: [lidMessage({ key: { senderPn: undefined, participantPn: undefined } })],
      });
    });

    expect(startRun).not.toHaveBeenCalled();
    // Critical: the customer's symptom was the message vanishing with NO log
    // line. It must now leave a trace.
    expect(logs).toMatch(/@lid message with no resolvable phone/i);
  });

  it('ignores group (@g.us) messages', async () => {
    const { startRun, sock } = await connectedBridge();

    await sock().__fire('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '120363000000000000@g.us', participant: `${ALLOWED}@s.whatsapp.net` },
          message: { conversation: 'group msg' },
        },
      ],
    });

    expect(startRun).not.toHaveBeenCalled();
  });

  it('ignores non-notify (history backfill) upserts', async () => {
    const { startRun, sock } = await connectedBridge();
    await sock().__fire('messages.upsert', { type: 'append', messages: [lidMessage()] });
    expect(startRun).not.toHaveBeenCalled();
  });
});

// ── 2. Watchdog: detect a wedged socket and force a reconnect ────

describe('liveness watchdog', () => {
  it('force-reconnects a wedged socket (probe hangs) within ~100s', async () => {
    const { sock } = await connectedBridge();
    const first = sock();
    // Simulate the zombie: the query channel never answers.
    first.fetchPrivacySettings.mockImplementation(() => new Promise(() => {}));

    await vi.advanceTimersByTimeAsync(35_000); // first probe fires
    await vi.advanceTimersByTimeAsync(20_000); // fail 1 (probe timeout) → recheck
    await vi.advanceTimersByTimeAsync(3_000); // probe 2
    await vi.advanceTimersByTimeAsync(20_000); // fail 2 → recheck
    await vi.advanceTimersByTimeAsync(3_000); // probe 3
    await vi.advanceTimersByTimeAsync(20_000); // fail 3 → tear down + schedule reconnect

    expect(first.end).toHaveBeenCalled();
    expect(h.sockets.length).toBe(1); // not reconnected yet

    await vi.advanceTimersByTimeAsync(5_000); // close-handler backoff fires the reconnect
    await settleDetachedConnectUntil(2);
    expect(h.sockets.length).toBe(2); // a fresh socket replaced the zombie
  });

  it('does NOT reconnect a healthy socket (probes keep passing)', async () => {
    const { sock } = await connectedBridge();
    const first = sock();
    // fetchPrivacySettings resolves (default healthy mock).

    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5 minutes of healthy probing

    expect(first.end).not.toHaveBeenCalled();
    expect(h.sockets.length).toBe(1);
    expect(first.fetchPrivacySettings.mock.calls.length).toBeGreaterThan(1);
  });

  it('recovers a socket that wedges only after several healthy probes', async () => {
    const { sock } = await connectedBridge();
    const first = sock();
    let healthy = true;
    first.fetchPrivacySettings.mockImplementation(() =>
      healthy ? Promise.resolve({}) : new Promise(() => {}),
    );

    await vi.advanceTimersByTimeAsync(2 * 60_000); // healthy for 2 min
    expect(first.end).not.toHaveBeenCalled();

    healthy = false; // now it wedges
    await vi.advanceTimersByTimeAsync(45_000 + 3 * (20_000 + 3_000) + 5_000);
    expect(first.end).toHaveBeenCalled();
    await settleDetachedConnectUntil(2);
    expect(h.sockets.length).toBe(2);
  });
});

// ── 3. connection: 'close' handling ──────────────────────────────

describe('connection close', () => {
  it('schedules a 5s reconnect on a non-logout disconnect (e.g. restartRequired)', async () => {
    const { sock } = await connectedBridge();

    await sock().__fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } }, // restartRequired
    });
    expect(h.sockets.length).toBe(1); // not yet

    await vi.advanceTimersByTimeAsync(5_000);
    await settleDetachedConnectUntil(2);
    expect(h.sockets.length).toBe(2); // reconnected
  });

  it('wipes the session and does NOT reconnect on a loggedOut disconnect', async () => {
    const { bridge, sock } = await connectedBridge();

    await sock().__fire('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } }, // loggedOut
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.sockets.length).toBe(1); // no reconnect
    expect(bridge.status().state).toBe('off');
    expect(bridge.status().hasCreds).toBe(false);
  });
});

// ── 4. Manual reconnect control ──────────────────────────────────

describe('manual reconnect', () => {
  it('tears down and re-opens the socket, keeping the session', async () => {
    const { bridge } = await connectedBridge();
    expect(h.sockets.length).toBe(1);

    const res = await bridge.reconnect();

    expect(res.ok).toBe(true);
    expect(h.sockets.length).toBe(2); // a fresh socket was created
  });

  it('refuses to reconnect when the bridge is disabled', async () => {
    const bridge = new WhatsAppBridge({
      backendPort: 1234,
      dataDir: '/tmp/cerebro-test',
      executionEngine: { startRun: vi.fn() } as any,
    });
    const res = await bridge.reconnect();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disabled/i);
    expect(h.sockets.length).toBe(0);
  });
});
