/**
 * Smoke tests for the loopback chat-actions HTTP server.
 *
 * The full happy-path (run an action through to completion) is covered by
 * the engine integration tests; here we validate auth, routing, and the
 * catalog endpoint with a stubbed engine so the bridge logic is testable
 * without standing up the whole ExecutionEngine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { ChatActionServer } from '../server';

interface FetchOptions {
  method?: string;
  path: string;
  token?: string;
  body?: unknown;
}

async function request(port: number, opts: FetchOptions): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data).toString() } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          let parsed: unknown = raw;
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('ChatActionServer', () => {
  let server: ChatActionServer;
  let port: number;
  let token: string;
  let mockEngine: {
    getChatActionCatalog: ReturnType<typeof vi.fn>;
    runChatAction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    mockEngine = {
      getChatActionCatalog: vi.fn().mockReturnValue([
        {
          type: 'send_telegram_message',
          label: 'Send Telegram message',
          description: 'Send a Telegram message…',
          examples: ['Send Pablo a Telegram'],
          availability: 'available',
          group: 'telegram',
          inputSchema: { type: 'object' },
        },
      ]),
      runChatAction: vi.fn().mockResolvedValue({
        status: 'succeeded',
        runId: 'r1',
        approvalId: 'a1',
        summary: 'done',
        data: { sent: true },
      }),
    };
    server = new ChatActionServer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engine: mockEngine as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getMainWebContents: () => ({ isDestroyed: () => false } as any),
    });
    const info = await server.start();
    port = info.port;
    token = info.token;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(port, { path: '/chat-actions/health' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request(port, { path: '/nope', token });
    expect(res.status).toBe(404);
  });

  it('serves the catalog for the requested language', async () => {
    const res = await request(port, { path: '/chat-actions/catalog?lang=es', token });
    expect(res.status).toBe(200);
    expect(mockEngine.getChatActionCatalog).toHaveBeenCalledWith('es');
    const body = res.body as { lang: string; actions: Array<{ type: string }> };
    expect(body.lang).toBe('es');
    expect(body.actions[0].type).toBe('send_telegram_message');
  });

  it('defaults to English when lang is missing', async () => {
    await request(port, { path: '/chat-actions/catalog', token });
    expect(mockEngine.getChatActionCatalog).toHaveBeenCalledWith('en');
  });

  it('runs a chat action when the body is valid', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'send_telegram_message', params: { chat_id: '1', message: 'hi' } },
    });
    expect(res.status).toBe(200);
    expect(mockEngine.runChatAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'send_telegram_message' }),
    );
    const body = res.body as { status: string; data?: Record<string, unknown> };
    expect(body.status).toBe('succeeded');
    expect(body.data?.sent).toBe(true);
  });

  it('rejects /run with no type', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { params: {} },
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when an action is denied', async () => {
    mockEngine.runChatAction.mockResolvedValueOnce({
      status: 'denied',
      runId: 'r2',
      approvalId: 'a2',
      error: 'denied by user',
    });
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'send_telegram_message', params: {} },
    });
    expect(res.status).toBe(403);
    expect((res.body as { status: string }).status).toBe('denied');
  });

  it('returns 409 when the integration is not connected', async () => {
    mockEngine.runChatAction.mockResolvedValueOnce({
      status: 'unavailable',
      error: 'HubSpot is not connected',
    });
    const res = await request(port, {
      method: 'POST',
      path: '/chat-actions/run',
      token,
      body: { type: 'hubspot_create_ticket', params: { subject: 'x' } },
    });
    expect(res.status).toBe(409);
  });
});
