/**
 * SlackBridge.setTokens — token replacement should NOT hot-restart a live
 * bridge. Replacing bot/app tokens while Slack is running must persist the new
 * tokens but leave the running bridge untouched, returning a warning that tells
 * the operator to disable and re-enable Slack so the change applies cleanly.
 *
 * Regression test for #31.
 */
import EventEmitter from 'node:events';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SlackBridge } from '../bridge';

// Absorb the backend /settings/{key} PUTs setTokens issues so the bridge can
// "persist" tokens without a real backend running.
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeBridge() {
  return new SlackBridge({
    backendPort: port,
    agentRuntime: {} as never,
    dataDir: '/tmp',
    engineEventBus: new EventEmitter(),
  });
}

describe('SlackBridge.setTokens', () => {
  it('does not hot-restart Slack when saving replacement tokens while running', async () => {
    const bridge = makeBridge();
    // Simulate a live bridge with the old token pair already loaded.
    (bridge as unknown as { running: boolean }).running = true;
    (bridge as unknown as { settings: Record<string, unknown> }).settings = {
      botToken: 'old-bot',
      appToken: 'old-app',
      enabled: true,
    };

    const stopSpy = vi.spyOn(bridge, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(bridge, 'start').mockResolvedValue();

    const result = await bridge.setTokens({ botToken: 'new-bot', appToken: 'new-app' });

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/disable and re-enable Slack/i),
    });
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    // The running bridge keeps its original live tokens until re-enable.
    const settings = (bridge as unknown as { settings: { botToken: string; appToken: string } }).settings;
    expect(settings.botToken).toBe('old-bot');
    expect(settings.appToken).toBe('old-app');
  });

  it('persists tokens normally when the bridge is not running', async () => {
    const bridge = makeBridge();
    (bridge as unknown as { running: boolean }).running = false;
    (bridge as unknown as { settings: Record<string, unknown> }).settings = {
      botToken: null,
      appToken: null,
      enabled: false,
    };

    const stopSpy = vi.spyOn(bridge, 'stop').mockResolvedValue();
    const startSpy = vi.spyOn(bridge, 'start').mockResolvedValue();

    const result = await bridge.setTokens({ botToken: 'new-bot', appToken: 'new-app' });

    expect(result).toEqual({ ok: true });
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    const settings = (bridge as unknown as { settings: { botToken: string; appToken: string } }).settings;
    expect(settings.botToken).toBe('new-bot');
    expect(settings.appToken).toBe('new-app');
  });
});
