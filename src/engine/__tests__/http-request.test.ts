import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { httpRequestAction } from '../actions/http-request';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';

// Simple test HTTP server — binds to a public-facing IP (not 127.0.0.1)
// to avoid SSRF protection blocking test requests.
let server: http.Server;
let port: number;

// Use httpbin.org style local server on 0.0.0.0 and access via external IP?
// Actually the simplest: access via "localhost" is blocked. So we must
// mock the SSRF check for integration tests, or test the SSRF check separately.
// We'll test the action's networking with a mock server and test SSRF separately.

vi.mock('../actions/http-request', async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return mod;
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'hello', method: req.method }));
    } else if (req.url === '/error') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Server error' }));
    } else if (req.url === '/text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('plain text response');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

function makeContext(): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

describe('httpRequestAction', () => {
  it('throws on SSRF — blocks private IPs', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: `http://127.0.0.1:${port}/json`,
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('private/internal addresses');
  });

  it('throws on SSRF — blocks localhost', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: `http://localhost:${port}/json`,
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('private/internal addresses');
  });

  it('throws on SSRF — blocks 10.x.x.x', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: 'http://10.0.0.1/test',
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('private/internal addresses');
  });

  it('throws on SSRF — blocks 169.254.x.x (cloud metadata)', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: 'http://169.254.169.254/latest/meta-data/',
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('private/internal addresses');
  });

  it('throws when URL is missing', async () => {
    await expect(
      httpRequestAction.execute({
        params: { method: 'GET', url: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a URL');
  });

  it('throws on invalid basic auth format', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: 'https://example.com/api',
          auth_type: 'basic',
          auth_value: 'no-colon-here',
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('username:password');
  });
});
