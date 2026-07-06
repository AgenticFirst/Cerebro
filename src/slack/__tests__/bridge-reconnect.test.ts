/**
 * SlackBridge start() resilience — a transient failure (backend unreachable
 * while loading settings, e.g. mid idle-watchdog bounce or right after laptop
 * wake) must arm a backoff retry instead of leaving the bridge permanently
 * dead with a misleading "token not configured" error. A stored-but-
 * undecryptable token must surface as `credentialsUnreadable` in status().
 */
import EventEmitter from 'node:events';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// See bridge-set-tokens.test.ts for why electron/node-pty are mocked. Here
// `decryptString` THROWS to simulate a keychain that can no longer read the
// stored envelope (different OS user, changed keychain).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: () => {
      throw new Error('keychain mismatch');
    },
  },
  app: { getPath: () => '/tmp', getName: () => 'cerebro' },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));
vi.mock('node-pty', () => ({ spawn: () => undefined }));

import { SlackBridge } from '../bridge';

type BridgeInternals = {
  reconnectTimer: NodeJS.Timeout | null;
  reconnectDelayMs: number;
  lastError: string | null;
};

function makeBridge(backendPort: number) {
  return new SlackBridge({
    backendPort,
    agentRuntime: {} as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });
}

describe('SlackBridge reconnect on transient start failure', () => {
  it('arms a backoff retry when the backend is unreachable during loadSettings', async () => {
    // Port 1 refuses connections — the strict token getter throws
    // SettingsUnavailableError instead of reading as "no token".
    const bridge = makeBridge(1);
    await bridge.start();

    const internals = bridge as unknown as BridgeInternals;
    expect(internals.reconnectTimer).not.toBeNull();
    expect(internals.reconnectDelayMs).toBe(10_000); // doubled from the 5s base
    expect(internals.lastError).toMatch(/backend unavailable/i);
    expect(bridge.status().running).toBe(false);

    // A user-initiated stop must cancel the pending retry and reset backoff.
    await bridge.stop();
    expect(internals.reconnectTimer).toBeNull();
    expect(internals.reconnectDelayMs).toBe(5_000);
  });
});

describe('SlackBridge credentialsUnreadable', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      const isToken = req.url?.includes('slack_bot_token') || req.url?.includes('slack_app_token');
      req.on('end', () => {
        if (req.method === 'GET' && isToken) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ value: JSON.stringify('v1:enc:AAAA') }));
        } else if (req.method === 'GET') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'not found' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports a stored-but-undecryptable token instead of "not configured"', async () => {
    const bridge = makeBridge(port);
    await bridge.start();

    const status = bridge.status();
    expect(status.hasBotToken).toBe(false);
    expect(status.credentialsUnreadable).toBe(true);
    // Decrypt failure is NOT transient — no retry loop.
    expect((bridge as unknown as BridgeInternals).reconnectTimer).toBeNull();
  });
});
