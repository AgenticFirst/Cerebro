import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { httpRequestAction } from '../actions/http-request';
import { RunScratchpad } from '../scratchpad';
import type { ActionContext } from '../actions/types';
import * as ssrfModule from '../actions/utils/ssrf';

// Happy-path tests target a real HTTP server on 127.0.0.1, which the SSRF
// guard blocks in production. Mock the guard by default and re-enable it
// explicitly in the SSRF-boundary tests below.
vi.mock('../actions/utils/ssrf', async (importOriginal) => {
  const mod = (await importOriginal()) as typeof ssrfModule;
  return {
    ...mod,
    isBlockedHost: vi.fn(() => false),
  };
});

const mockedSsrf = ssrfModule as unknown as { isBlockedHost: ReturnType<typeof vi.fn> };

let server: http.Server;
let port: number;
const received: Array<{
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });

      const url = req.url ?? '';
      if (url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'hello', method: req.method }));
      } else if (url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ got: body, headers: req.headers }));
      } else if (url === '/error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Server error' }));
      } else if (url === '/text') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('plain text response');
      } else if (url === '/invalid-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('<<not json>>');
      } else if (url === '/big') {
        // Emit ~15MB, well over the 10MB limit.
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        const chunk = Buffer.alloc(1024 * 1024, 65);
        let sent = 0;
        const interval = setInterval(() => {
          if (sent >= 15) {
            clearInterval(interval);
            res.end();
            return;
          }
          res.write(chunk);
          sent += 1;
        }, 5);
      } else if (url === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('too late');
        }, 3000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  received.length = 0;
  mockedSsrf.isBlockedHost.mockReset().mockReturnValue(false);
});

function makeContext(signal?: AbortSignal): ActionContext {
  return {
    runId: 'run-1',
    stepId: 'step-1',
    backendPort: 9999,
    signal: signal ?? new AbortController().signal,
    log: vi.fn(),
    emitEvent: vi.fn(),
    resolveModel: vi.fn(),
  };
}

