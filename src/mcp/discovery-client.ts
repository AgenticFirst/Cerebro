/**
 * Minimal MCP client used only to verify a server connection and discover its
 * tool list (`initialize` → `notifications/initialized` → `tools/list`).
 *
 * Deliberately not the full SDK: production tool calls happen inside the
 * Claude Code subprocess via --mcp-config; Cerebro just needs a bounded,
 * kill-safe handshake for the Settings UI ("Test connection") and to cache
 * tool names for agent-file frontmatter.
 */

import { spawn } from 'node:child_process';
import type { DiscoveredTool } from './types';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DiscoveryResult {
  ok: boolean;
  tools: DiscoveredTool[];
  error?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: {
    tools?: Array<{
      name?: string;
      description?: string;
      annotations?: { readOnlyHint?: boolean };
    }>;
  };
  error?: { code?: number; message?: string };
}

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cerebro-discovery', version: '1.0.0' },
    },
  };
}

const INITIALIZED_NOTIFICATION = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
} as const;

function toolsListRequest(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

function parseTools(res: JsonRpcResponse): DiscoveredTool[] {
  return (res.result?.tools ?? [])
    .filter((t) => typeof t.name === 'string' && t.name.length > 0)
    .map((t) => ({
      name: t.name as string,
      description: (t.description ?? '').slice(0, 500),
      readOnly: t.annotations?.readOnlyHint === true,
    }));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── stdio transport ──────────────────────────────────────────────────────────

/**
 * Spawn the server command, run the handshake over newline-delimited
 * JSON-RPC on stdin/stdout, and always kill the child before returning.
 */
export function discoverStdio(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
    } catch (err) {
      resolve({ ok: false, tools: [], error: errMessage(err) });
      return;
    }

    let settled = false;
    let stderrTail = '';
    let buffer = '';

    const finish = (result: DiscoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        tools: [],
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the server${
          stderrTail ? ` — ${stderrTail.slice(-200)}` : ''
        }`,
      });
    }, timeoutMs);

    child.on('error', (err) => {
      finish({ ok: false, tools: [], error: `Failed to start: ${errMessage(err)}` });
    });
    child.on('exit', (code) => {
      finish({
        ok: false,
        tools: [],
        error: `Server exited (code ${code ?? 'unknown'}) before responding${
          stderrTail ? ` — ${stderrTail.slice(-200)}` : ''
        }`,
      });
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-1000);
    });

    const send = (msg: unknown) => {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue; // servers may log non-JSON lines to stdout; skip them
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish({ ok: false, tools: [], error: `initialize failed: ${msg.error.message}` });
            return;
          }
          send(INITIALIZED_NOTIFICATION);
          send(toolsListRequest(2));
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({ ok: false, tools: [], error: `tools/list failed: ${msg.error.message}` });
            return;
          }
          finish({ ok: true, tools: parseTools(msg) });
          return;
        }
      }
    });

    send(initializeRequest(1));
  });
}

// ── streamable HTTP transport ────────────────────────────────────────────────

/** Extract the first JSON-RPC message from a plain-JSON or SSE response body. */
function parseHttpBody(contentType: string, text: string): JsonRpcResponse | null {
  if (contentType.includes('text/event-stream')) {
    for (const rawEvent of text.split('\n\n')) {
      const data = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as JsonRpcResponse;
        if (msg.id !== undefined || msg.error) return msg;
      } catch {
        continue;
      }
    }
    return null;
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return null;
  }
}

/**
 * Run the handshake against a streamable-HTTP MCP endpoint. Honors the
 * `Mcp-Session-Id` header a server may issue on initialize.
 */
export async function discoverHttp(
  url: string,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DiscoveryResult> {
  const deadline = Date.now() + timeoutMs;
  let sessionId: string | null = null;

  const post = async (body: unknown): Promise<Response> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timed out');
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(remaining),
    });
  };

  try {
    const initRes = await post(initializeRequest(1));
    if (!initRes.ok) {
      const text = await initRes.text().catch(() => '');
      return {
        ok: false,
        tools: [],
        error: `initialize HTTP ${initRes.status}: ${text.slice(0, 200)}`,
      };
    }
    sessionId = initRes.headers.get('mcp-session-id');
    const initMsg = parseHttpBody(initRes.headers.get('content-type') ?? '', await initRes.text());
    if (!initMsg || initMsg.error) {
      return {
        ok: false,
        tools: [],
        error: `initialize failed: ${initMsg?.error?.message ?? 'unparseable response'}`,
      };
    }

    // Notification: servers reply 202/204 with no body; failures are non-fatal.
    await post(INITIALIZED_NOTIFICATION).catch(() => undefined);

    const listRes = await post(toolsListRequest(2));
    if (!listRes.ok) {
      const text = await listRes.text().catch(() => '');
      return {
        ok: false,
        tools: [],
        error: `tools/list HTTP ${listRes.status}: ${text.slice(0, 200)}`,
      };
    }
    const listMsg = parseHttpBody(listRes.headers.get('content-type') ?? '', await listRes.text());
    if (!listMsg || listMsg.error) {
      return {
        ok: false,
        tools: [],
        error: `tools/list failed: ${listMsg?.error?.message ?? 'unparseable response'}`,
      };
    }
    return { ok: true, tools: parseTools(listMsg) };
  } catch (err) {
    const msg = errMessage(err);
    return {
      ok: false,
      tools: [],
      error: msg.includes('abort') || msg.includes('Timed out') ? 'Connection timed out' : msg,
    };
  }
}
