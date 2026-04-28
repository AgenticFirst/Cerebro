/**
 * ChatActionServer — loopback HTTP bridge between the Cerebro chat
 * subprocess (Claude Code) and the routine ExecutionEngine that owns
 * integration channels (HubSpot, Telegram, WhatsApp, …).
 *
 * The chat subprocess can only reach the main process via shell-out + curl,
 * so we expose three endpoints on 127.0.0.1:<random_port>:
 *
 *   POST /chat-actions/run       run a single chat action behind an approval
 *   GET  /chat-actions/catalog   list runnable actions for the chat catalog
 *                                and the Help modal in the renderer
 *   GET  /chat-actions/health    liveness probe
 *
 * Both endpoints require an `Authorization: Bearer <token>` header. The
 * token is generated per-launch and written to <userData>/.claude/cerebro-runtime.json
 * by the installer so the chat skill (which already reads the runtime file
 * for the backend port) can pick it up.
 *
 * /chat-actions/run is a long-poll: the response only resolves when the
 * underlying engine run reaches a terminal state, which usually means the
 * user has clicked Approve/Deny in the Approvals UI. The chat subprocess
 * holds curl open for the duration.
 */

import http, { type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import type { WebContents } from 'electron';
import type { ExecutionEngine } from '../engine/engine';
import type { DAGDefinition } from '../engine/dag/types';

export interface ChatActionServerDeps {
  engine: ExecutionEngine;
  /** Returns the renderer WebContents the engine should stream events to.
   *  Returns null while the main window is being created — in that case the
   *  request returns 503 so the chat skill can retry. */
  getMainWebContents: () => WebContents | null;
}

export interface ChatActionServerInfo {
  port: number;
  token: string;
}

export class ChatActionServer {
  private deps: ChatActionServerDeps;
  private server: Server | null = null;
  private port = 0;
  private token: string;

  constructor(deps: ChatActionServerDeps) {
    this.deps = deps;
    this.token = crypto.randomBytes(32).toString('hex');
  }

  async start(): Promise<ChatActionServerInfo> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('chat-actions: unexpected server address'));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve({ port: this.port, token: this.token });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  // ── Routing ────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.checkAuth(req)) {
        return this.respondJson(res, 401, { error: 'unauthorized' });
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/chat-actions/health') {
        return this.respondJson(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/chat-actions/catalog') {
        return this.handleCatalog(url, res);
      }

      if (req.method === 'POST' && url.pathname === '/chat-actions/run') {
        return this.handleRun(req, res);
      }

      if (req.method === 'POST' && url.pathname === '/chat-actions/dry-run-routine') {
        return this.handleDryRunRoutine(req, res);
      }

      this.respondJson(res, 404, { error: 'not_found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal_error';
      this.respondJson(res, 500, { error: message });
    }
  }

  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return false;
    const expected = `Bearer ${this.token}`;
    if (header.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  }

  // ── /catalog ──────────────────────────────────────────────────

  private handleCatalog(url: URL, res: ServerResponse): void {
    const langRaw = url.searchParams.get('lang');
    const lang: 'en' | 'es' = langRaw === 'es' ? 'es' : 'en';
    const catalog = this.deps.engine.getChatActionCatalog(lang);
    this.respondJson(res, 200, { lang, actions: catalog });
  }

  // ── /run ──────────────────────────────────────────────────────

  private async handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      return this.respondJson(res, 400, { error: 'body_must_be_json' });
    }
    const type = (body as { type?: unknown }).type;
    const params = (body as { params?: unknown }).params;
    if (typeof type !== 'string' || !type) {
      return this.respondJson(res, 400, { error: 'missing_type' });
    }
    if (params && typeof params !== 'object') {
      return this.respondJson(res, 400, { error: 'params_must_be_object' });
    }
    const conversationIdRaw = (body as { conversation_id?: unknown }).conversation_id;
    const conversationId = typeof conversationIdRaw === 'string' ? conversationIdRaw : undefined;

    const wc = this.deps.getMainWebContents();
    if (!wc) {
      return this.respondJson(res, 503, { error: 'main_window_not_ready' });
    }

    const result = await this.deps.engine.runChatAction(wc, {
      type,
      params: (params as Record<string, unknown> | undefined) ?? {},
      conversationId,
    });

    const httpStatus =
      result.status === 'succeeded' ? 200 :
        result.status === 'unavailable' ? 409 :
          result.status === 'denied' ? 403 :
            result.status === 'cancelled' ? 409 :
              500;
    this.respondJson(res, httpStatus, result);
  }

  // ── /dry-run-routine ──────────────────────────────────────────

  private async handleDryRunRoutine(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') {
      return this.respondJson(res, 400, { error: 'body_must_be_json' });
    }

    const dag = (body as { dag?: unknown }).dag;
    if (!dag || typeof dag !== 'object' || !Array.isArray((dag as { steps?: unknown[] }).steps)) {
      return this.respondJson(res, 400, { error: 'missing_or_invalid_dag' });
    }
    const triggerPayloadRaw = (body as { trigger_payload?: unknown }).trigger_payload;
    const triggerPayload =
      triggerPayloadRaw && typeof triggerPayloadRaw === 'object' && !Array.isArray(triggerPayloadRaw)
        ? (triggerPayloadRaw as Record<string, unknown>)
        : undefined;

    const wc = this.deps.getMainWebContents();
    if (!wc) {
      return this.respondJson(res, 503, { error: 'main_window_not_ready' });
    }

    const result = await this.deps.engine.dryRunRoutine(wc, {
      dag: dag as DAGDefinition,
      triggerPayload,
    });

    // 200 for both pass and fail — the body's `ok` field carries the result.
    // The chat skill needs to see per-step status either way, and a 4xx/5xx
    // would short-circuit curl's body capture in some shells.
    this.respondJson(res, 200, result);
  }

  // ── Helpers ───────────────────────────────────────────────────

  private respondJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload).toString(),
    });
    res.end(payload);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    // Hard cap to avoid runaway POSTs from a misbehaving client.
    if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) {
      throw new Error('payload_too_large');
    }
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid_json');
  }
}