describe('httpRequestAction — happy paths', () => {
  it('GET returns parsed JSON body, status, headers, duration', async () => {
    const result = await httpRequestAction.execute({
      params: { method: 'GET', url: `http://127.0.0.1:${port}/json` },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data?.status).toBe(200);
    expect(result.data?.body).toEqual({ message: 'hello', method: 'GET' });
    expect(result.data?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(typeof result.data?.duration_ms).toBe('number');
    expect(result.summary).toContain('200');
  });

  it('POST with body auto-sets Content-Type: application/json', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'POST',
        url: `http://127.0.0.1:${port}/echo`,
        body: '{"hello":"world"}',
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('POST');
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].body).toBe('{"hello":"world"}');
  });

  it('bearer auth sets Authorization header', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/json`,
        auth_type: 'bearer',
        auth_value: 'my-token',
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received[0].headers.authorization).toBe('Bearer my-token');
  });

  it('basic auth sets base64-encoded Authorization header', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/json`,
        auth_type: 'basic',
        auth_value: 'alice:secret',
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    const expected = Buffer.from('alice:secret').toString('base64');
    expect(received[0].headers.authorization).toBe(`Basic ${expected}`);
  });

  it('api_key auth sets the configured header (default X-API-Key)', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/json`,
        auth_type: 'api_key',
        auth_value: 'sk-123',
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received[0].headers['x-api-key']).toBe('sk-123');
  });

  it('api_key auth uses custom header name when auth_header is set', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/json`,
        auth_type: 'api_key',
        auth_value: 'sk-123',
        auth_header: 'X-Custom-Key',
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received[0].headers['x-custom-key']).toBe('sk-123');
  });

  it('custom headers are sent to the server', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/json`,
        headers: [
          { key: 'X-Trace-Id', value: 'abc' },
          { key: 'X-Retry', value: '3' },
        ],
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received[0].headers['x-trace-id']).toBe('abc');
    expect(received[0].headers['x-retry']).toBe('3');
  });

  it('templates {{vars}} through URL, body, headers, and auth', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'POST',
        url: `http://127.0.0.1:${port}/{{path}}`,
        body: '{"name":"{{name}}"}',
        headers: [{ key: 'X-{{headerName}}', value: '{{headerVal}}' }],
        auth_type: 'bearer',
        auth_value: '{{token}}',
      },
      wiredInputs: {
        path: 'echo',
        name: 'alice',
        headerName: 'User',
        headerVal: 'bob',
        token: 'xyz',
      },
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received[0].url).toBe('/echo');
    expect(received[0].body).toBe('{"name":"alice"}');
    expect(received[0].headers['x-user']).toBe('bob');
    expect(received[0].headers.authorization).toBe('Bearer xyz');
  });

  it('returns text body verbatim when content-type is not JSON', async () => {
    const result = await httpRequestAction.execute({
      params: { method: 'GET', url: `http://127.0.0.1:${port}/text` },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data?.body).toBe('plain text response');
  });

  it('falls back to raw string when JSON parse fails', async () => {
    const result = await httpRequestAction.execute({
      params: { method: 'GET', url: `http://127.0.0.1:${port}/invalid-json` },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data?.body).toBe('<<not json>>');
  });

  it('resolves (does NOT reject) on 4xx/5xx responses', async () => {
    const result = await httpRequestAction.execute({
      params: { method: 'GET', url: `http://127.0.0.1:${port}/error` },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(result.data?.status).toBe(500);
    expect(result.data?.body).toEqual({ detail: 'Server error' });
  });

  it('does not send a body for GET requests even if body is provided', async () => {
    await httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/json`,
        body: 'should not be sent',
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });

    expect(received[0].body).toBe('');
    expect(received[0].headers['content-type']).toBeUndefined();
  });
});

describe('httpRequestAction — failure paths', () => {
  it('rejects when URL is empty', async () => {
    await expect(
      httpRequestAction.execute({
        params: { method: 'GET', url: '' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a URL');
  });

  it('rejects when URL templates to empty', async () => {
    await expect(
      httpRequestAction.execute({
        params: { method: 'GET', url: '{{missing}}' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('requires a URL');
  });

  it('rejects invalid basic auth format (no colon)', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: `http://127.0.0.1:${port}/json`,
          auth_type: 'basic',
          auth_value: 'no-colon-here',
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow('username:password');
  });

  it('rejects when response body exceeds 10MB', async () => {
    await expect(
      httpRequestAction.execute({
        params: { method: 'GET', url: `http://127.0.0.1:${port}/big` },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/10MB limit/);
  }, 20000);

  it('rejects when the server is too slow (timeout)', async () => {
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: `http://127.0.0.1:${port}/slow`,
          timeout: 1, // 1 second
        },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/timed out/);
  }, 10000);

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      httpRequestAction.execute({
        params: { method: 'GET', url: `http://127.0.0.1:${port}/json` },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(controller.signal),
      }),
    ).rejects.toThrow('Aborted');
  });

  it('rejects when the signal aborts mid-flight', async () => {
    const controller = new AbortController();
    const p = httpRequestAction.execute({
      params: {
        method: 'GET',
        url: `http://127.0.0.1:${port}/slow`,
        timeout: 30,
      },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(controller.signal),
    });
    setTimeout(() => controller.abort(), 50);
    await expect(p).rejects.toThrow('Aborted');
  }, 10000);
});

describe('httpRequestAction — SSRF guard integration', () => {
  it('invokes isBlockedHost with the target hostname', async () => {
    mockedSsrf.isBlockedHost.mockReturnValue(false);
    await httpRequestAction.execute({
      params: { method: 'GET', url: `http://127.0.0.1:${port}/json` },
      wiredInputs: {},
      scratchpad: new RunScratchpad(),
      context: makeContext(),
    });
    expect(mockedSsrf.isBlockedHost).toHaveBeenCalledWith('127.0.0.1');
  });

  it('rejects the request when isBlockedHost returns true', async () => {
    mockedSsrf.isBlockedHost.mockReturnValue(true);
    await expect(
      httpRequestAction.execute({
        params: { method: 'GET', url: 'http://example.com/api' },
        wiredInputs: {},
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/private\/internal addresses/);
  });

  it('renders template BEFORE the SSRF check (prevents bypass via templates)', async () => {
    mockedSsrf.isBlockedHost.mockImplementation((h: string) => h === '127.0.0.1');
    await expect(
      httpRequestAction.execute({
        params: {
          method: 'GET',
          url: 'http://{{host}}/test',
        },
        wiredInputs: { host: '127.0.0.1' },
        scratchpad: new RunScratchpad(),
        context: makeContext(),
      }),
    ).rejects.toThrow(/private\/internal addresses/);
    expect(mockedSsrf.isBlockedHost).toHaveBeenCalledWith('127.0.0.1');
  });
});
