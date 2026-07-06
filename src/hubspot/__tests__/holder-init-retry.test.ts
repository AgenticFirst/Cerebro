/**
 * HubSpotHolder.init() resilience — init runs once at app startup; if the
 * backend hiccups at that exact moment the holder used to stay token-less
 * ("HubSpot disconnected" in chat and UI) for the whole session. It must
 * retry with backoff, and status() must kick a retry as a safety net. A
 * stored-but-undecryptable token surfaces as `credentialsUnreadable`.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

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

import { HubSpotHolder } from '../holder';

type HolderInternals = {
  loadedOk: boolean;
  initRetryTimer: NodeJS.Timeout | null;
  initRetryDelayMs: number;
};

describe('HubSpotHolder.init retry', () => {
  it('schedules a backoff retry when the backend is unreachable', async () => {
    const holder = new HubSpotHolder({ backendPort: 1 }); // refused
    await holder.init();

    const internals = holder as unknown as HolderInternals;
    expect(internals.loadedOk).toBe(false);
    expect(internals.initRetryTimer).not.toBeNull();
    expect(internals.initRetryDelayMs).toBe(10_000); // doubled from the 5s base
    expect(holder.status().hasToken).toBe(false);
  });

  it('status() kicks a load when the startup one never completed', () => {
    const holder = new HubSpotHolder({ backendPort: 1 });
    const initSpy = vi.spyOn(holder, 'init');

    holder.status();
    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});

describe('HubSpotHolder credentialsUnreadable', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.includes('hubspot_access_token')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ value: JSON.stringify('v1:enc:AAAA') }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'not found' }));
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
    const holder = new HubSpotHolder({ backendPort: port });
    await holder.init();

    const status = holder.status();
    expect(status.hasToken).toBe(false);
    expect(status.credentialsUnreadable).toBe(true);
    // The load itself completed (backend reachable) — no retry loop.
    expect((holder as unknown as HolderInternals).loadedOk).toBe(true);
    expect((holder as unknown as HolderInternals).initRetryTimer).toBeNull();
  });
});
