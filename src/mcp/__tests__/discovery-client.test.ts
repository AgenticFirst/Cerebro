import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { discoverHttp, discoverStdio } from '../discovery-client';

const TOOLS_RESULT = {
  jsonrpc: '2.0',
  id: 2,
  result: {
    tools: [
      {
        name: 'search_files',
        description: 'Search Drive files',
        annotations: { readOnlyHint: true },
      },
      { name: 'create_file', description: 'Create a file' },
    ],
  },
};

const INIT_RESULT = {
  jsonrpc: '2.0',
  id: 1,
  result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture' } },
};

/** Node one-liner that speaks just enough MCP stdio to answer the handshake. */
const STDIO_FIXTURE = `
let buf='';process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;const m=JSON.parse(line);
if(m.id===1)process.stdout.write(JSON.stringify(${JSON.stringify(INIT_RESULT)})+'\\n');
if(m.id===2)process.stdout.write(JSON.stringify(${JSON.stringify(TOOLS_RESULT)})+'\\n');}});
`;

describe('discoverStdio', () => {
  it('runs the handshake against a stdio fixture and parses tools', async () => {
    const result = await discoverStdio(process.execPath, ['-e', STDIO_FIXTURE], {}, 8000);
    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([
      { name: 'search_files', description: 'Search Drive files', readOnly: true },
      { name: 'create_file', description: 'Create a file', readOnly: false },
    ]);
  });

  it('fails fast when the command does not exist', async () => {
    const result = await discoverStdio('/no/such/binary-xyz', [], {}, 3000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to start|exited/);
  });

  it('times out (and reports it) when the server never responds', async () => {
    const result = await discoverStdio(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {},
      500,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Timed out/);
  });

  it('surfaces stderr when the server crashes', async () => {
    const result = await discoverStdio(
      process.execPath,
      ['-e', 'console.error("boom: missing API key");process.exit(1)'],
      {},
      3000,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing API key');
  });
});

describe('discoverHttp', () => {
  let server: http.Server | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  function listen(handler: http.RequestListener): Promise<string> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server!.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}/mcp/v1`);
      });
    });
  }

  function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString()));
      req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    });
  }

  it('handshakes over plain JSON, forwarding auth headers and session id', async () => {
    const seen: { auth: string[]; sessions: string[] } = { auth: [], sessions: [] };
    const url = await listen((req, res) => {
      void readBody(req).then((body) => {
        seen.auth.push(String(req.headers.authorization ?? ''));
        seen.sessions.push(String(req.headers['mcp-session-id'] ?? ''));
        if (body.method === 'initialize') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'sess-123',
          });
          res.end(JSON.stringify(INIT_RESULT));
        } else if (body.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(TOOLS_RESULT));
        }
      });
    });

    const result = await discoverHttp(url, { Authorization: 'Bearer tok-1' }, 8000);
    expect(result.ok).toBe(true);
    expect(result.tools.map((t) => t.name)).toEqual(['search_files', 'create_file']);
    expect(seen.auth.every((a) => a === 'Bearer tok-1')).toBe(true);
    // Session id from initialize must be echoed on subsequent requests.
    expect(seen.sessions[seen.sessions.length - 1]).toBe('sess-123');
  });

  it('parses SSE-framed responses', async () => {
    const url = await listen((req, res) => {
      void readBody(req).then((body) => {
        if (body.method === 'initialize') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`event: message\ndata: ${JSON.stringify(INIT_RESULT)}\n\n`);
        } else if (body.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`event: message\ndata: ${JSON.stringify(TOOLS_RESULT)}\n\n`);
        }
      });
    });

    const result = await discoverHttp(url, {}, 8000);
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(2);
  });

  it('reports HTTP auth failures with status', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
    });
    const result = await discoverHttp(url, {}, 8000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });

  it('reports unreachable hosts as errors, not throws', async () => {
    const result = await discoverHttp('http://127.0.0.1:1/mcp/v1', {}, 2000);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
